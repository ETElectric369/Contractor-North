"use server";
import { readUsualBillingKind } from "@/lib/schedule-options";
import { dbError } from "@/lib/db-error";
import { appointmentTypeFor, bookingTitle, daysNeeded, workingDaysFrom, workKind } from "@/lib/schedule/work-shape";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { mergeCaptureSections, parseInspectorCapture, type CapturePatch } from "@/lib/inspection/capture";
import { isMissingRpc, keepStoredPhotos, readViaView } from "@/lib/inspection/inspection-access";
import { inspectionDbWords } from "@/lib/inspection/db-refusal";
import { formatFullAddress, formatPhone } from "@/lib/utils";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { emptyToNull } from "@/lib/forms";
import { pushCalendarItem, deleteCalendarItem } from "@/lib/calendar-sync";
import { requireMember, requireStaff } from "@/lib/staff-guard";
import { notifyPeople } from "@/lib/notifications";
import { getOrgSettings } from "@/lib/org-settings";
import { tzDateTimeUtc, todayStrInTz } from "@/lib/tz";
import { WORK_DAY_MINUTES } from "@/lib/schedule/work-shape";
import { jobNameFrom, jobWho, visitStreetOf } from "@/lib/job-name";
import { createProposalCore, cleanSlots } from "@/lib/appointments/proposal";
import { endAfterStart, keptEnd } from "@/lib/appointments/times";
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES, INSPECTION_TYPES, isPickableAppointmentType } from "@/lib/statuses";
import { briefNote, carriedNote, carryForInquiry } from "@/lib/inquiries/carry-intake-answers";
import { coerceByPlaybook, orphanedAnswers, retiredAnswers, retiredOptions } from "@/lib/playbook/answers";
import { playbookForForm } from "@/lib/playbook/parse";
import { clearInapplicable } from "@/lib/playbook/resolve";
import { runOnce } from "@/lib/offline/run-once";
import { customerForInquiry } from "@/lib/actions/win-customer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_JOB_MINUTES } from "@/lib/schedule/job-block";
import { putBackPlan, wontHappenVerdict } from "@/lib/appointments/wont-happen";

/** The browser-computed ISO if present; otherwise build the instant in the ORG
 *  timezone — NEVER the server's UTC (the bare-string parse stored the wrong
 *  hour when starts_at_iso was missing). */
async function resolveIso(
  supabase: SupabaseClient,
  browserIso: string | null,
  date: string,
  time: string,
): Promise<string | null> {
  if (browserIso) return browserIso;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((data as any)?.settings).timezone;
  return tzDateTimeUtc(date, time || "08:00", tz);
}

/** `refused`: the database said no to WHO is asking, so trying again won't change it (the
 *  inspection's autosave stops retrying and says so instead). */
export type Result = { ok: boolean; error?: string; id?: string; refused?: boolean };

/** The one refusal for a kind nobody can pick (W2-06), in the picker's own words. (Not exported: a
 *  "use server" file exports only async functions.) */
const PICK_A_KIND = "Pick a kind: Inspection, Job, Service Call, Phone Call or Other.";

/**
 * THE KIND A NEW OR EDITED VISIT MAY CARRY (W2-06). Create and Propose Times take one of the five a
 * person can pick (PICKABLE_APPOINTMENT_TYPES); an edit takes one of those, or the row's OWN stored
 * kind unchanged (a Client Meeting whose time is moved stays a Client Meeting, never refused and
 * never silently rewritten). Anything else is refused in the picker's words, never Postgres'. A form
 * that sends no kind gets the fallback: Other for a new visit, the row's own kind for an edit.
 */
function resolveType(
  formData: FormData,
  fallback: string,
  own?: string | null,
): { type?: string; error?: string } {
  const sent = String(formData.get("type") ?? "").trim();
  const type = sent || own || fallback;
  if (isPickableAppointmentType(type)) return { type };
  if (own && type === own && (APPOINTMENT_TYPES as readonly string[]).includes(type)) return { type };
  return { error: PICK_A_KIND };
}


/** Resolve the customer for an appointment form: an existing id, or create a new
 *  customer on the fly from a typed name (the "+ New customer" path). Surfaces
 *  errors instead of silently saving an appointment with no customer. */
async function resolveCustomer(
  supabase: any,
  formData: FormData,
  userId: string,
): Promise<{ customerId: string | null; error?: string }> {
  const customerId = emptyToNull(formData.get("customer_id"));
  const newName = emptyToNull(formData.get("new_customer_name"));
  if (customerId === "__new__" || (!customerId && newName)) {
    if (!newName) return { customerId: null, error: "Enter a name for the new customer." };
    const { data: c, error } = await supabase
      .from("customers")
      .insert({ name: newName, phone: formatPhone(String(formData.get("new_customer_phone") ?? "")) || null, created_by: userId })
      .select("id")
      .single();
    if (error || !c) return { customerId: null, error: error?.message ?? "Could not create the new customer." };
    return { customerId: c.id };
  }
  return { customerId };
}

/** Combine a date + time input into an ISO timestamp at local time. */

export async function createAppointment(formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };

  // Prefer the ISO the browser computed in the user's own timezone; the fallback
  // builds the instant in the ORG timezone (never the server's UTC).
  const apptDate = String(formData.get("date") ?? "");
  const startIso = await resolveIso(supabase, emptyToNull(formData.get("starts_at_iso")), apptDate, String(formData.get("start_time") ?? ""));
  if (!startIso) return { ok: false, error: "Pick a date." };
  const endTime = String(formData.get("end_time") ?? "");
  const endIso =
    emptyToNull(formData.get("ends_at_iso")) ??
    (endTime ? await resolveIso(supabase, null, apptDate, endTime) : null);
  const endErr = endAfterStart(startIso, endIso);
  if (endErr) return { ok: false, error: endErr };

  const cust = await resolveCustomer(supabase, formData, ctx.userId);
  if (cust.error) return { ok: false, error: cust.error };
  const customerId = cust.customerId;

  // No kind sent is Other (W2-06): today's plain "appointment", with no write-up nag after it.
  const typed = resolveType(formData, "other");
  if (typed.error) return { ok: false, error: typed.error };

  const { data, error } = await supabase
    .from("appointments")
    .insert({
      type: typed.type,
      title,
      starts_at: startIso,
      ends_at: endIso,
      job_id: emptyToNull(formData.get("job_id")),
      customer_id: customerId,
      location: emptyToNull(formData.get("location")),
      notes: emptyToNull(formData.get("notes")),
      assigned_to: emptyToNull(formData.get("assigned_to")),
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  // Live Google push (fire-safe: never throws, no-op when not connected).
  await pushCalendarItem("appointment", data.id);

  const assignedTo = emptyToNull(formData.get("assigned_to"));
  if (assignedTo && assignedTo !== ctx.userId) {
    // On the bell too (notifyPeople): the line says what the push says, to the one person it was for.
    // After the response (it was fire-and-forget before), but kept alive until it lands.
    const orgId = ctx.orgId;
    after(() => notifyPeople(orgId, [assignedTo], "assigned", {
      title: "New appointment assigned",
      body: title,
      // Deep-link the appointment's DAY so staff land where its edit/quick actions
      // live, not the generic week (audit cn-v328). apptDate is the org-local day the
      // user picked; a tech recipient is still bounced to /planner by the office-only
      // gate on /schedule — that's a separate, pre-existing constraint.
      url: apptDate ? `/schedule?view=day&date=${apptDate}` : "/schedule",
    }));
  }

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true, id: data.id };
}

/** "Start An Inspection" (it was "Inspect now") — the already-onsite path (Erik: "sometimes we're
 *  onsite already — too many steps today"). Creates a type='inspection' appointment starting NOW (status
 *  'scheduled'; filling in the capture is what makes it *done*), linked to the lead when
 *  launched from one, so the caller can route STRAIGHT to /appointments/<id> and start
 *  collecting field data. One tap from lead → capturing. */
export async function createInspectionNow(
  opts: { inquiryId?: string | null } = {},
): Promise<Result> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Lead context (optional): inherit name/address/notes and keep the provenance backlink.
  // RLS scopes the read — a cross-org id reads as "not found", never a silent unlinked row.
  type LeadCtx = {
    id: string;
    name: string;
    address: string | null;
    // BREAK 1 in the audit's address spine: this used to fetch the street line ALONE and write it
    // into `location`, so a Places-resolved four-column address became one string — and the city,
    // state and zip were not merely flattened, they were never even read. 0177 gave appointments
    // those same four columns, so the whole address carries through now.
    city: string | null;
    state: string | null;
    zip: string | null;
    message: string | null;
    notes: string | null;
    customer_id: string | null;
    intake?: { intake_answers?: unknown } | null;
  };
  let inq: LeadCtx | null = null;
  if (opts.inquiryId) {
    const { data } = await supabase
      .from("inquiries")
      // work_kind rides along (PROJECTION LAW): the tag the office picked on the lead must reach
      // the insert below, or this door quietly refiles a service call as an inspection.
      .select("id, name, address, city, state, zip, message, notes, customer_id, intake, work_kind")
      .eq("id", opts.inquiryId)
      .maybeSingle();
    if (!data) return { ok: false, error: "Lead not found." };
    inq = data as LeadCtx;
  }

  // THE SAME SEED AS THE BOOKED PATHS. This one-tap door used to copy only message/notes, so an
  // inspection started from the lead row opened BLANK while a scheduled one opened pre-filled —
  // the customer's intake answers and the plan brief both carry here now, person over machine,
  // each named in the notes (Erik: "open the inspector right there with the data all filled in").
  const carry = inq
    ? await carryForInquiry(supabase, inq)
    : { inspectionTemplateId: null, inspectionAnswers: {}, carried: [], briefCarried: [] };

  const { data: appt, error } = await supabase
    .from("appointments")
    .insert({
      /* WHAT HE TOLD THE APP BEATS THE BUTTON'S NAME. Erik tagged Nora 'service' on the lead,
         tapped the row's one-tap door, and got "Site inspection" — the third booking door off one
         lead, and the only one still discarding the declared kind. All three obey it now. */
      type: appointmentTypeFor((inq as { work_kind?: string | null } | null)?.work_kind),
      // The stock title of an inspection with no lead is the site visit's one word (lib/statuses); the
      // STOCK lists below rename it once an address or a customer arrives.
      title: inq
        ? bookingTitle(workKind({ kind: "lead", workKind: (inq as { work_kind?: string | null }).work_kind }), inq.name)
        : "Inspection",
      starts_at: new Date().toISOString(), // now — an instant is an instant in any tz
      status: "scheduled", // NOT completed: the capture (or "Mark Inspection Done") finishes it
      // The WHOLE address, not just the street line — and the parts alongside it, so nothing
      // downstream has to re-parse a string to learn which city the work is in.
      location: formatFullAddress(inq?.address ?? null, inq?.city ?? null, inq?.state ?? null, inq?.zip ?? null) || inq?.address || null,
      city: inq?.city ?? null,
      state: inq?.state ?? null,
      zip: inq?.zip ?? null,
      notes:
        [inq?.message ?? inq?.notes ?? null, carriedNote(carry.carried), briefNote(carry.briefCarried)]
          .filter(Boolean)
          .join("\n\n") || null,
      inspection_template_id: carry.inspectionTemplateId,
      inspection_answers: carry.inspectionAnswers,
      customer_id: inq?.customer_id ?? null, // deferred-customer doctrine: no contact row before the win
      inquiry_id: inq?.id ?? null,
      assigned_to: ctx.userId, // whoever tapped is the one standing onsite
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  await pushCalendarItem("appointment", appt.id); // live Google push (fire-safe)

  // Same engaged-not-closed stamp as the booked-inspection path: the lead stays OPEN
  // (converted_at untouched) and resurfaces today for the write-up.
  if (inq) {
    const tz = await (async () => {
      const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
      return getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone;
    })();
    await supabase
      .from("inquiries")
      .update({
        status: "contacted",
        last_contacted_at: new Date().toISOString(),
        next_follow_up_at: todayStrInTz(tz),
        updated_at: new Date().toISOString(),
      })
      .eq("id", inq.id);
    revalidatePath("/leads");
  }

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections");
  return { ok: true, id: appt.id };
}

/**
 * THE LEAD'S ONE DOOR INTO ITS INSPECTION (Erik: "a preliminary inspection report button on
 * the lead page itself so i can open the inspector right there with the data all filled in").
 * Opens the lead's EXISTING inspection when one is live — a second tap must never mint a second
 * inspection — and otherwise starts one now through createInspectionNow, which seeds the
 * intake answers and the plan brief.
 */
export async function openLeadInspection(inquiryId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: existing } = await ctx.supabase
    .from("appointments")
    .select("id")
    .eq("inquiry_id", inquiryId)
    .in("type", [...INSPECTION_TYPES])
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, id: (existing as { id: string }).id };
  return createInspectionNow({ inquiryId });
}

/** Create a TENTATIVE appointment + a customer pick-a-time link (up to 3 date+
 *  time options). The appointment shows as "proposed" until they tap a slot. */
export async function createAppointmentProposal(
  formData: FormData,
): Promise<{ ok: boolean; error?: string; token?: string }> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };

  let slotsRaw: unknown = [];
  try {
    slotsRaw = JSON.parse(String(formData.get("slots_json") ?? "[]"));
  } catch {
    /* ignore */
  }
  const slots = cleanSlots(slotsRaw);
  if (!slots.length) return { ok: false, error: "Add at least one date option." };

  const cust = await resolveCustomer(supabase, formData, ctx.userId);
  if (cust.error) return { ok: false, error: cust.error };

  // Offering a customer times is how an inspection gets booked, so that is the kind when none is
  // sent (it was 'quote', a kind nobody picks any more: W2-06).
  const typed = resolveType(formData, "inspection");
  if (typed.error) return { ok: false, error: typed.error };

  // First slot is the tentative time (browser-computed ISO honors the user's tz).
  const startIso = await resolveIso(supabase, emptyToNull(formData.get("starts_at_iso")), slots[0].date, slots[0].time);

  // The shared core does the rest (dedup-withdraw of a pending prior link,
  // tentative appointment, proposal row) — same writer as the lead "Let them pick"
  // path. (The public path stopped writing proposals in cn-v499 — it now only
  // flags site_inspection_required and pings the office.)
  const res = await createProposalCore(supabase, {
    type: typed.type!,
    title,
    slots,
    jobId: emptyToNull(formData.get("job_id")),
    customerId: cust.customerId,
    location: emptyToNull(formData.get("location")),
    notes: emptyToNull(formData.get("notes")),
    assignedTo: emptyToNull(formData.get("assigned_to")),
    createdBy: ctx.userId,
    startsAtIso: startIso,
  });
  if (!res.ok) return { ok: false, error: res.error };

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true, token: res.token };
}

/** The on-site inspection field capture (notes / measurements / materials +
 *  photo storage paths) saved onto appointments.capture — read back by the
 *  capture page and by /quotes/new?capture= to prefill the estimator scope.
 *  Photos are PATHS in the private documents bucket (org-scoped, signed URLs
 *  on read), never raw URLs, so nothing here is publicly addressable. */
export interface AppointmentCapture {
  notes?: string;
  measurements?: string;
  materials?: string;
  photos?: string[];
}

/** One thing a visit can be FOR. A lead, a customer and a job are three tables and one idea. */
export type LinkTarget = {
  kind: "lead" | "customer" | "job";
  id: string;
  name: string;
  address: string | null;
  /** A quiet second line — status, job number, phone. */
  sub: string | null;
};

/**
 * WHAT IS THIS VISIT FOR — one search across three tables.
 *
 * Erik: "if there is a lead to pick or match to the inspection then yes it should fill whatever
 * data it has naturally, if i start an inspection yes i should be able to connect it to something
 * that exists, fragment first, simplicity rules."
 *
 * ONE control, not three. Three pickers labelled Lead / Customer / Job would make the person
 * classify the thing before they can find it — and at a job the honest answer is usually "it's the
 * Dale place", not "it is an inquiry record". So: type a name or an address, get everything that
 * matches, pick it, done. The KIND is an outcome of the pick, not a question asked first.
 *
 * This is also the fix for the real cause of orphaned inspections: only 2 of 7 doors that create
 * one can set `inquiry_id` at all, so 10 of 13 in production link to nothing and nothing
 * downstream can inherit anything.
 */
export async function searchLinkTargets(q: string): Promise<LinkTarget[]> {
  const ctx = await requireStaff();
  if ("error" in ctx) return [];
  const supabase = ctx.supabase;
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;

  // RLS scopes all three to the caller's org.
  const [leads, customers, jobs] = await Promise.all([
    supabase
      .from("inquiries")
      .select("id, name, address, city, state, zip, status, converted_at")
      .or(`name.ilike.${like},address.ilike.${like}`)
      .is("converted_at", null)
      .limit(6),
    supabase
      .from("customers")
      .select("id, name, address, city, state, zip, phone")
      .or(`name.ilike.${like},address.ilike.${like}`)
      .limit(6),
    supabase
      .from("jobs")
      .select("id, job_number, name, address, city, state, zip, status")
      .or(`name.ilike.${like},address.ilike.${like}`)
      .in("status", ACTIVE_JOB_STATUSES)
      .limit(6),
  ]);

  const full = (r: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }) =>
    formatFullAddress(r.address ?? null, r.city ?? null, r.state ?? null, r.zip ?? null) || null;

  return [
    // Leads first: an open lead is the freshest context and the one most likely to be the reason
    // somebody is standing at the address right now.
    ...(leads.data ?? []).map((r: any) => ({
      kind: "lead" as const, id: r.id, name: r.name, address: full(r), sub: `Lead · ${r.status}`,
    })),
    ...(customers.data ?? []).map((r: any) => ({
      kind: "customer" as const, id: r.id, name: r.name, address: full(r), sub: r.phone ? `Customer · ${r.phone}` : "Customer",
    })),
    ...(jobs.data ?? []).map((r: any) => ({
      kind: "job" as const, id: r.id, name: r.name ?? r.job_number, address: full(r), sub: `Job · ${r.job_number}`,
    })),
  ];
}

/**
 * Link a visit to what it's for, and INHERIT WHAT THAT THING ALREADY KNOWS.
 *
 * "it should fill whatever data it has naturally." Address fills only when the visit has none —
 * a value typed on site is the one somebody is standing in front of, and must never be overwritten
 * by a record's older idea of where the work is.
 *
 * Linking a lead also carries its customer when it has one, so the chain doesn't break at the
 * first hop.
 */
export async function linkAppointmentTo(
  id: string,
  kind: "lead" | "customer" | "job",
  targetId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: appt } = await supabase
    .from("appointments")
    // type rides along (PROJECTION LAW): the new title follows the visit's kind, never a guess.
    .select("id, title, location, type")
    .eq("id", id)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };

  const patch: Record<string, unknown> = {};
  let name = "";
  let address: string | null = null;
  // The structured parts of whatever we linked to — carried through so the visit inherits a
  // real address rather than a string somebody has to re-parse later (0177).
  let parts: { city: string | null; state: string | null; zip: string | null } | null = null;

  if (kind === "lead") {
    const { data: r } = await supabase
      .from("inquiries")
      .select("id, name, address, city, state, zip, customer_id")
      .eq("id", targetId)
      .maybeSingle();
    if (!r) return { ok: false, error: "Lead not found." };
    patch.inquiry_id = r.id;
    if (r.customer_id) patch.customer_id = r.customer_id;
    name = r.name;
    address = formatFullAddress(r.address, r.city, r.state, r.zip) || null;
    parts = { city: r.city ?? null, state: r.state ?? null, zip: r.zip ?? null };
  } else if (kind === "customer") {
    const { data: r } = await supabase
      .from("customers")
      .select("id, name, address, city, state, zip")
      .eq("id", targetId)
      .maybeSingle();
    if (!r) return { ok: false, error: "Customer not found." };
    patch.customer_id = r.id;
    name = r.name;
    address = formatFullAddress(r.address, r.city, r.state, r.zip) || null;
    // KEEPING WHAT WE ALREADY FETCHED. This branch and the job branch below both selected
    // city/state/zip, spent them on a display string, and dropped them — so `if (parts)` at the
    // bottom was dead for two of the three link kinds. That is the whole reason 19 of Erik's 19
    // appointments have a location and none has a city. Not a guess: the columns are right here.
    parts = { city: r.city ?? null, state: r.state ?? null, zip: r.zip ?? null };
  } else {
    const { data: r } = await supabase
      .from("jobs")
      .select("id, job_number, name, address, city, state, zip, customer_id")
      .eq("id", targetId)
      .maybeSingle();
    if (!r) return { ok: false, error: "Job not found." };
    patch.job_id = r.id;
    if (r.customer_id) patch.customer_id = r.customer_id;
    name = r.name ?? r.job_number;
    address = formatFullAddress(r.address, r.city, r.state, r.zip) || null;
    parts = { city: r.city ?? null, state: r.state ?? null, zip: r.zip ?? null };
  }

  // FILL, NEVER OVERWRITE — the same law the inspector's Nort channel obeys.
  if (address && !String(appt.location ?? "").trim()) {
    patch.location = address;
    if (parts) Object.assign(patch, parts);
  }
  // The stock titles the create paths hand out, old spellings and new (including the three days it
  // was "Walk-Through": cn-v1034, 2026-09-30, to 2026-10-03), so an old stock title still gets
  // renamed. The new title follows the visit's kind (bookingTitle): an inspection reads
  // "Inspection: <name>"; a job, an Other visit, just the name. WHOLE-STRING on purpose: a stored
  // "Walk-Through: Tom Goodman" already carries somebody's name, so it is not ours to replace with
  // a different one — it is re-said where it is READ instead (lib/statuses visitTitle).
  const STOCK = ["site inspection", "inspection", "final inspection", "appointment", "walk-through", ""];
  if (name && STOCK.includes(String(appt.title ?? "").trim().toLowerCase())) {
    patch.title = bookingTitle(workKind({ kind: "appointment", type: (appt as { type?: string | null }).type ?? null }), name);
  }

  const { data: linked, error } = await supabase
    .from("appointments")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!linked?.length) return { ok: false, error: "That appointment could not be found." };

  revalidatePath("/schedule");
  revalidatePath("/planner");
  revalidatePath("/inspections");
  revalidatePath("/leads");
  revalidatePath(`/appointments/${id}`);
  return { ok: true, id };
}

/**
 * WHERE THE VISIT IS — settable from the inspector itself.
 *
 * "nothing collected the pertinent initial data like address which names the everything from lead
 * to invoice, i dont want to have to be digging around to enter the most simple and pertinent
 * data." The capture surface had no address control anywhere in it, and the only way to set one
 * was the Edit Details modal. So in 4 of 13 production inspections the address was typed into the
 * TITLE instead — and then typed again, differently, into Location.
 *
 * Also retitles a record still carrying the stock "Site inspection", because a list of six rows
 * all reading "Site inspection" is a list of nothing. Only the stock title is replaced: anything a
 * person named themselves is theirs.
 */
export async function setAppointmentPlace(
  id: string,
  location: string,
  /** The resolved parts, when the address came from autocomplete rather than the keyboard.
   *  Absent for typed input — and absent is honest: guessing a city from a typed line is how
   *  a wrong address gets onto a record, and a wrong one is worse than a blank one (0177). */
  parts?: { city?: string | null; state?: string | null; zip?: string | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const clean = location.trim().slice(0, 500);
  const { data: existing } = await supabase
    .from("appointments")
    .select("title, type")
    .eq("id", id)
    .maybeSingle();

  // The stock titles the create paths hand out, old spellings and new (including the three days it
  // was "Walk-Through": cn-v1034, 2026-09-30, to 2026-10-03). A title a human chose is never touched,
  // and a stored "Walk-Through: <who>" counts as chosen — it is re-said on read (statuses visitTitle).
  const STOCK = ["site inspection", "inspection", "final inspection", "appointment", "walk-through", ""];
  const isStock = STOCK.includes(String(existing?.title ?? "").trim().toLowerCase());

  const { data, error } = await supabase
    .from("appointments")
    .update({
      location: clean || null,
      // Only written when they were actually RESOLVED. A typed address leaves them alone
      // rather than stamping a guess over a previously-resolved city.
      ...(parts?.city !== undefined ? { city: parts.city || null } : {}),
      ...(parts?.state !== undefined ? { state: parts.state || null } : {}),
      ...(parts?.zip !== undefined ? { zip: parts.zip || null } : {}),
      ...(clean && isStock ? { title: clean } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, title");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Appointment not found." };
  revalidatePath("/schedule");
  revalidatePath("/planner");
  revalidatePath("/inspections");
  revalidatePath(`/appointments/${id}`);
  return { ok: true, id };
}

/**
 * THE ONE WRITER for an inspection's field capture.
 *
 * Takes a PATCH — only the sections that changed — and merges. Never a full snapshot, for two
 * reasons that have both actually bitten this app:
 *
 *  1. THE ROLLOUT WINDOW. This runs as a home-screen PWA whose bundle can be hours stale. The
 *     previous version of this function rebuilt the stored object from a fixed four-key whitelist,
 *     so any key it didn't know about was destroyed. The moment `items` and `measures` exist, a
 *     save from one cached tab would silently delete a materials list somebody typed. A patch
 *     cannot express "delete the sections I didn't mention", which is exactly the property needed.
 *  2. OFFLINE REPLAY. An op queued in a crawlspace and replayed two hours later must not resurrect
 *     stale notes just because it carried a materials change.
 *
 * `quote_id` is rescued unconditionally: it is stamped by a DIFFERENT writer (saveQuote), so any
 * writer that rebuilds without it silently un-files a written-up inspection off /inspections and
 * off the My Day money item.
 */
export async function saveInspectionCapture(
  id: string,
  patch: CapturePatch,
): Promise<Result> {
  // Decided (Erik, 2026-09-26: "crew leader yes tech no"): the office saves here, unchanged; a crew
  // lead ON this visit saves through save_walkthrough_capture (0356); a plain tech reads.
  const ctx = await requireStaff(); // defense-in-depth (RLS also scopes the write)
  if ("error" in ctx) {
    if (ctx.error === STAFF_ONLY) return saveCaptureAsCrewLead(id, patch);
    return { ok: false, error: ctx.error };
  }
  const supabase = ctx.supabase;

  const { data: existing } = await supabase.from("appointments").select("capture").eq("id", id).maybeSingle();
  // mergeCaptureSections re-parses, so clamping, the never-a-silent-zero quantity law, orphan
  // photo_meta dropping and flag-stripping all apply to whatever the client sent.
  const merged = mergeCaptureSections(existing?.capture ?? null, patch);

  const { data, error } = await supabase
    .from("appointments")
    .update({ capture: merged, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Appointment not found." };
  revalidatePath("/schedule");
  revalidatePath("/planner");
  revalidatePath("/inspections");
  revalidatePath(`/appointments/${id}`);
  return { ok: true, id };
}

/**
 * THE PHOTOS JUST TAKEN, APPENDED to what is stored: the crew lead's upload (0356).
 *
 * His page sends only the paths he just took, never its whole list. A whole list is the page's list
 * from when it opened, so a photo the office took off in the meantime would ride back in on his next
 * upload (the stored list merged with a stale one is the stale one). Appended here, the office's
 * removal stands; and the database refuses any new photo that isn't a file he uploaded himself.
 * Someone who is office staff by the time this runs gets the same append through the office's save.
 */
export async function addInspectionPhotos(id: string, paths: string[]): Promise<Result> {
  const add = (Array.isArray(paths) ? paths : []).filter((p): p is string => typeof p === "string" && p.trim() !== "");
  if (!add.length) return { ok: true, id };
  const ctx = await requireStaff();
  if ("error" in ctx) {
    if (ctx.error === STAFF_ONLY) return saveCaptureAsCrewLead(id, { photos: add });
    return { ok: false, error: ctx.error };
  }
  const { data: existing } = await ctx.supabase.from("appointments").select("capture").eq("id", id).maybeSingle();
  return saveInspectionCapture(id, { photos: keepStoredPhotos(parseInspectorCapture(existing?.capture ?? null).photos, add) });
}

/**
 * THE OFFICE TAKES ONE PHOTO OFF THE INSPECTION, AND ITS FILE WITH IT (0356).
 *
 * "Taking one off is the office's, and so it STAYS off": 0356 refuses a crew lead's new photo unless
 * its file is one he uploaded himself. A photo HE took and the office took off still had its file in
 * the visit's folder with his name on it, so a crafted call could put it straight back. Removing the
 * file closes that: there is nothing left for his save to point at.
 *
 * ONE PATH, NAMED, never the page's whole list. A list is the page's list from when it opened, so a
 * photo the crew lead added since would be dropped by it, and deleting what a stale list dropped
 * would destroy a photo nobody in the office ever saw. Only the file the office pressed Remove on
 * goes, and only when it was on the stored list and sits in this visit's own folder.
 */
export async function removeInspectionPhoto(id: string, path: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) {
    if (ctx.error === STAFF_ONLY) return { ok: false, refused: true, error: "Only the office can take a photo off the inspection." };
    return { ok: false, error: ctx.error };
  }
  const { data: existing } = await ctx.supabase.from("appointments").select("capture").eq("id", id).maybeSingle();
  if (!existing) return { ok: false, error: "Appointment not found." };
  const stored = parseInspectorCapture(existing.capture ?? null).photos;
  const res = await saveInspectionCapture(id, { photos: stored.filter((p) => p !== path) });
  if (!res.ok) return res;
  const ownFolder = `${ctx.orgId}/appointments/${id}/`;
  if (ctx.orgId && stored.includes(path) && path.startsWith(ownFolder) && !path.includes("..")) {
    // Best effort: the photo is already off the list, which is what was asked. A file that stays
    // (a storage hiccup) only means a crafted call could still name it, as before this.
    await ctx.supabase.storage.from("documents").remove([path]).then(() => undefined, () => undefined);
  }
  return res;
}

/**
 * The legacy four-key entry point, kept as a THIN MERGING WRAPPER.
 *
 * A cached bundle keeps calling this for hours after any deploy, and an op queued offline before
 * the deploy replays into it. It must land on the merging writer, never on the old whitelist —
 * that is the whole rollout guard, and it is why this shipped in the same commit that deleted the
 * component which used to call it.
 */
export async function saveAppointmentCapture(
  id: string,
  capture: AppointmentCapture,
): Promise<Result> {
  return saveInspectionCapture(id, {
    notes: String(capture?.notes ?? "").trim(),
    measurements: String(capture?.measurements ?? "").trim(),
    materials: String(capture?.materials ?? "").trim(),
    photos: Array.isArray(capture?.photos) ? capture.photos : [],
  });
}

/**
 * SAVE THE TYPED INSPECTION SHEET (0165). Answers are stored beside the prose capture, never
 * inside it — a typed answer buried in a free-text bag stops being typed.
 *
 * Every value is coerced against the template's OWN schema, which is re-read from the database
 * rather than trusted from the client. That closes both halves of the hole: a number field can
 * only hold a number (or null — never a silent 0), and a key the template doesn't declare is
 * dropped instead of being written as arbitrary jsonb onto the appointment row.
 */
export async function saveInspectionAnswers(
  id: string,
  templateId: string | null,
  answers: Record<string, unknown>,
  /** Offline-queue idempotency key (0167). Absent on the normal online path. */
  clientOpId?: string,
): Promise<Result> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also scopes the write)
  if ("error" in ctx) {
    if (ctx.error === STAFF_ONLY) return saveAnswersAsCrewLead(id, templateId, answers, clientOpId);
    return { ok: false, error: ctx.error };
  }
  const supabase = ctx.supabase;
  const { data: { user } } = await supabase.auth.getUser();
  const { data: prof } = user
    ? await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle()
    : { data: null };
  return runOnce(
    { clientOpId, action: "inspection.answers", orgId: (prof as { org_id?: string } | null)?.org_id, profileId: user?.id },
    () => saveInspectionAnswersInner(supabase, id, templateId, answers),
  );
}

async function saveInspectionAnswersInner(
  supabase: SupabaseClient,
  id: string,
  templateId: string | null,
  answers: Record<string, unknown>,
): Promise<Result> {
  const c = await cleanInspectionAnswers(supabase, id, templateId, answers);
  if (!c.ok) return c;
  const { data, error } = await supabase
    .from("appointments")
    .update({
      inspection_template_id: templateId,
      inspection_answers: c.clean,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Appointment not found." };
  revalidatePath(`/appointments/${id}`);
  revalidatePath("/inspections");
  return { ok: true, id };
}

/** What gets STORED for these answers: coerced against the sheet's own playbook (re-read from the
 *  database, never trusted from the client), cleared of inapplicable branches, and carrying forward
 *  what was answered under questions since retired. The office's write and the crew lead's share it,
 *  so the two can never store a different truth for the same taps. */
async function cleanInspectionAnswers(
  supabase: SupabaseClient,
  id: string,
  templateId: string | null,
  answers: Record<string, unknown>,
): Promise<{ ok: true; clean: Record<string, unknown> } | { ok: false; error: string }> {
  let clean: Record<string, unknown> = {};
  if (templateId) {
    // RLS confines this read to the caller's org, so a template id from another tenant simply
    // doesn't resolve — the schema we validate against is always one this org owns. Through
    // form_playbooks (0366): a crew lead may no longer read a playbook sheet from forms itself, and
    // the view hands him its questions without the owner's notes or dollar figures, which the
    // coercion never needed. A failed read is said, never "no sheet".
    const { data: form, error: formErr } = await readViaView<{ schema?: unknown; is_inspection?: boolean; playbook?: unknown }>(
      supabase,
      "sheets",
      (from) => from.select("schema, is_inspection, playbook").eq("id", templateId).maybeSingle(),
    );
    if (formErr) return { ok: false, error: dbError(formErr) };
    if (!form) return { ok: false, error: "That inspection sheet no longer exists." };
    if (!(form as { is_inspection?: boolean }).is_inspection)
      return { ok: false, error: "That form isn't an inspection sheet." };
    // Coerce, THEN drop anything the rules make inapplicable. Both halves matter and for different
    // reasons: coerce is the type contract, clearing is the truth contract. The client already
    // clears on change, but this row is writable through RLS directly — a payload could set
    // panel_brand on a lighting job and the estimator would read it as a fact. Enforce it where
    // the write lands, not only where the form is.
    //
    // THROUGH THE PLAYBOOK (cn-v628), which is what the inspector renders from. Coercing against
    // the raw sheet here would split the truth exactly where it hurts: a sheet checkbox is a
    // two-option select in the playbook, so the answer on the wire is "Yes" or "No" — and "No" fed
    // back through the sheet's checkbox branch is a non-empty string, i.e. `true`. A job with no
    // permit, stored as permitted. One renderer, one coercer.
    const pb = playbookForForm(form as { schema?: unknown; playbook?: unknown });
    clean = clearInapplicable(pb, coerceByPlaybook(pb, answers));
    // CHANGING YOUR QUESTIONS MUST NOT DELETE FINISHED SITE VISITS. Anything answered under a
    // question the playbook no longer declares is carried forward FROM THE STORED ROW — see
    // retiredAnswers for why reading it from the row rather than the payload keeps the
    // unknown-key defence intact. Merged after `clean` so a live need always wins its own key.
    // Through appointment_answers (0366): the office gets the stored answers as they are (prices
    // included), a crew lead gets them without prices (the database keeps a priced answer the
    // office's whatever his save sends, 0356). A FAILED READ IS AN ERROR, never an empty value: an
    // empty "stored" row here would drop every retired answer on a finished visit.
    const { data: before, error: beforeErr } = await readViaView<{ inspection_answers?: unknown }>(supabase, "answers", (from) =>
      from.select("inspection_answers").eq("id", id).maybeSingle(),
    );
    if (beforeErr) return { ok: false, error: dbError(beforeErr) };
    const storedAnswers = (before as { inspection_answers?: unknown } | null)?.inspection_answers;
    const kept = retiredAnswers(pb, storedAnswers);
    if (Object.keys(kept).length) clean = { ...kept, ...clean };
    // AND THE OPTIONS TWIN. Same read, same row, same reasoning — a chip renamed in Settings must
    // not rewrite what somebody already picked on a finished visit. Stored under a distinct key so
    // it can never collide with the live need's own value or its type.
    const keptOpts = retiredOptions(pb, storedAnswers);
    for (const [k, v] of Object.entries(keptOpts)) {
      const slot = `${k}__was`;
      if (clean[slot] === undefined) clean[slot] = v;
    }
    // AND THE CHILDREN OF A RENAMED CHIP — the third rescue, and the one that loses the most.
    // Renaming "Deck" doesn't only drop the chip; it turns off every question gated behind it, and
    // clearInapplicable above nulls that whole branch. orphanedAnswers tells a playbook edit apart
    // from a real deselect by asking whether yesterday's row still makes the need apply today.
    const orphans = orphanedAnswers(pb, storedAnswers);
    for (const [k, v] of Object.entries(orphans)) {
      const slot = `${k}__kept`;
      if (clean[slot] === undefined) clean[slot] = v;
    }
  }
  return { ok: true, clean };
}

// ── THE CREW LEAD'S INSPECTION (0356) ─────────────────────────────────────────────────────────
//
// Erik (2026-09-26), on whether techs fill in inspections: "crew leader yes tech no". A crew lead
// (profiles.crew_lead, which only an owner or admin sets) who is ON the visit saves the sheet's
// answers and the capture (notes, measurements, materials, photos) through ONE database door,
// save_walkthrough_capture, which checks the same rule and holds his save to those columns: he never
// touches a priced answer, switches a stored sheet or takes a photo off, and holds no UPDATE on
// appointments. Everything else on the visit stays the office's. A plain tech is refused here, the
// same "staff-only" answer he always got, in plainer words.

/** requireStaff's refusal for a signed-in, non-staff member: the one refusal a crew lead may get
 *  past. Typed to its literal, so the comparison fails to compile if requireStaff's words change. */
const STAFF_ONLY = "This action is staff-only.";
const CREW_OR_OFFICE = "Only the office, or the crew lead on this visit, can fill in the inspection.";

/** The crew lead ON this visit, or why not. The database asks all of it again; this is so the
 *  refusal is plain words before any write is attempted. */
async function crewLeadOnVisit(
  id: string,
): Promise<{ supabase: SupabaseClient; userId: string; orgId: string } | { error: string }> {
  const ctx = await requireMember();
  if ("error" in ctx) return { error: ctx.error ?? "Sign in again to fill in the inspection." };
  const { data: me } = await ctx.supabase.from("profiles").select("crew_lead").eq("id", ctx.userId).maybeSingle();
  if (!(me as { crew_lead?: boolean | null } | null)?.crew_lead) return { error: CREW_OR_OFFICE };
  const { data: appt } = await ctx.supabase
    .from("appointments")
    .select("id, assigned_to")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!appt || (appt as { assigned_to?: string | null }).assigned_to !== ctx.userId) return { error: CREW_OR_OFFICE };
  return { supabase: ctx.supabase, userId: ctx.userId, orgId: ctx.orgId };
}

/** The database's no, in the words a person reads. `refused` stops the autosave re-trying a save
 *  that will be refused again.
 *
 *  EVERY WAY OUT OF HERE GOES THROUGH inspectionDbWords, because save_walkthrough_capture's own
 *  sentences still say "walk-through" — they are literals in an applied migration (0356) and this is
 *  the one place they reach a person. Without it a crew lead whose seat lapsed read "Sign in with an
 *  active seat to fill in the walk-through." on a screen that says Inspection everywhere else.
 *  lib/inspection/db-refusal has the why; inspection-word.test.ts reads the migration and proves
 *  this covers every sentence it can raise. */
function inspectionRefusal(error: { code?: string | null; message?: string | null }): Result {
  if (isMissingRpc(error))
    return {
      ok: false,
      refused: true,
      error: "Crew leads can't save the inspection until the office finishes an update. Nothing was saved.",
    };
  if (error.code === "42501") return { ok: false, refused: true, error: inspectionDbWords(error.message || CREW_OR_OFFICE) };
  return { ok: false, error: inspectionDbWords(dbError(error)) };
}

function revalidateInspection(id: string) {
  revalidatePath("/schedule");
  revalidatePath("/planner");
  revalidatePath("/inspections");
  revalidatePath(`/appointments/${id}`);
}

async function saveCaptureAsCrewLead(id: string, patch: CapturePatch): Promise<Result> {
  const crew = await crewLeadOnVisit(id);
  if ("error" in crew) return { ok: false, refused: true, error: crew.error };
  const attempt = async () => {
    const { data: existing, error: readErr } = await crew.supabase
      .from("appointments")
      .select("capture")
      .eq("id", id)
      .eq("org_id", crew.orgId)
      .maybeSingle();
    if (readErr) return { failed: { ok: false, error: dbError(readErr) } as Result };
    if (!existing) return { failed: { ok: false, error: "Appointment not found." } as Result };
    const stored = (existing as { capture?: unknown }).capture ?? null;
    // He adds photos; every one already on the list stays (the office takes one off). His `photos`
    // are what he ADDS (addInspectionPhotos sends only the ones just taken), appended to the stored
    // list here, so a photo the office added while his page was open is kept, not refused, and one
    // the office took off isn't in what he sends to come back.
    const fixed: CapturePatch =
      patch.photos !== undefined ? { ...patch, photos: keepStoredPhotos(parseInspectorCapture(stored).photos, patch.photos) } : patch;
    return crew.supabase.rpc("save_walkthrough_capture", { p_appointment: id, p_capture: mergeCaptureSections(stored, fixed) });
  };
  let r = await attempt();
  // A photo the office put on between that read and the save is on the stored list but not on his:
  // the database refuses that as taking it off. Read again and merge once more; a refusal about WHO
  // he is comes back the same the second time.
  if (!("failed" in r) && r.error?.code === "42501") r = await attempt();
  if ("failed" in r) return r.failed;
  const { data, error } = r;
  if (error) return inspectionRefusal(error);
  // The function returns the id it wrote; nothing back means nothing was written.
  if (!data) return { ok: false, error: "That didn't save - reload and try again." };
  revalidateInspection(id);
  return { ok: true, id };
}

async function saveAnswersAsCrewLead(
  id: string,
  templateId: string | null,
  answers: Record<string, unknown>,
  clientOpId?: string,
): Promise<Result> {
  const crew = await crewLeadOnVisit(id);
  if ("error" in crew) return { ok: false, refused: true, error: crew.error };
  return runOnce({ clientOpId, action: "inspection.answers", orgId: crew.orgId, profileId: crew.userId }, async () => {
    const c = await cleanInspectionAnswers(crew.supabase, id, templateId, answers);
    if (!c.ok) return c;
    const { data, error } = await crew.supabase.rpc("save_walkthrough_capture", {
      p_appointment: id,
      p_template_id: templateId,
      p_answers: c.clean,
    });
    if (error) return inspectionRefusal(error);
    if (!data) return { ok: false, error: "That didn't save - reload and try again." };
    revalidatePath(`/appointments/${id}`);
    revalidatePath("/inspections");
    return { ok: true, id };
  });
}

export async function updateAppointment(id: string, formData: FormData): Promise<Result> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };
  const cust = await resolveCustomer(supabase, formData, ctx.userId);
  if (cust.error) return { ok: false, error: cust.error };
  const customerId = cust.customerId;

  // Prefer the ISO the browser computed in the user's own timezone; the fallback
  // builds the instant in the ORG timezone (never the server's UTC).
  const apptDate = String(formData.get("date") ?? "");
  const startIso = await resolveIso(supabase, emptyToNull(formData.get("starts_at_iso")), apptDate, String(formData.get("start_time") ?? ""));
  if (!startIso) return { ok: false, error: "Pick a date." };
  const endTime = String(formData.get("end_time") ?? "");
  const endIso =
    emptyToNull(formData.get("ends_at_iso")) ??
    (endTime ? await resolveIso(supabase, null, apptDate, endTime) : null);
  const endErr = endAfterStart(startIso, endIso);
  if (endErr) return { ok: false, error: endErr };

  // THE ROW'S OWN KIND (W2-06): an edit may keep a kind nobody can pick any more (a Client Meeting
  // stays one), so the guard needs to know what is stored. RLS scopes the read; a missing row is
  // the zero-row write below, said in words.
  const { data: cur } = await supabase.from("appointments").select("type").eq("id", id).maybeSingle();
  const typed = resolveType(formData, "other", (cur as { type?: string | null } | null)?.type ?? null);
  if (typed.error) return { ok: false, error: typed.error };

  const { data: wroteAppt, error } = await supabase
    .from("appointments")
    .update({
      type: typed.type,
      title,
      starts_at: startIso,
      ends_at: endIso,
      job_id: emptyToNull(formData.get("job_id")),
      customer_id: customerId,
      location: emptyToNull(formData.get("location")),
      notes: emptyToNull(formData.get("notes")),
      assigned_to: emptyToNull(formData.get("assigned_to")),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wroteAppt?.length) return { ok: false, error: "That appointment could not be found." };

  await pushCalendarItem("appointment", id); // live Google push (fire-safe)

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  revalidatePath(`/appointments/${id}`); // the capture page hosts Edit Details — show the save
  return { ok: true };
}

/**
 * HOW THE INSPECTION ENDED (0205) — the missing exit.
 *
 * Erik lost the Donner Pass bid and had nowhere to say so: that visit has no customer, no
 * inquiry, no job, no capture and no estimate, so "mark the estimate Declined" had nothing to
 * write to — which is exactly why it "didn't save". The outcome lives on the APPOINTMENT so an
 * orphaned visit can still be settled by the person who was standing there.
 *
 * Same concept as accepting or declining the estimate (his words: "it would be the one in the
 * same"), which stamps this column too — one decision, recorded wherever it is made.
 */
export async function setAppointmentOutcome(
  id: string,
  outcome: "won" | "lost" | "no_bid" | null,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data, error } = await ctx.supabase
    .from("appointments")
    .update({ outcome, outcome_at: outcome ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  // Silent-write law: a zero-row update is a 204, and "saved" without a row is the failure
  // this whole fix exists to end.
  if (!data?.length) return { ok: false, error: "That didn't save — check your access and try again." };
  revalidatePath("/planner");
  revalidatePath("/inspections");
  return { ok: true };
}

/**
 * Set an appointment's status.
 *
 * TWO THINGS THIS OWED THE CALLER (audit v800 wave B).
 *
 * THE SILENT-WRITE LAW. The update carried no `.select()`, so a row RLS declined to touch came
 * back with no error and no rows — and this returned ok:true. Cancelling somebody else's
 * tenant's appointment, or one deleted a moment ago, reported success while nothing moved. A
 * zero-row UPDATE is a 204, not an error; the only way to know is to ask for the row back.
 *
 * SOMETHING TO UNDO WITH. Cancelling is destructive and Erik's standing rule is no save game —
 * every deed gets an undo trail. The previous status comes back so a caller can offer to put it
 * straight back, and `note` names the one thing undo genuinely cannot restore: withdrawing a
 * live "pick a time" link is irreversible, because the customer may already have seen it die.
 * Saying so beats an undo that quietly restores less than it promises.
 */
export async function setAppointmentStatus(
  id: string,
  status: string,
): Promise<Result & { previousStatus?: string; note?: string }> {
  // Spine guard (mirrors the 0052 check constraint) so a bad value reads as a clean
  // message instead of a raw Postgres constraint error.
  if (!(APPOINTMENT_STATUSES as readonly string[]).includes(status))
    return { ok: false, error: `Status must be one of: ${APPOINTMENT_STATUSES.join(", ")}.` };
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Read first so undo has something to go back TO. RLS scopes this, so a cross-tenant id
  // simply doesn't resolve and we stop before writing anything.
  const { data: before } = await supabase
    .from("appointments")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  const previousStatus = (before as { status?: string } | null)?.status;
  const { data: wrote, error } = await supabase
    .from("appointments")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length)
    return { ok: false, error: "That appointment didn't change — reload and check it still exists." };
  // Cancelling/completing an appointment kills any live "pick a time" link, so a
  // customer tap can't resurrect a closed appointment.
  let note: string | undefined;
  if (status === "cancelled" || status === "completed") {
    const { data: withdrawn } = await supabase
      .from("schedule_proposals")
      .update({ status: "cancelled" })
      .eq("appointment_id", id)
      .eq("status", "pending")
      .select("id");
    // The one part undo can't put back — say so rather than implying a clean reversal.
    if (withdrawn?.length) note = "The customer's pick-a-time link was withdrawn and can't be un-withdrawn.";
  }
  // Google reconcile (fire-safe): cancel deletes the event; other statuses re-push.
  await pushCalendarItem("appointment", id);
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true, previousStatus, note };
}

/** Reschedule an appointment to a new time (partial — keeps everything else). Used by the
 *  voice agent ("move the Smith inspection to Thursday at 9") so a reschedule doesn't force a
 *  cancel+recreate. Org-scoped by RLS (a cross-org id is a clean no-op). Proposal-aware:
 *  a live "pick a time" link is withdrawn (like setAppointmentStatus does on cancel/complete)
 *  so the customer's later tap on an OLD option can't silently overwrite this move — the
 *  returned `note` lets the caller mention the withdrawn link. */
export async function rescheduleAppointment(
  id: string,
  startsAtIso: string,
  endsAtIso?: string | null,
): Promise<Result & { note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const start = new Date(startsAtIso);
  if (isNaN(start.getTime())) return { ok: false, error: "I couldn't read that date/time." };
  const patch: Record<string, string | null> = { starts_at: start.toISOString(), updated_at: new Date().toISOString() };
  if (endsAtIso) {
    const end = new Date(endsAtIso);
    // Don't silently swallow a bad end time and still report success — tell the caller.
    if (isNaN(end.getTime())) return { ok: false, error: "I couldn't read the end time." };
    if (end.getTime() <= start.getTime()) return { ok: false, error: "The end time has to be after the start." };
    patch.ends_at = end.toISOString();
  } else {
    /* NO END GIVEN: THE VISIT KEEPS ITS LENGTH, NOT ITS OLD END (audit v994 SI1). Nort's "move the
       Smith inspection to Thursday at 9" passes only a start, and the old end stayed where it was:
       Tue 9-10 became Thu 9 AM to Tue 10 AM, and moved earlier it spanned three days on the
       calendar and a 49-hour event in Google. The old span moves with the start when it was a
       real span; an end that was missing or already at/before its start is cleared, and the
       calendar draws its default hour. */
    const { data: cur, error: curErr } = await supabase
      .from("appointments")
      .select("starts_at, ends_at") // THE PROJECTION LAW: the two columns the length is read from
      .eq("id", id)
      .maybeSingle();
    if (curErr) return { ok: false, error: dbError(curErr) };
    if (!cur) return { ok: false, error: "Appointment not found." };
    patch.ends_at = keptEnd(start, (cur as { starts_at: string | null; ends_at: string | null }).starts_at, (cur as { ends_at: string | null }).ends_at);
  }
  const { data, error } = await supabase.from("appointments").update(patch).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data || !data.length) return { ok: false, error: "Appointment not found." };
  // The reschedule supersedes any pending pick-a-time link — kill it, or the customer
  // could tap a stale option later and move the appointment back underneath us.
  const { data: withdrawn } = await supabase
    .from("schedule_proposals")
    .update({ status: "cancelled" })
    .eq("appointment_id", id)
    .eq("status", "pending")
    .select("id");
  /* audit v921: THE DOOR BACK OUT OF "pending pick". The office just chose the time by hand, but
     nothing wrote status — choose_schedule_slot is the ONLY proposed→scheduled writer and the link
     it needs was withdrawn a line ago. The visit read "pending pick" forever, never reached Google
     (APPT_PUSH_STATUSES drops proposed) and never nagged from Needs action once its day passed.
     Zero rows here just means it wasn't proposed; the flip has to land before the push below. */
  await supabase
    .from("appointments")
    .update({ status: "scheduled" })
    .eq("id", id)
    .eq("status", "proposed")
    .select("id");
  await pushCalendarItem("appointment", id); // live Google push (fire-safe)
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return {
    ok: true,
    ...(withdrawn?.length
      ? { note: "The customer's pick-a-time link for this appointment was withdrawn — offer new times if they still need to choose." }
      : {}),
  };
}

/** Turn an appointment (often a site-visit/estimate inspection) into a job —
 *  idempotent: if it already spawned one, returns that job. Inherits the
 *  customer, the visit's words (never its tag) → name (lib/job-name), location → address, and start time. */
export async function createJobFromAppointment(
  appointmentId: string,
): Promise<Result & { note?: string; /** The visit already had a job (maybe one made a moment ago on another device); `id` is that job. */ already?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: appt } = await supabase
    .from("appointments")
    // PROJECTION LAW: everything the job inherits has to be in the select list. planned_minutes,
    // ends_at and inquiry_id were all missing, which is why none of them survived the conversion.
    // `notes` too (209451e1): the lead's message rode the visit and never reached the job.
    .select("id, title, customer_id, location, unit, city, state, zip, job_id, starts_at, ends_at, planned_minutes, inquiry_id, notes")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.job_id) return { ok: true, id: appt.job_id, already: true };

  /* WHAT THE VISIT ALREADY KNEW TRAVELS WITH IT.
     Erik: "im not sure why it says 5 hours but i already marked it as a job … we need more
     continuity between the leads page info jobs, appts and the interconnection of all these little
     tags and such so theyre all talking to each other."

     He is describing the actual defect. The conversion carried a name, a customer and an address
     and dropped everything else on the floor — so a visit sized at three hours became a job sized
     at nothing, which the calendar then drew to the end of the working day. Five hours nobody
     chose, on a record he had already told the app about twice.

     A number is only worth asking for once. The size comes across, the finish is computed from it
     rather than defaulted, and inquiry_id comes too so the chain from the lead survives the step
     instead of ending here. */
  /* WHO THE WORK IS FOR TRAVELS WITH IT TOO (audit v921). The "let them pick" door books the visit
     with customer_id null, so this insert wrote jobs.customer_id = null — and nothing in the tree
     ever backfills it: settleUp mints/links the customer onto the INVOICE only. The result was a
     paid job missing from its own customer's card and a job page with no contact. If the lead
     already carries a card, the job inherits it here, at the one step that connects the two.

     AND A FRESH LEAD GETS ITS CARD HERE (209451e1). A lead → inspection visit → Start The Job is a
     win like any other, and every other win (an accepted estimate, settleUp, setJobContact) mints
     the customer through the one rule, customerForInquiry: dedup by phone / email / name, the
     person's own address, the lead stamped won. This door stamped the lead won and minted nothing,
     so the job was born with no contact and the customer never existed until money landed. */
  const inquiryId = (appt as { inquiry_id?: string | null }).inquiry_id ?? null;
  type Who = { name?: string | null; company_name?: string | null; type?: string | null } | null;
  type Lead = { customer_id?: string | null; name?: string | null; company_name?: string | null; type?: string | null };
  let lead: Lead | null = null;
  if (inquiryId) {
    const { data: iq } = await supabase.from("inquiries").select("customer_id, name, company_name, type").eq("id", inquiryId).maybeSingle();
    lead = (iq as Lead | null) ?? null;
  }
  let customerId = appt.customer_id ?? lead?.customer_id ?? null;
  if (!customerId && inquiryId) customerId = await customerForInquiry(supabase, inquiryId, ctx.userId);

  /* THE NAME IS THE STREET, NEVER THE VISIT IT CAME FROM (Erik 2026-09-27: "site inspections are
     labeled with the tag they shouldnt carry site inspection in the job title"; 09-28: "street
     number and name as always"). A job was born "Site inspection: Rita Moss" because this copied
     the visit's title. The one namer (lib/job-name): the visit's street number and name (" #56"
     with its unit); with no street, who as written and the visit's own words, tag off. Who (jobWho,
     the same order the visit page's preview uses): the card, else the lead; the lead's own spelling
     still counts as only-who, since the visit's stock title was built from it. */
  const { data: orgRow } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone;
  let card: Who = null;
  if (customerId) {
    const { data: c } = await supabase.from("customers").select("name, company_name, type").eq("id", customerId).maybeSingle();
    card = (c as Who) ?? null;
  }
  const { customer: who, aliases } = jobWho([card, lead]);
  const apptUnit = (appt as { unit?: string | null }).unit ?? null;
  const jobName = jobNameFrom({
    sourceWords: appt.title,
    customer: who,
    aliases,
    // The street of the place, never its town: a lead with only a city booked at "Testville, CA 96161".
    street: visitStreetOf(appt.location, appt),
    unit: apptUnit,
    todayStr: todayStrInTz(tz),
  });

  const sized = Number((appt as { planned_minutes?: number | null }).planned_minutes ?? 0);
  const apptEnd = (appt as { ends_at?: string | null }).ends_at ?? null;
  const scheduledEnd = sized > 0 && appt.starts_at
    ? new Date(new Date(appt.starts_at).getTime() + Math.min(sized, WORK_DAY_MINUTES) * 60_000).toISOString()
    : // A visit with no size and no end becomes a job of the default length (two hours, "2 hours —
      // change it"), never a job with no end, which drew as the rest of the work day.
      apptEnd ?? (appt.starts_at ? new Date(new Date(appt.starts_at).getTime() + DEFAULT_JOB_MINUTES * 60_000).toISOString() : null);

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      name: jobName,
      customer_id: customerId,
      // THE KIND OF BILLING TRAVELS WITH THE JOB (2026-10-03). Named nothing, so the column fell to
      // its default 'fixed' — which not only mislabels the job but switches OFF whether its hours and
      // receipts are offered at invoicing, the Unbilled card, the portal, and step 4 of
      // completeJobWhenPaid. readUsualBillingKind is the company's own answer; a failed read is "tm".
      billing_type: await readUsualBillingKind(supabase),
      inquiry_id: inquiryId,
      // The visit's notes (the lead's message, what the inspector was told) are the job's scope.
      description: (appt as { notes?: string | null }).notes ?? null,
      // A visit waiting for a day (no start, 0368) makes a job that is waiting for one too.
      status: appt.starts_at ? "scheduled" : "to_be_scheduled",
      planned_minutes: sized > 0 ? sized : null, // blank stays blank — never a made-up number
      scheduled_start: appt.starts_at,
      scheduled_end: scheduledEnd,
      address: appt.location,
      unit: apptUnit, // the visit's unit is the job's (0187), and its name's " #56"
      // THE PARTS TRAVEL WITH THE LINE. This selected `location` alone and pushed that one string
      // into jobs.address with city/state/zip null — the exact Wexley/Crake blob shape, minted
      // fresh on every job born from an appointment. `location` is already a formatted full line,
      // so carrying the parts alongside it would print the town twice; siteLines suppresses the
      // second line when the first carries its own tail, which is why this is now safe to do.
      city: (appt as { city?: string | null }).city ?? null,
      state: (appt as { state?: string | null }).state ?? null,
      zip: (appt as { zip?: string | null }).zip ?? null,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  // ABSORBED (0237): the job inherits this visit's very slot, so the booking's calendar life is
  // over on EVERY surface at once — grid, My Day, feeders, Google, reminder emails. One column,
  // one meaning; the per-surface type-based skips this replaces each covered one door and left
  // the rest showing ghosts.
  //
  // THE LINK IS THE CLAIM (visit-start review, 2026-09-25). The job_id read above is a check, and
  // two devices tapping Start The Job at once both passed it and both inserted a job; this update
  // then overwrote the first link with the second, orphaning one job with a clock running on it.
  // So the write only lands on a visit that still has no job, and the tap that lands zero rows
  // re-reads to learn why: somebody else's job won (ours is deleted, it has no children yet, and
  // the winner is returned so the caller clocks into THAT one), or the visit is gone.
  // SILENT-WRITE LAW (audit v921): a zero-row update is a 204, not a success. Hence .select("id").
  const { data: absorbed } = await supabase
    .from("appointments")
    // …and the visit keeps the same answer the job just got (audit v921) — one contact, both records.
    .update({ job_id: job.id, absorbed: true, ...(!appt.customer_id && customerId ? { customer_id: customerId } : {}) })
    .eq("id", appointmentId)
    .is("job_id", null)
    .select("id");
  if (!absorbed?.length) {
    const { data: again } = await supabase.from("appointments").select("job_id").eq("id", appointmentId).maybeSingle();
    const winner = (again as { job_id?: string | null } | null)?.job_id ?? null;
    if (winner && winner !== job.id) {
      const { data: gone } = await supabase.from("jobs").delete().eq("id", job.id).select("id");
      return {
        ok: true,
        id: winner,
        already: true,
        ...(gone?.length
          ? {}
          : { note: "Someone else started this visit's job a moment ago. A second job was made at the same instant and could not be removed; delete it from Jobs." }),
      };
    }
  }
  const absorbNote = absorbed?.length
    ? undefined
    : "That visit disappeared while the job was being created — the job was made from what it had.";

  /* A THREE-DAY VISIT CONVERTS TO A THREE-DAY JOB. scheduled_end above is clamped to one working
     day (it is a wall-clock pair), so without segments a Mon–Wed visit became a Monday job — and
     Tuesday and Wednesday, which the appointment had rightly marked busy, sprang free the moment
     it was deduped behind the job. Same day-expansion rule the rail's placement uses. */
  const sizedDays = daysNeeded(sized);
  if (sizedDays > 1 && appt.starts_at) {
    const firstDay = todayStrInTz(tz, new Date(appt.starts_at));
    const run = workingDaysFrom(firstDay, sizedDays);
    if (run.length) {
      await supabase.from("job_schedule_segments").insert(
        run.map((d) => ({ job_id: job.id, start_date: d, end_date: d })),
      );
    }
  }

  /* STAMP FOLLOWS DEED — the lead too. This path minted jobs without ever telling the lead, so
     Karen sat on /leads as "contacted" while her job was already on the calendar ("the leads
     converted to jobs put back as leads are still there"). A lead whose work became a job is won,
     and not a lead anymore. */
  if (inquiryId) {
    await supabase
      .from("inquiries")
      .update({
        status: "won",
        converted_at: new Date().toISOString(),
        ...(customerId ? { customer_id: customerId } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", inquiryId)
      .is("converted_at", null); // idempotent — an already-stamped lead keeps its original stamp
    revalidatePath("/leads");
  }
  // The visit is now represented by the job on the calendar (they draw as one — see gridDataFor),
  // so nothing is lost by leaving the appointment in place: it keeps its capture, its answers and
  // its provenance, and stops competing with the job for the same afternoon.
  await pushCalendarItem("job", job.id); // the new job is scheduled — push it (fire-safe)
  // …and reconcile the absorbed booking's OWN Google event away (pushApptRow sees absorbed and
  // deletes) — otherwise his phone calendar keeps both, the exact double this column exists to end.
  await pushCalendarItem("appointment", appointmentId);
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true, id: job.id, ...(absorbNote ? { note: absorbNote } : {}) };
}

export async function deleteAppointment(id: string): Promise<Result> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // BEFORE the row goes (it reads google_event_id off the row). Fire-safe.
  await deleteCalendarItem("appointment", id);
  const { data: del, error } = await supabase.from("appointments").delete().eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!del?.length) return { ok: false, error: "That appointment could not be found." };
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true };
}

/** The paths every Won't Happen / Put It Back write revalidates: everywhere a visit shows. */
function revalidateVisit(id: string) {
  revalidatePath("/schedule");
  revalidatePath("/planner");
  revalidatePath("/inspections");
  revalidatePath(`/appointments/${id}`);
}

/**
 * WON'T HAPPEN (W2-11) — the visit page's one door for a visit that isn't going ahead, in place of
 * the ✗ Cancel and the top-row Delete. The rule is lib/appointments/wont-happen: DELETED only when
 * nothing was captured on it, no estimate was written from it, no invoice points at it and no
 * pick-a-time link is waiting; otherwise CANCELLED through setAppointmentStatus (the pending link is
 * withdrawn and said so, the Google event goes), with the previous status for Undo.
 *
 * Every fact is read again here, at the write: the page's confirm is a hint, and a capture saved in
 * between wins. The answers come through the appointment_answers view (readViaView), never the table.
 * A fact that can't be read counts as "something is there". The delete lands only on the row as it
 * was read (its updated_at): a save that slipped in after the read turns it into a cancel instead.
 */
export async function wontHappenAppointment(
  id: string,
): Promise<Result & { did?: "deleted" | "cancelled"; previousStatus?: string; note?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: row, error: rowErr } = await supabase
    .from("appointments")
    // PROJECTION LAW: the status it's in, what's on it, and the stamp the delete is checked against.
    .select("id, status, capture, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (rowErr) return { ok: false, error: dbError(rowErr) };
  if (!row) return { ok: false, error: "That visit isn't there any more. Reload to see the schedule as it is." };
  const r = row as { status: string; capture: unknown; updated_at: string | null };
  if (r.status === "completed")
    return { ok: false, error: "This visit is marked Done, so it did happen. Edit Details can change or remove it." };
  if (r.status === "cancelled") return { ok: false, error: "This visit is already marked Cancelled." };

  const [answersRead, invoices, links] = await Promise.all([
    readViaView<{ inspection_answers: unknown }>(supabase, "answers", (from) =>
      from.select("inspection_answers").eq("id", id).maybeSingle(),
    ),
    supabase.from("invoices").select("id", { count: "exact", head: true }).eq("appointment_id", id),
    supabase.from("schedule_proposals").select("id", { count: "exact", head: true }).eq("appointment_id", id).eq("status", "pending"),
  ]);
  const verdict = wontHappenVerdict({
    capture: r.capture,
    answers: (answersRead.data as { inspection_answers?: unknown } | null)?.inspection_answers ?? null,
    answersUnread: !!answersRead.error,
    invoiceCount: invoices.error ? null : (invoices.count ?? 0),
    pendingLinks: links.error ? null : (links.count ?? 0),
  });

  if (verdict === "delete") {
    // BEFORE the row goes (it reads google_event_id off the row). Fire-safe.
    await deleteCalendarItem("appointment", id);
    const del = supabase.from("appointments").delete().eq("id", id).eq("status", r.status);
    const { data: gone, error } = await (r.updated_at ? del.eq("updated_at", r.updated_at) : del.is("updated_at", null)).select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (gone?.length) {
      revalidateVisit(id);
      return { ok: true, did: "deleted" };
    }
    // Zero rows: the visit changed after it was read (a capture, a status) or it is gone. One that is
    // gone is said; one somebody marked Done or Cancelled in the meantime keeps what they did; one
    // still booked is cancelled, never deleted on a stale read.
    const { data: still } = await supabase.from("appointments").select("id, status").eq("id", id).maybeSingle();
    if (!still) return { ok: false, error: "That visit isn't there any more. Reload to see the schedule as it is." };
    const now = (still as { status?: string }).status;
    if (now !== "scheduled" && now !== "proposed")
      return { ok: false, error: `That visit changed a moment ago: it's marked ${now === "completed" ? "Done" : "Cancelled"} now. Reload to see it.` };
  }

  const res = await setAppointmentStatus(id, "cancelled");
  if (!res.ok) return res;
  revalidateVisit(id);
  return { ok: true, did: "cancelled", previousStatus: res.previousStatus, ...(res.note ? { note: res.note } : {}) };
}

/**
 * PUT IT BACK ON THE SCHEDULE (W2-11): a cancelled visit had no way back on its page. It comes back
 * Scheduled on its own day when that day is still ahead (today counts); a day that has passed, or
 * none, comes back WAITING FOR A DAY (starts_at and ends_at cleared, 0368), on the rail rather than
 * sitting on a past day. Only a cancelled visit: anything else is said, never quietly re-stamped.
 */
export async function putVisitBackOnSchedule(id: string): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: row, error: rowErr } = await supabase.from("appointments").select("id, status, starts_at").eq("id", id).maybeSingle();
  if (rowErr) return { ok: false, error: dbError(rowErr) };
  if (!row || (row as { status?: string }).status !== "cancelled")
    return { ok: false, error: "Only a cancelled visit can go back on the schedule." };

  const { data: orgRow } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone;
  const startsAt = (row as { starts_at?: string | null }).starts_at ?? null;
  const plan = putBackPlan(startsAt ? todayStrInTz(tz, new Date(startsAt)) : null, todayStrInTz(tz));

  const { data: wrote, error } = await supabase
    .from("appointments")
    .update({
      status: "scheduled",
      ...(plan.keepDay ? {} : { starts_at: null, ends_at: null }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "cancelled")
    .select("id");
  if (error) {
    // A database without 0368 still holds starts_at NOT NULL: said plainly, nothing changed.
    if ((error as { code?: string }).code === "23502")
      return { ok: false, error: "Its day has passed, and a visit can't wait without a day until a quick database update is done. It stays Cancelled." };
    return { ok: false, error: dbError(error) };
  }
  if (!wrote?.length) return { ok: false, error: "Only a cancelled visit can go back on the schedule." };
  await pushCalendarItem("appointment", id); // back on the phone's calendar when it has a day (fire-safe)
  revalidateVisit(id);
  return { ok: true, message: plan.message };
}

/**
 * BACK TO "WAITING FOR A DAY".
 *
 * The customer calls: "not sure when — we'll get back to you." The rail was built for exactly this
 * state (a booking with no start shows under Waiting for a day, placeable with one tap) and yet no
 * door LED there: the edit form's date is required, rescheduleAppointment rejects an empty start,
 * and the only other exits were cancel (a lie — nobody cancelled) or leaving a stale date on the
 * calendar to mislead the week it sits in. Postponed-indefinitely was a dead end.
 *
 * Clears the WHEN and nothing else: capture, photos, provenance, status all stay. The pick-a-time
 * withdrawal mirrors rescheduleAppointment — a stale link the customer taps later must not
 * resurrect a date the office just cleared.
 */
export async function unscheduleAppointment(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data, error } = await supabase
    .from("appointments")
    .update({ starts_at: null, ends_at: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["scheduled", "proposed"]) // a completed/cancelled visit's date is history, not a plan
    .select("id");
  if (error) {
    // A DATABASE WITHOUT 0368 still holds starts_at NOT NULL (0042), and refused every press of this
    // door with Postgres' own words: the dead door found on production, 2026-09-27. Said plainly
    // until the migration lands; the visit keeps its date, and says so.
    if ((error as { code?: string }).code === "23502") {
      return { ok: false, error: "A visit can't wait without a day until a quick database update is done. Its date is unchanged." };
    }
    return { ok: false, error: dbError(error) };
  }
  if (!data?.length) return { ok: false, error: "Only a scheduled visit can go back to waiting." };
  await supabase
    .from("schedule_proposals")
    .update({ status: "cancelled" })
    .eq("appointment_id", id)
    .eq("status", "pending");
  // audit v921: mirror of rescheduleAppointment — with the link withdrawn nothing could ever move
  // this row off "proposed" again, so a booking waiting for a day would sit on the rail claiming a
  // pick that can no longer happen. A dateless booking's status is plain 'scheduled'.
  await supabase.from("appointments").update({ status: "scheduled" }).eq("id", id).eq("status", "proposed").select("id");
  await pushCalendarItem("appointment", id); // unscheduled = a Google delete (gcal-map's rule)
  revalidatePath("/schedule");
  revalidatePath("/planner");
  revalidatePath("/inspections");
  revalidatePath(`/appointments/${id}`);
  return { ok: true };
}

/**
 * THE INSPECTOR, FROM THE JOB — an access point, not a wall.
 *
 * Erik: "on the job page we need to have a button for the inspection which open the inspector at
 * any moment referring to any and all data input there from any entrance point so an access point
 * not a wall."
 *
 * The Inspector (field notes, photos, the typed sheet, the customer's intake answers) lives on an
 * appointment record — which was fine while every piece of work passed through an appointment, and
 * became a wall the day sold work started going straight to a job. The data is often already there
 * from an earlier entrance (the inspection, the lead's intake); this finds it rather than
 * starting a blank one.
 *
 * Resolution order — most data first:
 *   1. a visit already linked to THIS job (newest, not cancelled)
 *   2. a visit on the job's LEAD — the inspection that sold it, capture and all
 *   3. nothing anywhere → create one now, seeded from the lead when there is one (intake answers
 *      and plan brief carry, via the same one-tap door the lead row uses), linked to the job.
 */
export async function openJobInspector(jobId: string): Promise<Result & { redirect?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: job } = await supabase
    .from("jobs")
    .select("id, name, inquiry_id, customer_id, address, city, state, zip")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  const { data: own } = await supabase
    .from("appointments")
    .select("id")
    .eq("job_id", jobId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (own) return { ok: true, id: own.id, redirect: `/appointments/${own.id}` };

  if (job.inquiry_id) {
    const { data: fromLead } = await supabase
      .from("appointments")
      .select("id")
      .eq("inquiry_id", job.inquiry_id)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fromLead) {
      // Adopt it: the job is this work's durable record, and linking makes the calendar draw ONE
      // thing and every later "where are the notes?" resolve here first.
      await supabase.from("appointments").update({ job_id: jobId }).eq("id", fromLead.id);
      return { ok: true, id: fromLead.id, redirect: `/appointments/${fromLead.id}` };
    }
    // Seeded from the lead — intake answers and the plan brief carry, same as the lead-row door.
    const made = await createInspectionNow({ inquiryId: job.inquiry_id });
    if (made.ok && made.id) {
      await supabase.from("appointments").update({ job_id: jobId }).eq("id", made.id);
      return { ok: true, id: made.id, redirect: `/appointments/${made.id}` };
    }
    return made;
  }

  // A lead-less job still gets its notes surface — seeded from the job itself.
  const { data: appt, error } = await supabase
    .from("appointments")
    .insert({
      type: "other",
      title: `Site notes — ${job.name}`,
      starts_at: new Date().toISOString(),
      status: "scheduled",
      location: job.address ?? null,
      city: job.city ?? null,
      state: job.state ?? null,
      zip: job.zip ?? null,
      customer_id: job.customer_id ?? null,
      job_id: jobId,
      assigned_to: ctx.userId,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error || !appt) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: appt.id, redirect: `/appointments/${appt.id}` };
}

/**
 * WHO'S GOING ON A VISIT, from the schedule tile's sheet. A visit carries ONE person
 * (appointments.assigned_to), so this puts one on, swaps them, or takes them off (null): the visit's
 * twin of the job crew chips. Only someone in this company (the caller's own RLS read of profiles,
 * never another company's id), written with the id back (the silent-write law), the newly put-on
 * person told on the bell and by push the way a new booking tells them, and the Google event follows.
 */
export async function setAppointmentAssignee(id: string, profileId: string | null): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const who = profileId ? String(profileId) : null;
  if (who) {
    const { data: person } = await supabase.from("profiles").select("id").eq("id", who).maybeSingle();
    if (!person) return { ok: false, error: "That person isn't on this team, so nobody changed." };
  }
  const { data: before } = await supabase.from("appointments").select("assigned_to, title").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "That visit isn't available, so nobody changed." };
  const { data: wrote, error } = await supabase
    .from("appointments")
    .update({ assigned_to: who, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That visit isn't available, so nobody changed." };

  const was = (before as { assigned_to?: string | null }).assigned_to ?? null;
  if (who && who !== was && who !== ctx.userId) {
    const orgId = ctx.orgId;
    const title = (before as { title?: string | null }).title ?? null;
    after(() => notifyPeople(orgId, [who], "assigned", { title: "New appointment assigned", body: title, url: `/appointments/${id}` }));
  }
  await pushCalendarItem("appointment", id); // live Google push (fire-safe)
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments, and whose they are
  revalidatePath(`/appointments/${id}`);
  return { ok: true };
}
