"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { pushCalendarItem, deleteCalendarItem } from "@/lib/calendar-sync";
import { requireStaff } from "@/lib/staff-guard";
import { sendPushToProfiles } from "@/lib/push";
import { getOrgSettings } from "@/lib/org-settings";
import { tzDateTimeUtc, todayStrInTz } from "@/lib/tz";
import { createProposalCore, cleanSlots } from "@/lib/appointments/proposal";
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES } from "@/lib/statuses";
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
  if (error) return { ok: false, error: error.message };

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
    message: string | null;
    notes: string | null;
    customer_id: string | null;
  };
  let inq: LeadCtx | null = null;
  if (opts.inquiryId) {
    const { data } = await supabase
      .from("inquiries")
      .select("id, name, address, message, notes, customer_id")
      .eq("id", opts.inquiryId)
      .maybeSingle();
    if (!data) return { ok: false, error: "Lead not found." };
    inq = data as LeadCtx;
  }

  const { data: appt, error } = await supabase
    .from("appointments")
    .insert({
      type: "inspection",
      title: inq ? `Site inspection: ${inq.name}` : "Site inspection",
      starts_at: new Date().toISOString(), // now — an instant is an instant in any tz
      status: "scheduled", // NOT completed: the capture (or "Mark inspection complete") finishes it
      location: inq?.address ?? null,
      notes: inq?.message ?? inq?.notes ?? null,
      customer_id: inq?.customer_id ?? null, // deferred-customer doctrine: no contact row before the win
      inquiry_id: inq?.id ?? null,
      assigned_to: ctx.userId, // whoever tapped is the one standing onsite
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

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

export async function saveAppointmentCapture(
  id: string,
  capture: AppointmentCapture,
): Promise<Result> {
  // TODO(contested): requireStaff here vs the capture PAGE rendering for any org member —
  // a tech doing the walk-through can upload photos but every Save fails; decide whether
  // capture is member-writable or the page should be staff-gated before touching either.
  const ctx = await requireStaff(); // defense-in-depth (RLS also scopes the write)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const clean = {
    notes: String(capture?.notes ?? "").trim().slice(0, 8000),
    measurements: String(capture?.measurements ?? "").trim().slice(0, 8000),
    materials: String(capture?.materials ?? "").trim().slice(0, 8000),
    photos: (Array.isArray(capture?.photos) ? capture.photos : [])
      .filter((p): p is string => typeof p === "string" && p.length > 0 && p.length < 2000)
      .slice(0, 60),
  };

  const { data, error } = await supabase
    .from("appointments")
    .update({ capture: clean, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Appointment not found." };
  revalidatePath("/schedule");
  revalidatePath(`/appointments/${id}`);
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
  if (error) return { ok: false, error: error.message };

  await pushCalendarItem("appointment", id); // live Google push (fire-safe)

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true };
}

export async function setAppointmentStatus(id: string, status: string): Promise<Result> {
  // Spine guard (mirrors the 0052 check constraint) so a bad value reads as a clean
  // message instead of a raw Postgres constraint error.
  if (!(APPOINTMENT_STATUSES as readonly string[]).includes(status))
    return { ok: false, error: `Status must be one of: ${APPOINTMENT_STATUSES.join(", ")}.` };
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("appointments")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  // Cancelling/completing an appointment kills any live "pick a time" link, so a
  // customer tap can't resurrect a closed appointment.
  if (status === "cancelled" || status === "completed") {
    await supabase
      .from("schedule_proposals")
      .update({ status: "cancelled" })
      .eq("appointment_id", id)
      .eq("status", "pending");
  }
  // Google reconcile (fire-safe): cancel deletes the event; other statuses re-push.
  await pushCalendarItem("appointment", id);
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true };
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
  if (error) return { ok: false, error: error.message };
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
    .select("id, title, customer_id, location, job_id, starts_at")
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
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

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
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day shows today's appointments — keep it in sync
  revalidatePath("/inspections"); // the Sales → Inspections tab reads appointments too
  return { ok: true };
}
