"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { mergeCaptureSections, type CapturePatch } from "@/lib/inspection/capture";
import { formatFullAddress } from "@/lib/utils";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { emptyToNull } from "@/lib/forms";
import { pushCalendarItem, deleteCalendarItem } from "@/lib/calendar-sync";
import { requireStaff } from "@/lib/staff-guard";
import { sendPushToProfiles } from "@/lib/push";
import { getOrgSettings } from "@/lib/org-settings";
import { tzDateTimeUtc, todayStrInTz } from "@/lib/tz";
import { createProposalCore, cleanSlots } from "@/lib/appointments/proposal";
import { endAfterStart } from "@/lib/appointments/times";
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES, INSPECTION_TYPES } from "@/lib/statuses";
import { briefNote, carriedNote, carryForInquiry } from "@/lib/inquiries/carry-intake-answers";
import { coerceByPlaybook, orphanedAnswers, retiredAnswers, retiredOptions } from "@/lib/playbook/answers";
import { playbookForForm } from "@/lib/playbook/parse";
import { clearInapplicable } from "@/lib/playbook/resolve";
import { runOnce } from "@/lib/offline/run-once";
import type { SupabaseClient } from "@supabase/supabase-js";

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

export type Result = { ok: boolean; error?: string; id?: string };

/** Spine guard for appointments.type (mirrors the 0051/0131 check constraint) — a bad
 *  value reads as a clean message instead of a raw Postgres constraint error. */
function resolveType(formData: FormData, fallback: string): { type?: string; error?: string } {
  const type = String(formData.get("type") ?? fallback);
  if (!(APPOINTMENT_TYPES as readonly string[]).includes(type))
    return { error: `Type must be one of: ${APPOINTMENT_TYPES.join(", ")}.` };
  return { type };
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
      .insert({ name: newName, phone: emptyToNull(formData.get("new_customer_phone")), created_by: userId })
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

  const typed = resolveType(formData, "appointment");
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
    void sendPushToProfiles([assignedTo], "assigned", {
      title: "New appointment assigned",
      body: title,
      // Deep-link the appointment's DAY so staff land where its edit/quick actions
      // live, not the generic week (audit cn-v328). apptDate is the org-local day the
      // user picked; a tech recipient is still bounced to /planner by the office-only
      // gate on /schedule — that's a separate, pre-existing constraint.
      url: apptDate ? `/schedule?view=day&date=${apptDate}` : "/schedule",
    });
  }

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true, id: data.id };
}

/** "Inspect now" — the already-onsite path (Erik: "sometimes we're onsite already — too
 *  many steps today"). Creates a type='inspection' appointment starting NOW (status
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
      .select("id, name, address, city, state, zip, message, notes, customer_id, intake")
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
      type: "inspection",
      title: inq ? `Site inspection: ${inq.name}` : "Site inspection",
      starts_at: new Date().toISOString(), // now — an instant is an instant in any tz
      status: "scheduled", // NOT completed: the capture (or "Mark inspection complete") finishes it
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
 * THE LEAD'S ONE DOOR INTO ITS WALK-THROUGH (Erik: "a preliminary inspection report button on
 * the lead page itself so i can open the inspector right there with the data all filled in").
 * Opens the lead's EXISTING inspection when one is live — a second tap must never mint a second
 * walk-through — and otherwise starts one now through createInspectionNow, which seeds the
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

  const typed = resolveType(formData, "quote");
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
 * Cain place", not "it is an inquiry record". So: type a name or an address, get everything that
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
    .select("id, title, location")
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
  const STOCK = ["site inspection", "inspection", "final inspection", "appointment", ""];
  if (name && STOCK.includes(String(appt.title ?? "").trim().toLowerCase())) {
    patch.title = `Site inspection: ${name}`;
  }

  const { error } = await supabase
    .from("appointments")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };

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

  // The stock titles the create paths hand out. A title a human chose is never touched.
  const STOCK = ["site inspection", "inspection", "final inspection", "appointment", ""];
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
  // TODO(contested): requireStaff here vs the capture PAGE rendering for any org member —
  // a tech doing the walk-through can upload photos but every Save fails; decide whether
  // capture is member-writable or the page should be staff-gated before touching either.
  const ctx = await requireStaff(); // defense-in-depth (RLS also scopes the write)
  if ("error" in ctx) return { ok: false, error: ctx.error };
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
  if ("error" in ctx) return { ok: false, error: ctx.error };
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

  let clean: Record<string, unknown> = {};
  if (templateId) {
    // RLS confines this read to the caller's org, so a template id from another tenant simply
    // doesn't resolve — the schema we validate against is always one this org owns.
    const { data: form } = await supabase
      .from("forms")
      .select("schema, is_inspection, playbook")
      .eq("id", templateId)
      .maybeSingle();
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
    const { data: before } = await supabase
      .from("appointments")
      .select("inspection_answers")
      .eq("id", id)
      .maybeSingle();
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

  const { data, error } = await supabase
    .from("appointments")
    .update({
      inspection_template_id: templateId,
      inspection_answers: clean,
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

  const typed = resolveType(formData, "appointment");
  if (typed.error) return { ok: false, error: typed.error };

  const { error } = await supabase
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
    .eq("id", id);
  if (error) return { ok: false, error: dbError(error) };

  await pushCalendarItem("appointment", id); // live Google push (fire-safe)

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  revalidatePath(`/appointments/${id}`); // the capture page hosts Edit Details — show the save
  return { ok: true };
}

/**
 * HOW THE WALK-THROUGH ENDED (0205) — the missing exit.
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
  const patch: Record<string, string> = { starts_at: start.toISOString(), updated_at: new Date().toISOString() };
  if (endsAtIso) {
    const end = new Date(endsAtIso);
    // Don't silently swallow a bad end time and still report success — tell the caller.
    if (isNaN(end.getTime())) return { ok: false, error: "I couldn't read the end time." };
    if (end.getTime() <= start.getTime()) return { ok: false, error: "The end time has to be after the start." };
    patch.ends_at = end.toISOString();
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

/** Turn an appointment (often a site-visit/estimate walk-through) into a job —
 *  idempotent: if it already spawned one, returns that job. Inherits the
 *  customer, title → name, location → address, and start time. */
export async function createJobFromAppointment(appointmentId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: appt } = await supabase
    .from("appointments")
    .select("id, title, customer_id, location, city, state, zip, job_id, starts_at")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (appt.job_id) return { ok: true, id: appt.job_id };

  const { data: job, error } = await supabase
    .from("jobs")
    .insert({
      name: appt.title || "Job from appointment",
      customer_id: appt.customer_id,
      status: "scheduled",
      scheduled_start: appt.starts_at,
      address: appt.location,
      // THE PARTS TRAVEL WITH THE LINE. This selected `location` alone and pushed that one string
      // into jobs.address with city/state/zip null — the exact Waldow/Cohen blob shape, minted
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

  await supabase.from("appointments").update({ job_id: job.id }).eq("id", appointmentId);
  await pushCalendarItem("job", job.id); // the new job is scheduled — push it (fire-safe)
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true, id: job.id };
}

export async function deleteAppointment(id: string): Promise<Result> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // BEFORE the row goes (it reads google_event_id off the row). Fire-safe.
  await deleteCalendarItem("appointment", id);
  const { error } = await supabase.from("appointments").delete().eq("id", id);
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true };
}
