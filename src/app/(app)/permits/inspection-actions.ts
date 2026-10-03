"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import {
  AUTHORITY_MAX,
  INSPECTION_RESULTS,
  INSPECTION_WINDOWS,
  INSPECTOR_MAX,
  MAX_INSPECTION_POSITION,
  PERMIT_INSPECTION_COLUMNS,
  nextPosition,
  permitInspectionStand,
  standLine,
  type InspectionResult,
  type InspectionWindow,
  type PermitInspection,
} from "@/lib/permit-inspections";

/**
 * BOOKING A PERMIT'S INSPECTIONS, AND SAYING HOW THEY WENT (0378).
 *
 * Three doors and no more: save a booking, say how it went, take a booking off. The RULE they all
 * read is lib/permit-inspections — none of them carries a second copy of the order, the gate or the
 * words.
 *
 * ── THE GATE DOES NOT GUARD THESE DOORS, ON PURPOSE ──────────────────────────────────────────────
 * Both of the October job's inspections were booked for the same morning, by phone, days before the
 * town had been anywhere. A door that refused to write down a booking because the one in front had
 * not passed yet would make the feature useless for the exact job it was built for. The gate decides
 * what the app NAGS about and what it calls ready (lib/permit-inspections, read by Needs You and by
 * the card) — never what a person is allowed to write down.
 *
 * ── NOTHING SILENT ───────────────────────────────────────────────────────────────────────────────
 * Every write ends with .select("id") and a zero-row answer is said out loud: on a cross-org or
 * deleted id, RLS hands back a 204 that reads exactly like success, and "saved" would be a lie.
 *
 * ── ONE DOOR OPENS, THE LAST ONE CLOSES (Erik, 2026-10-03) ───────────────────────────────────────
 * A pass is not a row update. `recordInspectionResult` ATTACHES the visit to its permit (the row
 * carries permit_id, the permit carries job_id: both ways), CLOSES what it came from (the last pass
 * closes the PERMIT — status passed; a failure says failed), and CARRIES FORWARD what was captured:
 * the sentence it hands back names the next authority and where to go, and the pages that show the
 * job, its inspections and Needs You are all re-read. Doing one of the three would be the defect.
 */

export type InspectionSaved = { ok: boolean; error?: string; message?: string };

/** What a recorded result hands back: what is true now, and the one next step, with its door. */
export type InspectionRecorded = InspectionSaved & {
  /** The permit has no inspection left outstanding and the last one passed: the meter is on. */
  clear?: boolean;
  /** The next thing, in plain words ("Liberty Utilities inspection to book"), or null when done. */
  next?: string | null;
  /** Where that next thing is answered. */
  href?: string | null;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string | null => {
  const s = String(v ?? "").slice(0, 10);
  return YMD.test(s) && Number.isFinite(Date.parse(`${s}T12:00:00Z`)) ? s : null;
};
const isWindow = (v: unknown): v is InspectionWindow => INSPECTION_WINDOWS.some(([k]) => k === v);
const isResult = (v: unknown): v is InspectionResult => INSPECTION_RESULTS.some(([k]) => k === v);
const text = (v: unknown, max: number): string | null => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};

/** Everything a door needs about the permit it is writing against: that it is this company's, and
 *  the job it hangs on (so the right page is re-read). */
async function permitFor(supabase: any, orgId: string, permitId: string) {
  const { data, error } = await supabase
    .from("permits")
    .select("id, permit_number, job_id, status")
    .eq("id", permitId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return { error: dbError(error) } as const;
  if (!data) return { error: "That permit isn't here any more." } as const;
  return { permit: data as { id: string; permit_number: string | null; job_id: string | null; status: string | null } } as const;
}

/** The permit's visits as they stand now (the gate and every word are worked out from these). */
async function inspectionsOf(supabase: any, orgId: string, permitId: string) {
  const { data, error } = await supabase
    .from("permit_inspections")
    .select(PERMIT_INSPECTION_COLUMNS)
    .eq("org_id", orgId)
    .eq("permit_id", permitId)
    .order("position", { ascending: true });
  if (error) return { error: dbError(error) } as const;
  return { rows: (data ?? []) as PermitInspection[] } as const;
}

/** The job page, the permits tab, and Needs You: everything that shows who still has to come. */
function rev(jobId: string | null | undefined) {
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/jobs");
  revalidatePath("/planner"); // Needs You reads the stands: a booking or a pass changes the list
}

export interface InspectionInput {
  /** Changing a booking that already exists (the day moved, the name was wrong); absent: a new one. */
  id?: string | null;
  permit_id: string;
  authority: string;
  scheduled_for?: string | null;
  scheduled_window?: string | null;
  inspector?: string | null;
  notes?: string | null;
}

/**
 * BOOK ONE, OR MOVE ONE. Who is coming, which day, and morning / afternoon / all day — which is all
 * an inspector ever gives you. A new one goes on the END of the order (nextPosition): the authorities
 * come in the order they were written down, which is the order they come in on site.
 */
export async function saveInspection(input: InspectionInput): Promise<InspectionSaved> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const supabase = ctx.supabase;

  const authority = text(input.authority, AUTHORITY_MAX);
  if (!authority) return { ok: false, error: "Say who is coming — the town, the county or the utility." };
  const when = day(input.scheduled_for);
  if (input.scheduled_for && !when) return { ok: false, error: "That day didn't read as a date. Pick it from the calendar." };
  const win = isWindow(input.scheduled_window) ? input.scheduled_window : null;
  // A part of a day with no day is not a booking. Said here rather than letting 0378's check
  // constraint answer in SQL nobody can read.
  if (win && !when) return { ok: false, error: "Pick the day as well — a morning needs a date on it." };

  const got = await permitFor(supabase, ctx.orgId, input.permit_id);
  if ("error" in got) return { ok: false, error: got.error };

  const fields = {
    authority,
    scheduled_for: when,
    scheduled_window: win,
    inspector: text(input.inspector, INSPECTOR_MAX),
    notes: text(input.notes, 2000),
  };

  if (input.id) {
    const { data, error } = await supabase
      .from("permit_inspections")
      .update(fields)
      .eq("id", input.id)
      .eq("org_id", ctx.orgId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "Nothing was saved — that inspection was removed from another screen." };
    rev(got.permit.job_id);
    return { ok: true, message: "Inspection saved" };
  }

  const have = await inspectionsOf(supabase, ctx.orgId, input.permit_id);
  if ("error" in have) return { ok: false, error: have.error };
  const position = nextPosition(have.rows);
  if (have.rows.some((r) => Number(r.position) === position)) {
    // 0378 keeps one visit per place in the order, and the ceiling is 20.
    return { ok: false, error: `This permit already has ${MAX_INSPECTION_POSITION} inspections on it.` };
  }

  const { data, error } = await supabase
    .from("permit_inspections")
    .insert({ permit_id: input.permit_id, position, ...fields, created_by: ctx.userId })
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Nothing was saved. Try it again." };
  rev(got.permit.job_id);
  return { ok: true, message: when ? `${authority} booked` : `${authority} added — book a day when you have one` };
}

/**
 * WHAT HAPPENED: passed, failed or cancelled, who came, and the day.
 *
 * THE DAY IS NOT OPTIONAL. 0378 refuses a result with no day (a day without a result is a visit
 * nobody has written up; a result without a day is a fact with no date), so this says so in words a
 * person can act on instead of handing back a constraint name.
 *
 * AND THEN THE CHAIN. The pass that ends it closes the permit and says what is true now and what is
 * next — never a row quietly updated.
 */
export async function recordInspectionResult(input: {
  id: string;
  result: string;
  result_on?: string | null;
  inspector?: string | null;
}): Promise<InspectionRecorded> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const supabase = ctx.supabase;

  if (!isResult(input.result)) return { ok: false, error: "Say how it went: passed, failed or cancelled." };
  const on = day(input.result_on);
  if (!on) return { ok: false, error: "Put the day they came on it — a result needs a date." };

  const { data: row, error: readErr } = await supabase
    .from("permit_inspections")
    .select("id, permit_id, authority, position")
    .eq("id", input.id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  if (!row) return { ok: false, error: "That inspection isn't here any more." };

  const got = await permitFor(supabase, ctx.orgId, String(row.permit_id));
  if ("error" in got) return { ok: false, error: got.error };

  const patch: Record<string, unknown> = { result: input.result, result_on: on };
  const who = text(input.inspector, INSPECTOR_MAX);
  if (who) patch.inspector = who; // FILL, NEVER OVERWRITE: a blank box never erases who came
  const { data: saved, error } = await supabase
    .from("permit_inspections")
    .update(patch)
    .eq("id", input.id)
    .eq("org_id", ctx.orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!saved?.length) return { ok: false, error: "Nothing was saved — that inspection was removed from another screen." };

  // ── CARRY IT FORWARD ───────────────────────────────────────────────────────────────────────────
  // Read the permit's rows back and ask the one rule where it stands now. Never guess from the row
  // just written: another screen may have added the utility's visit while this one was open. The day
  // the verdict is read against is the day they CAME — the day this sentence is about — so no second
  // read of the company's timezone stands between pressing the button and being told what is true.
  const after = await inspectionsOf(supabase, ctx.orgId, String(row.permit_id));
  const rows = "error" in after ? [] : after.rows;
  const stand = permitInspectionStand(rows, on);
  const jobHref = got.permit.job_id ? `/jobs/${got.permit.job_id}?tab=permits` : null;

  // ── AND CLOSE WHAT IT CAME FROM ────────────────────────────────────────────────────────────────
  // The permit itself is the door this visit came through. The last pass closes it (status passed, so
  // the job's Permits tab stops counting it open — badges show only what is OPEN); a failure says
  // failed, which isOpenPermit counts most of all. Any other state leaves the permit's own status
  // alone: it is the office's word for where the paperwork is, not this visit's to overwrite.
  let closing: string | null = null;
  const nextStatus = stand.state === "clear" ? "passed" : input.result === "failed" ? "failed" : null;
  if (nextStatus && got.permit.status !== nextStatus) {
    const { data: done, error: statusErr } = await supabase
      .from("permits")
      .update({ status: nextStatus })
      .eq("id", got.permit.id)
      .eq("org_id", ctx.orgId)
      .select("id");
    // The visit IS recorded, so this is never a failure of the whole deed — but it is never silent
    // either: the sentence says the permit's own status did not move, so nobody believes it did.
    if (statusErr || !done?.length) closing = `The visit is recorded, but the permit still reads "${got.permit.status ?? "open"}" — set it by hand.`;
  }

  rev(got.permit.job_id);

  const number = got.permit.permit_number ? ` on permit ${got.permit.permit_number}` : "";
  const said = input.result === "passed" ? "passed" : input.result === "failed" ? "failed" : "was cancelled";
  const head = `${row.authority} ${said}`;
  if (stand.state === "clear") {
    return {
      ok: true,
      clear: true,
      message: [`${head}. Every inspection${number} has passed — the meter is on and the job is done.`, closing].filter(Boolean).join(" "),
      next: "Finish the job and bill it",
      href: got.permit.job_id ? `/jobs/${got.permit.job_id}` : null,
    };
  }
  const line = standLine(stand);
  return {
    ok: true,
    clear: false,
    message: [`${head}.`, closing].filter(Boolean).join(" "),
    next: line,
    href: jobHref,
  };
}

/** Take a booking off a permit — the wrong authority, or a visit that was never going to happen.
 *  A visit that HAPPENED is a result (passed / failed / cancelled), never a deletion. */
export async function deleteInspection(id: string, permitId: string): Promise<InspectionSaved> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const got = await permitFor(ctx.supabase, ctx.orgId, permitId);
  if ("error" in got) return { ok: false, error: got.error };
  const { data, error } = await ctx.supabase
    .from("permit_inspections")
    .delete()
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "Nothing was removed — it had already gone." };
  rev(got.permit.job_id);
  return { ok: true, message: "Inspection removed" };
}
