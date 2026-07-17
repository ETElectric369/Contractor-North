/**
 * THE one writer for a "propose times → customer picks" scheduling proposal:
 * a TENTATIVE appointment (status 'proposed') + a schedule_proposals row whose
 * token backs the public /pick/[token] page. Extracted from the office
 * createAppointmentProposal FormData action so every entry point creates the
 * pair the exact same way:
 *   • the appointment modal's "Propose Times" (staff, FormData wrapper)
 *   • a lead's "Schedule inspection → Let them pick" (staff, plain args)
 * (A third, PUBLIC service-client caller existed in v498; cn-v499 removed it —
 * the public button now only flags the lead + pings the office. Both remaining
 * callers run under a staff session, so the set_org_id trigger stamps org_id.)
 *
 * Dedup doctrine (from the original action): re-proposing the same context must
 * WITHDRAW the still-pending prior link (cancel proposal + its tentative
 * appointment), or every retry orphans a live pick-a-time link a customer could
 * tap later and resurrect a superseded booking. Keyed by inquiry_id first (a
 * lead has at most ONE live pick link, any title), else job/customer + type +
 * title (the original office-modal behavior, unchanged).
 *
 * NOT a "use server" file — callers are server actions that wrap it with their
 * own auth (requireStaff) or public rigor (honeypot/clamps/org-by-handle).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProposalSlot {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
}

/** Normalize untrusted slot input: real-looking dates only, default 08:00, max 3. */
export function cleanSlots(raw: unknown, defaultTime = "08:00"): ProposalSlot[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter((s: any) => /^\d{4}-\d{2}-\d{2}$/.test(s?.date ?? ""))
    .map((s: any) => ({
      date: String(s.date),
      time: /^\d{2}:\d{2}/.test(s?.time ?? "") ? String(s.time).slice(0, 5) : defaultTime,
    }))
    .slice(0, 3);
}

export interface ProposalInput {
  type: string;
  title: string;
  slots: ProposalSlot[];
  /** Optional arrival-window note shown on the public pick page ("8–10 AM"). */
  timeNote?: string | null;
  jobId?: string | null;
  customerId?: string | null;
  /** Lead provenance — stamps appointments.inquiry_id and switches dedup to per-lead. */
  inquiryId?: string | null;
  location?: string | null;
  notes?: string | null;
  assignedTo?: string | null;
  /** The staff caller's user id — stored on appointments/schedule_proposals.created_by. */
  createdBy?: string | null;
  /** The tentative first-slot instant, already resolved to UTC by the caller
   *  (browser ISO or tz-helper) — this module stays timezone-agnostic. */
  startsAtIso?: string | null;
}

export type ProposalResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

export async function createProposalCore(
  supabase: SupabaseClient,
  input: ProposalInput,
): Promise<ProposalResult> {
  const slots = cleanSlots(input.slots);
  if (!slots.length) return { ok: false, error: "Add at least one date option." };
  const title = String(input.title ?? "").trim();
  if (!title) return { ok: false, error: "Title is required." };

  // Withdraw any still-pending prior proposal for the same context (see doctrine above).
  // (Audit 2026-07-16: appointments.inquiry_id (0129) verified written AND read exactly as
  // promised — this dedup filter, the public pick-a-time confirm, and /quotes/new's lead
  // backlink recovery all consume it. Live rows exist. Not a written-never-read column.)
  let priorQuery = null;
  if (input.inquiryId) {
    priorQuery = supabase
      .from("appointments")
      .select("id")
      .eq("status", "proposed")
      .eq("inquiry_id", input.inquiryId);
  } else {
    const dedupKey = input.jobId
      ? { col: "job_id" as const, val: input.jobId }
      : input.customerId
        ? { col: "customer_id" as const, val: input.customerId }
        : null;
    if (dedupKey) {
      priorQuery = supabase
        .from("appointments")
        .select("id")
        .eq("status", "proposed")
        .eq("type", input.type)
        .eq("title", title)
        .eq(dedupKey.col, dedupKey.val);
    }
  }
  if (priorQuery) {
    const { data: prior } = await priorQuery;
    const priorIds = (prior ?? []).map((a: { id: string }) => a.id);
    if (priorIds.length) {
      await supabase
        .from("schedule_proposals")
        .update({ status: "cancelled" })
        .in("appointment_id", priorIds)
        .eq("status", "pending");
      await supabase
        .from("appointments")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .in("id", priorIds);
    }
  }

  const { data: appt, error: aErr } = await supabase
    .from("appointments")
    .insert({
      type: input.type,
      title,
      starts_at: input.startsAtIso ?? null,
      ends_at: null,
      job_id: input.jobId ?? null,
      customer_id: input.customerId ?? null,
      inquiry_id: input.inquiryId ?? null,
      location: input.location ?? null,
      notes: input.notes ?? null,
      assigned_to: input.assignedTo ?? null,
      status: "proposed",
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single();
  if (aErr || !appt) return { ok: false, error: aErr?.message ?? "Could not create the appointment." };

  const timeNote = String(input.timeNote ?? "").trim().slice(0, 120) || null;
  const { data: prop, error: pErr } = await supabase
    .from("schedule_proposals")
    .insert({
      appointment_id: appt.id,
      dates: slots,
      time_note: timeNote,
      created_by: input.createdBy ?? null,
    })
    .select("token")
    .single();
  if (pErr || !prop) return { ok: false, error: pErr?.message ?? "Could not create the pick-a-time link." };

  return { ok: true, token: prop.token as string };
}
