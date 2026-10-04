"use server";

import { revalidatePath } from "next/cache";
import { orgTodayStr } from "@/lib/billing-pipeline";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import {
  AUTHORITY_MAX,
  INSPECTION_RESULTS,
  WHY_MAX,
  INSPECTION_WINDOWS,
  INSPECTOR_MAX,
  MAX_INSPECTION_POSITION,
  PERMIT_INSPECTION_COLUMNS,
  nextPosition,
  permitInspectionStand,
  resultLabel,
  standLine,
  type InspectionResult,
  type InspectionStand,
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
 *
 * SO DOES TAKING A BOOKING OFF, because it can finish a permit too — and both doors close it through
 * the SAME function (`closeThePermit`), which is also the only thing that ever writes the permit's own
 * status from a visit. Two copies of "when does a permit close" is how one of them goes stale.
 */

export type InspectionSaved = { ok: boolean; error?: string; message?: string };

/** What a recorded result hands back: what is true now, and the one next step, with its door. */
export type InspectionRecorded = InspectionSaved & {
  /** The permit has no inspection left outstanding and the last one passed: the job is done. */
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

/**
 * CLOSE WHAT IT CAME FROM — the permit itself, and never silently. ONE RULE, ONE PLACE: every door
 * that changes a permit's visits reads this, so a pass and a removed booking can never leave the
 * permit saying two different things.
 *
 * `passed` and `failed` ARE THE ONLY TWO WORDS THE CHAIN WRITES, so they are the only two it may take
 * back. Every other status — not submitted, applied, issued, inspection scheduled, closed — is the
 * office's word for where the paperwork is, and not this visit's to overwrite. What the rows say:
 *
 *   clear                       passed   nothing is outstanding and the last visit passed
 *   a visit FAILED, another owed failed   isOpenPermit counts a failure most of all
 *   anything else               —        the rows say nothing. A CANCELLED visit is not a failure:
 *                                       the permit is simply still open, waiting for another day.
 *
 * AND IT TAKES ITS OWN WORDS BACK. A retry that passed with the utility still to come used to leave
 * the permit reading red `failed` forever, beside a card saying "Waiting on Liberty Utilities"; a
 * permit the chain closed `passed` whose last visit was then corrected to cancelled stayed green
 * beside "book another visit". Either way the rows have moved on, so the permit goes back to `issued`.
 *
 * Returns the sentence to say when the status would not move — the visit IS recorded, so that is never
 * a failure of the whole deed, but it is never silent either.
 */
async function closeThePermit(
  supabase: any,
  orgId: string,
  permit: { id: string; status: string | null },
  /** Null when the permit's rows could not be re-read: then nothing is derived from them. */
  stand: InspectionStand | null,
  /** This very write said a visit failed — true even when the re-read was lost. */
  failedNow: boolean,
): Promise<string | null> {
  // What the rows say the permit's own word is, or null for "they don't say".
  let rowsSay: string | null = null;
  if (!stand) rowsSay = failedNow ? "failed" : null;
  else if (stand.state === "clear") rowsSay = "passed";
  else if (stand.state === "needs_another" && stand.row?.result === "failed") rowsSay = "failed";
  // The rows say nothing, so the only thing left to write is taking back a word the chain itself wrote.
  const wroteItself = permit.status === "passed" || permit.status === "failed";
  const next = rowsSay ?? (stand && wroteItself ? "issued" : null);
  if (!next || permit.status === next) return null;
  const { data, error } = await supabase
    .from("permits")
    .update({ status: next })
    .eq("id", permit.id)
    .eq("org_id", orgId)
    .select("id");
  if (error || !data?.length) return `The visit is recorded, but the permit still reads "${permit.status ?? "open"}" — set it by hand.`;
  return null;
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

  // FILL, NEVER OVERWRITE — the same rule the result door follows. A key the caller never sent must
  // not blank what a result recorded: the booking form sends only who / which day / which part of the
  // day, so moving a passed visit by one day, or fixing the spelling of the town, used to wipe the
  // inspector who came and any notes on it. An INSERT leaves those columns at their NULL default,
  // which is what a brand new visit has, so one patch serves both doors.
  const fields: Record<string, unknown> = { authority, scheduled_for: when, scheduled_window: win };
  if (input.inspector !== undefined) fields.inspector = text(input.inspector, INSPECTOR_MAX);
  if (input.notes !== undefined) fields.notes = text(input.notes, 2000);

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
  /** WHY IT FAILED. Required on a failure, ignored otherwise (Erik, 2026-10-03). */
  why?: string | null;
}): Promise<InspectionRecorded> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const supabase = ctx.supabase;

  if (!isResult(input.result)) return { ok: false, error: "Pick the inspection status: passed, failed or cancelled." };
  const on = day(input.result_on);
  if (!on) return { ok: false, error: "Put the day they came on it — a result needs a date." };
  // A FAILURE SAYS WHY, AND THE SERVER IS WHERE THAT HOLDS (Erik, 2026-10-03: "Inspection Status:
  // Passed or Failed (if failed, why)"). A failed inspection with no reason is a visit you have to
  // make again just to learn what it was for, and the correction cannot be priced or ordered. The
  // form disables Save without it; this refuses it, because a form is a convention and a door is not.
  const why = text(input.why, WHY_MAX);
  if (input.result === "failed" && !why) {
    return { ok: false, error: "Say why it failed — what has to be put right before they come back. Nothing was saved." };
  }

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
  // The reason rides with the result it explains. Written on a failure; on a pass or a cancellation
  // an earlier failure's reason is LEFT ALONE, because it is the history of why they came back.
  if (why) patch.notes = why;
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
  // just written: another screen may have added the utility's visit while this one was open.
  //
  // AGAINST THE COMPANY'S TODAY, like every other door (the card, the job's own line, Needs You,
  // Nort). The day they CAME is not a clock: writing up Thursday's visit on Friday read the verdict
  // as if it were still Thursday, so the sentence said "Waiting on Liberty Utilities — Thu Oct 15"
  // while the card beside it, on the real today, said "Liberty Utilities was booked Oct 15 — say how
  // it went". Two contradictory statements on one card. One read of the org's timezone is the price.
  //
  // AND A LOST READ CLAIMS NOTHING. "No rows" reads as a permit with nothing outstanding, so the
  // chain skipped closing it, said no next step, and still reported success: the permit stayed open
  // and counted open with nobody told. The visit IS written, so this is never a failure of the deed —
  // it is a sentence that says what could not be checked.
  const after = await inspectionsOf(supabase, ctx.orgId, String(row.permit_id));
  const stand = "error" in after ? null : permitInspectionStand(after.rows, await orgTodayStr(supabase));
  const jobHref = got.permit.job_id ? `/jobs/${got.permit.job_id}?tab=permits` : null;

  // ── AND CLOSE WHAT IT CAME FROM ────────────────────────────────────────────────────────────────
  const closing = await closeThePermit(supabase, ctx.orgId, got.permit, stand, input.result === "failed");

  rev(got.permit.job_id);

  const number = got.permit.permit_number ? ` on permit ${got.permit.permit_number}` : "";
  const said = input.result === "passed" ? "passed" : input.result === "failed" ? "failed" : "was cancelled";
  const head = `${row.authority} ${said}`;
  if (!stand) {
    return {
      ok: true,
      clear: false,
      message: [`${head}.`, "The permit's other inspections couldn't be read just now, so it wasn't re-checked or closed — reload the job.", closing]
        .filter(Boolean)
        .join(" "),
      next: null,
      href: jobHref,
    };
  }
  if (stand.state === "clear") {
    return {
      ok: true,
      clear: true,
      // NOT "the meter is on": that is a fact about an electrical job whose last authority is the
      // utility, and this app also serves decks, plumbing and painting. 0378's own answer to "when is
      // the job done?" is this one, and it is true in every trade.
      message: [`${head}. Every inspection${number} has passed — the job is done.`, closing].filter(Boolean).join(" "),
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

/**
 * TAKE A BOOKING OFF A PERMIT — the wrong authority, or a visit that was never going to happen.
 *
 * A VISIT THAT HAPPENED IS A RESULT, NEVER A DELETION, AND THIS DOOR NOW HOLDS THAT LINE. It was
 * prose only: the action never looked at `result`, so one tap erased the day somebody came, who came
 * and how it went — and the visit in front of the next authority with it, leaving the utility reading
 * as unblocked with nothing having passed. Changing what it says is the other door ("Change It").
 *
 * AND TAKING THE LAST OPEN ONE OFF CAN FINISH THE PERMIT. Removing the utility's booking from a permit
 * whose town visit passed leaves `clear` — the card went green "every inspection passed" while the
 * permit itself stayed `issued` and counted open. One door opens, the last one closes: the same rule
 * that closes a permit on the last pass runs here, and the sentence says what became true.
 */
export async function deleteInspection(id: string, permitId: string): Promise<InspectionRecorded> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const got = await permitFor(ctx.supabase, ctx.orgId, permitId);
  if ("error" in got) return { ok: false, error: got.error };

  const { data, error: readErr } = await ctx.supabase
    .from("permit_inspections")
    .select("id, authority, result")
    .eq("id", id)
    .eq("permit_id", permitId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: dbError(readErr) };
  const mine = data as { authority?: string | null; result?: string | null } | null;
  if (!mine) return { ok: false, error: "That inspection isn't here any more." };
  const who = String(mine.authority ?? "").trim() || "That";
  const happened = resultLabel(mine.result);
  if (happened) {
    return {
      ok: false,
      error: `That visit already happened — ${who} ${happened.toLowerCase()}. Removing it would erase who came and what they said. Use Change It to fix it.`,
    };
  }

  const { data: gone, error } = await ctx.supabase
    .from("permit_inspections")
    .delete()
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) return { ok: false, error: "Nothing was removed — it had already gone." };

  // What the permit stands at now, read against the company's today like every other door. A lost
  // read claims nothing: the booking IS off, and the sentence says the permit was not re-checked.
  const after = await inspectionsOf(ctx.supabase, ctx.orgId, permitId);
  const stand = "error" in after ? null : permitInspectionStand(after.rows, await orgTodayStr(ctx.supabase));
  const closing = await closeThePermit(ctx.supabase, ctx.orgId, got.permit, stand, false);
  rev(got.permit.job_id);

  const head = `${who} inspection removed.`;
  return {
    ok: true,
    clear: stand?.state === "clear",
    message: [head, stand ? null : "The permit's other inspections couldn't be read just now, so it wasn't re-checked — reload the job.", closing]
      .filter(Boolean)
      .join(" "),
    next: stand ? standLine(stand) : null,
    href: got.permit.job_id ? `/jobs/${got.permit.job_id}?tab=permits` : null,
  };
}
