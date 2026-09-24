"use server";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";

import { revalidatePath } from "next/cache";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { payPeriodBounds, todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import {
  aggregatePayrollEntries,
  balanceForPerson,
  dayPhrase,
  firstName,
  isPayMethod,
  lockRefusalReason,
  ownerWagesRefusal,
  paymentSentence,
  sayMoney,
  sumLockedGross,
  toPayPaymentRow,
  voidSentence,
  type PayMethod,
  type PayPaymentRow,
  type PersonBalance,
} from "@/lib/payroll-math";
import { summarizeMileage } from "@/lib/mileage-math";

export type Result = { ok: boolean; error?: string };

async function staffClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." as const };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!me || !isStaffRole(me.role)) return { error: "Not allowed." as const };
  return { supabase, userId: user.id };
}

async function periodInstants(supabase: any, periodStart: string, periodEnd: string) {
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings(org?.settings).timezone;
  return { startIso: tzDayStartUtc(periodStart, tz).toISOString(), endIso: tzDayStartUtc(periodEnd, tz).toISOString(), tz };
}

/** An open entry inside the period means its hours/miles are still moving —
 *  settling around it silently under-pays, so both settle actions refuse. */
async function openEntryError(supabase: any, profileId: string, startIso: string, endIso: string) {
  const { data: open } = await supabase
    .from("time_entries")
    .select("id, profiles(full_name)")
    .eq("profile_id", profileId)
    .is("clock_out", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso)
    .limit(1);
  if (!open?.length) return null;
  const name = (open[0] as any).profiles?.full_name ?? "This person";
  return `${name} has an open entry inside this period — close it on Timecards first.`;
}

/** A 0193 auto-closed entry inside the period is an UNREVIEWED day: the trigger closed a
 *  forgotten shift at clock_out = clock_in (zero hours, zero pay) when the next punch came
 *  in. It reads as a normal closed row, so the open-entry check above can't see it — and
 *  once Mark Paid stamps paid_at on it, updateTimeEntry refuses the fix ("Undo on Payroll
 *  first"). Refuse the same way an open entry does (audit v921); editing the entry on
 *  Timecards clears auto_closed_reason and unblocks the period. */
async function autoClosedEntryError(supabase: any, profileId: string, startIso: string, endIso: string) {
  const { data: rows } = await supabase
    .from("time_entries")
    .select("id, profiles(full_name)")
    .eq("profile_id", profileId)
    .not("auto_closed_reason", "is", null)
    .is("paid_at", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso)
    .limit(1);
  if (!rows?.length) return null;
  const name = (rows[0] as any).profiles?.full_name ?? "This person";
  return `${name} has an auto-closed entry inside this period — the system closed it, so nobody has checked those hours. Fix it on Timecards first.`;
}

/** Lock an employee's UNPAID closed hours in a pay period as BASE-pay paid, and
 *  snapshot a kind='base' run for the accountant export. BASE ONLY — miles are
 *  not touched here; mileage settles separately via settleMileage with a
 *  human-stated amount. Idempotent: only touches unpaid entries, so a late
 *  entry paid later simply adds a second kind='base' run (consumers sum). */
export async function markPeriodPaid(input: {
  profileId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD (exclusive)
}): Promise<Result> {
  const ctx = await staffClient();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

  // The person's rate, and whether he is the owner (0286: paid by owner's draw, so there is no
  // wage period to lock). Read FIRST, so an owner is refused before any other check or write.
  const { data: prof } = await supabase
    .from("profile_pay")
    .select("hourly_rate, full_name, paid_by_draw")
    .eq("id", input.profileId)
    .maybeSingle();
  if ((prof as any)?.paid_by_draw === true) return { ok: false, error: ownerWagesRefusal((prof as any)?.full_name) };
  const rate = Number(prof?.hourly_rate ?? 0);

  const { startIso, endIso, tz } = await periodInstants(supabase, input.periodStart, input.periodEnd);
  const openErr = await openEntryError(supabase, input.profileId, startIso, endIso);
  if (openErr) return { ok: false, error: openErr };
  const autoErr = await autoClosedEntryError(supabase, input.profileId, startIso, endIso);
  if (autoErr) return { ok: false, error: autoErr };

  const { data: entries } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out, lunch_minutes, rate_override")
    .eq("profile_id", input.profileId)
    .eq("status", "closed")
    .is("paid_at", null)
    .not("clock_out", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso);
  const list = (entries ?? []) as any[];
  if (!list.length) return { ok: false, error: "No unpaid hours in this period." };

  const ids = list.map((e) => e.id);
  // CLAIM ONLY STILL-UNPAID ROWS (audit v921): two staff (or two taps) both read the unpaid list
  // before either wrote, so both stamped and both inserted a payroll_runs row -> doubled gross in
  // the accountant export. Filtering the UPDATE on paid_at IS NULL + row-checking means the loser
  // stamps nothing and bails before inserting a second run.
  const { data: stamped, error: upErr } = await supabase
    .from("time_entries")
    .update({ paid_at: new Date().toISOString() })
    .in("id", ids)
    .is("paid_at", null)
    .select("id");
  if (upErr) return { ok: false, error: upErr.message };
  if (!stamped?.length) return { ok: false, error: "Those hours were just marked paid by someone else." };
  // Compensate only what THIS call stamped. Clearing the whole read list would un-pay a row a
  // concurrent overlapping period had already stamped and snapshotted, and its run row would
  // stay standing — the doubled gross again, from the other side.
  const stampedIds = (stamped as { id: string }[]).map((r) => r.id);

  // Freeze the snapshot's hours+gross via the EXACT function the approval screen renders
  // (aggregatePayrollEntries) — one code path, so the number the accountant exports can't
  // drift from what the owner approved. One profile and nothing carries paid_at (the query
  // filtered on it and doesn't even select it), so these roll into a single row's UNPAID
  // bucket; pass the base rate as the fallback because this query doesn't join profiles.
  // Miles aren't selected here, so the aggregator's mileage side reads 0 — exactly right,
  // this is the base bucket only.
  //
  // PRICE WHAT WAS CLAIMED, NOT WHAT WAS READ. This used to run ABOVE the claim, on the whole
  // read list, and a PARTIAL claim then froze a gross covering hours somebody else's lock had
  // already stamped AND already snapshotted. Two surfaces stamp paid_at now, not one — the
  // Payroll button and applyLocks on every recordPayment — and the pay anchor moving in
  // Settings is all it takes for their two windows to overlap. balanceForPerson sums EVERY
  // kind='base' run into `earned` forever and nothing ever reconciles a frozen run back to the
  // entries, so that overlap is a permanent overstatement of what Erik owes Brian.
  //
  // Re-pricing beats settleMileage's refuse-and-roll-back sibling here because this gross is
  // COMPUTED, not a figure a human typed at a smaller set of miles: a smaller claimed set is
  // simply a smaller TRUE gross, still covered in full by the credit, and applyLocks re-reads
  // the locked total after every lock (lockedGrossCents below) so the walking credit stays
  // honest for the next period. Refusing here would dead-end a payment that did nothing wrong.
  const claimed = new Set(stampedIds);
  const [agg] = aggregatePayrollEntries(
    list.filter((e) => claimed.has(e.id)),
    tz,
    rate,
  );
  const hours = agg?.unpaidHours ?? 0;
  const gross = agg?.unpaidGross ?? 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  // org_id is stamped by the set_org_id trigger. Base bucket only: no miles, no
  // mileage dollars — those live on kind='mileage' rows, human-stated.
  const { error: runErr } = await supabase.from("payroll_runs").insert({
    profile_id: input.profileId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    kind: "base",
    hours: r2(hours),
    rate, // base rate, for reference — gross below is summed per entry (honors overrides)
    gross: r2(gross),
    created_by: userId,
  });
  if (runErr) {
    // Compensate: entries must not stay locked without the accountant snapshot.
    // Clear the just-stamped ids so the period is re-payable; if even that fails,
    // surface BOTH errors — never report ok on a half-write.
    // Row-checked like its mileage sibling: a release that writes no rows leaves the hours locked
    // as paid with no payroll run behind them, which nothing on screen can show.
    const { data: freed, error: compErr } = await supabase
      .from("time_entries")
      .update({ paid_at: null })
      .in("id", stampedIds)
      .select("id");
    const stillLocked = !!compErr || !freed?.length;
    if (stillLocked) {
      reportError("payroll:markPeriodPaid:compensate", compErr ?? new Error("hours release wrote no rows"), {
        profileId: input.profileId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        stampedIds,
      });
    }
    return {
      ok: false,
      error: stillLocked
        ? `Payroll record failed (${runErr.message}) and unlocking the entries didn't go through${compErr ? ` (${compErr.message})` : ""} — those hours are still marked paid. Check this period on Timecards before retrying.`
        : `Payroll record failed — nothing was marked paid. ${runErr.message}`,
    };
  }

  revalidatePath("/payroll");
  revalidatePath("/timecards");
  return { ok: true };
}

/** Undo: re-open an employee's BASE-paid hours in a period (and drop only the
 *  kind='base' run snapshots) — for a mis-click before the check is actually
 *  cut. A mileage settlement, if any, is untouched (unsettleMileage mirrors). */
export async function unmarkPeriodPaid(input: {
  profileId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<Result> {
  const ctx = await staffClient();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase } = ctx;

  const { startIso, endIso } = await periodInstants(supabase, input.periodStart, input.periodEnd);

  // THE SILENT-WRITE LAW on a money record: this delete's result was discarded, so a failed
  // delete left the run row standing while the entries were already un-paid — and re-paying
  // then doubled the accountant's gross. Read the result; say so if it didn't land.
  // THE ROWS, NOT JUST THE ERROR (audit v921): the comment above promised this check and the
  // code only ever read `error`, so a zero-row delete (period bounds moved since Mark Paid, so
  // period_start/end no longer match the stored run) still returned ok. The delete now runs
  // FIRST — a period with no matching run is refused before any hours are un-paid.
  const { data: runs, error: runErr } = await supabase
    .from("payroll_runs")
    .delete()
    .eq("profile_id", input.profileId)
    .eq("period_start", input.periodStart)
    .eq("period_end", input.periodEnd)
    .eq("kind", "base")
    .select("*");
  if (runErr) return { ok: false, error: dbError(runErr) };
  // Zero rows deleted is only DANGEROUS when a run for these hours survives under different
  // keys (the pay anchor moved after Mark Paid): un-pay around it and the re-mark inserts a
  // SECOND run — the doubled gross. Name that record and refuse. When there is genuinely no
  // record at all, un-paying can't double anything, so it goes ahead rather than dead-ending
  // hours that updateTimeEntry then refuses to fix.
  if (!runs?.length) {
    const { data: stale } = await supabase
      .from("payroll_runs")
      .select("period_start, period_end")
      .eq("profile_id", input.profileId)
      .eq("kind", "base")
      .lt("period_start", input.periodEnd)
      .gt("period_end", input.periodStart)
      .limit(1);
    if (stale?.length) {
      const r = stale[0] as { period_start: string; period_end: string };
      return {
        ok: false,
        error: `These hours are filed under the pay period ${r.period_start} to ${r.period_end}, not this one — the pay schedule changed after they were marked paid. Put the old pay schedule back in Settings, undo there, then change it again.`,
      };
    }
  }

  const { data: cleared, error } = await supabase
    .from("time_entries")
    .update({ paid_at: null })
    .eq("profile_id", input.profileId)
    .eq("status", "closed")
    .not("paid_at", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso)
    .select("id");
  if (error) {
    // Same compensation shape as markPeriodPaid: no snapshot may go missing while the hours
    // stay locked. Put the run row back and say what happened.
    const { error: compErr } = runs?.length
      ? await supabase.from("payroll_runs").insert(runs)
      : { error: null };
    return {
      ok: false,
      error: compErr
        ? `Un-paying the hours failed (${dbError(error)}) and restoring the payroll record also failed (${dbError(compErr)}) — check this period on Timecards before retrying.`
        : `Un-paying the hours failed — nothing was unmarked. ${dbError(error)}`,
    };
  }
  if (!runs?.length && !cleared?.length) return { ok: false, error: "Nothing to undo in this period." };

  revalidatePath("/payroll");
  revalidatePath("/timecards");
  return { ok: true };
}

/** Settle a period's HELD mileage with a HUMAN-STATED dollar amount: stamps
 *  mileage_paid_at on the period's closed entries and records one kind='mileage'
 *  run {business miles, stated amount}. The amount is whatever the owner decided
 *  to pay — this action never computes, suggests, or defaults it from any rate;
 *  an absent or negative amount is refused outright. Late entries closed after a
 *  settlement stay held and simply take a second settlement act (consumers sum
 *  runs per person + period + kind). */
export async function settleMileage(input: {
  profileId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD (exclusive)
  amount: number; // stated $ — REQUIRED, human-typed
}): Promise<Result> {
  const ctx = await staffClient();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Enter the amount you decided to pay for mileage — the app never computes it." };
  }

  // Read first: an owner (0286, paid by owner's draw) has no mileage to settle as wages, and is
  // refused before anything is checked or stamped.
  const { data: prof } = await supabase
    .from("profile_pay")
    .select("commute_baseline_miles, full_name, paid_by_draw")
    .eq("id", input.profileId)
    .maybeSingle();
  if ((prof as any)?.paid_by_draw === true) return { ok: false, error: ownerWagesRefusal((prof as any)?.full_name) };
  const baseline = Math.max(0, Number(prof?.commute_baseline_miles ?? 0));

  const { startIso, endIso, tz } = await periodInstants(supabase, input.periodStart, input.periodEnd);
  const openErr = await openEntryError(supabase, input.profileId, startIso, endIso);
  if (openErr) return { ok: false, error: openErr };

  const { data: entries } = await supabase
    .from("time_entries")
    .select("id, clock_in, miles")
    .eq("profile_id", input.profileId)
    .eq("status", "closed")
    .is("mileage_paid_at", null)
    .not("clock_out", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso);
  const list = (entries ?? []) as any[];
  if (!list.length) return { ok: false, error: "No held mileage in this period." };

  // Record BUSINESS miles (logged net of the daily commute baseline) — the same
  // netting the payroll screen shows, so the run says what the amount covered.
  const miles = summarizeMileage(list, baseline, tz).business;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const ids = list.map((e) => e.id);
  // CLAIM ONLY STILL-HELD ROWS (the race markPeriodPaid was fixed for, on the mileage side).
  // This read the held list and then stamped `.in(ids)` with no condition and no row check, so
  // two taps on a slow connection — or two people settling the same person's period — both
  // stamped and both inserted a payroll_runs row, and the accountant's export reimbursed the
  // same miles twice. Filtering the UPDATE on mileage_paid_at IS NULL and reading the rows back
  // means the loser stamps nothing and bails before it can write a second settlement.
  const { data: stamped, error: upErr } = await supabase
    .from("time_entries")
    .update({ mileage_paid_at: new Date().toISOString() })
    .in("id", ids)
    .is("mileage_paid_at", null)
    .select("id");
  if (upErr) return { ok: false, error: upErr.message };
  if (!stamped?.length) return { ok: false, error: "Those miles were just settled by someone else." };
  const stampedIds = (stamped as { id: string }[]).map((r) => r.id);
  // A PARTIAL claim is not a settlement. `amount` is a figure a human typed for the miles that
  // were on screen; filing it against a smaller set of rows (an overlapping period settled
  // mid-flight) would record a number that covers miles it never covered. Put the stamps back
  // and let the office look at the period again.
  if (stampedIds.length !== ids.length) {
    // A ROLLBACK THAT WRITES NOTHING IS A FAILED ROLLBACK. This read only `error`, so a refused or
    // zero-row release (RLS, a row stamped again mid-flight) reported the clean sentence and left
    // those entries locked as paid with no settlement record behind them — miles nobody can settle
    // and nobody can see are stuck. Zero rows is treated exactly like an error, and either way it
    // goes to the ops log with the ids, because a stuck lock is invisible from the screen.
    const { data: released, error: rbErr } = await supabase
      .from("time_entries")
      .update({ mileage_paid_at: null })
      .in("id", stampedIds)
      .select("id");
    const stuck = !!rbErr || !released?.length;
    if (stuck) {
      reportError("payroll:settleMileage:rollback", rbErr ?? new Error("mileage release wrote no rows"), {
        profileId: input.profileId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        stampedIds,
      });
    }
    return {
      ok: false,
      error: stuck
        ? `Some of these miles were just settled by someone else, and releasing the rest didn't go through${rbErr ? ` (${rbErr.message})` : ""}. Those entries are still marked settled — check this period on Timecards before retrying.`
        : "Some of these miles were just settled by someone else. Reload this period and enter the amount again.",
    };
  }

  // org_id stamped by set_org_id. Mileage bucket only: gross/rate/hours are 0 by
  // the bucket-shape constraint — reimbursement dollars can never read as wages.
  const { error: runErr } = await supabase.from("payroll_runs").insert({
    profile_id: input.profileId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    kind: "mileage",
    hours: 0,
    rate: 0,
    gross: 0,
    miles: r2(miles),
    mileage_amount: r2(amount),
    created_by: userId,
  });
  if (runErr) {
    // Same compensation as markPeriodPaid: no lock without a record. Row-checked for the same
    // reason as the rollback above — a release that writes nothing leaves the miles locked.
    const { data: freed, error: compErr } = await supabase
      .from("time_entries")
      .update({ mileage_paid_at: null })
      .in("id", stampedIds)
      .select("id");
    const stillLocked = !!compErr || !freed?.length;
    if (stillLocked) {
      reportError("payroll:settleMileage:compensate", compErr ?? new Error("mileage release wrote no rows"), {
        profileId: input.profileId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        stampedIds,
      });
    }
    return {
      ok: false,
      error: stillLocked
        ? `Settlement record failed (${runErr.message}) and unlocking the miles didn't go through${compErr ? ` (${compErr.message})` : ""} — those entries are still marked settled. Check this period before retrying.`
        : `Settlement record failed — nothing was settled. ${runErr.message}`,
    };
  }

  revalidatePath("/payroll");
  revalidatePath("/timecards");
  return { ok: true };
}

/** Undo a mileage settlement: re-hold the period's miles and drop only the
 *  kind='mileage' runs. Base pay (paid_at + kind='base' rows) is untouched. */
export async function unsettleMileage(input: {
  profileId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<Result> {
  const ctx = await staffClient();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase } = ctx;

  const { startIso, endIso } = await periodInstants(supabase, input.periodStart, input.periodEnd);

  // THE SILENT-WRITE LAW on a money record: this delete's result was discarded, so a failed
  // delete left the run row standing while the miles were already un-settled — and re-settling
  // then doubled the accountant's reimbursement. Read the result; say so if it didn't land.
  // THE ROWS, NOT JUST THE ERROR (audit v921): the check the comment promised was never written,
  // so a zero-row delete returned ok. Delete first, refuse before touching the miles.
  const { data: runs, error: runErr } = await supabase
    .from("payroll_runs")
    .delete()
    .eq("profile_id", input.profileId)
    .eq("period_start", input.periodStart)
    .eq("period_end", input.periodEnd)
    .eq("kind", "mileage")
    .select("*");
  if (runErr) return { ok: false, error: dbError(runErr) };
  // Same rule as unmarkPeriodPaid: a settlement filed under different period keys must be
  // named and refused (re-settling would double the reimbursement), while no record at all
  // is safe to un-settle.
  if (!runs?.length) {
    const { data: stale } = await supabase
      .from("payroll_runs")
      .select("period_start, period_end")
      .eq("profile_id", input.profileId)
      .eq("kind", "mileage")
      .lt("period_start", input.periodEnd)
      .gt("period_end", input.periodStart)
      .limit(1);
    if (stale?.length) {
      const r = stale[0] as { period_start: string; period_end: string };
      return {
        ok: false,
        error: `These miles are settled under the pay period ${r.period_start} to ${r.period_end}, not this one — the pay schedule changed after they were paid. Put the old pay schedule back in Settings, undo there, then change it again.`,
      };
    }
  }

  const { data: cleared, error } = await supabase
    .from("time_entries")
    .update({ mileage_paid_at: null })
    .eq("profile_id", input.profileId)
    .eq("status", "closed")
    .not("mileage_paid_at", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso)
    .select("id");
  if (error) {
    // Same compensation as settleMileage: no settlement record may go missing while the miles
    // stay locked. Put the run row back and say what happened.
    const { error: compErr } = runs?.length
      ? await supabase.from("payroll_runs").insert(runs)
      : { error: null };
    return {
      ok: false,
      error: compErr
        ? `Un-settling the miles failed (${dbError(error)}) and restoring the settlement record also failed (${dbError(compErr)}) — check this period before retrying.`
        : `Un-settling the miles failed — nothing was unsettled. ${dbError(error)}`,
    };
  }
  if (!runs?.length && !cleared?.length) return { ok: false, error: "Nothing to undo in this period." };

  revalidatePath("/payroll");
  revalidatePath("/timecards");
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENTS (0264/0265) — "an amount i paid them instead of just a checkbox"
//
// Erik, 2026-09-17: "i have paid brian a large chunk of that and thats why im having trouble
// becuase theres been no way for me to record it properly… sometimes i need to throw his a few
// hundred or an off ammount."
//
// The word "paid" splits in two here, and each half stays honest:
//   · A PAYMENT is money that left his hand. It is typed, never computed (the mileage law from
//     0095, same reason), and it is voided, never deleted.
//   · A LOCK is still time_entries.paid_at, still stamped ONLY by markPeriodPaid below. It now
//     happens as a CONSEQUENCE of payments covering a period in full, oldest first — Erik's
//     choice, asked and answered today: a half-paid week stays correctable.
//
// markPeriodPaid / unmarkPeriodPaid are NOT reimplemented or inlined anywhere below. They are the
// race-safe lockers (claim-only-still-unpaid, row checks, compensating rollback, the open-entry
// and auto-closed refusals) and calling them is the entire point.
// ─────────────────────────────────────────────────────────────────────────────

/** What a payment action gives back. The sentence is read on screen, and the numbers ride along so
 *  the page can render the new balance without going back to the database for it. */
export type PayResult = Result & {
  message?: string;
  paymentId?: string;
  earned?: number;
  paid?: number;
  owed?: number;
  lockedPeriods?: { start: string; end: string }[];
  unlockedPeriods?: { start: string; end: string }[];
  blocked?: { start: string; end: string; reason: string } | null;
};

const cents = (n: number) => Math.round((Number(n) || 0) * 100);

/** The org's day + pay cycle, from the one place that holds them. */
async function orgPay(supabase: any) {
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const s = getOrgSettings(org?.settings);
  return { tz: s.timezone, schedule: s.pay_schedule, anchor: s.pay_anchor };
}

/** A read that did not come back whole: `what` in plain words for the screen, `cause` for the log. */
type PayReadFailure = { what: string; cause: unknown };

/** HOW BIG A LIST MAY BE BEFORE WE STOP BELIEVING IT.
 *
 *  These reads do not just decorate a sentence, they decide what gets LOCKED, and a lock is Erik's
 *  "never the same hour twice" boundary. The danger is not only a read that errors. A list quietly
 *  cut short comes back as a SMALLER total with no error at all, and every way it can be short is
 *  the same bug:
 *    · short payroll_runs  ⇒ lockedCents reads LOW while paidCents is still the full all-time total,
 *      so the credit is money already spent on existing locks, and it gets spent a second time.
 *    · short time_entries  ⇒ the period prices LOW, so "the credit covers it IN FULL" passes on a
 *      figure smaller than the one markPeriodPaid then freezes from the database.
 *  Both end the same way: a pay period frozen that the money never covered. That is decision (2)
 *  inverted (a half-paid week has to stay correctable) and it makes decision (3) bite, because
 *  frozen hours stop re-pricing.
 *
 *  So every list is asked for with an explicit ceiling, and a list that comes back AT its ceiling is
 *  treated exactly like an error. The caps sit far above a real shop (three people, years of shifts)
 *  and exist to make truncation LOUD instead of arithmetic. */
/** A CEILING CANNOT SEE A CUT BELOW IT (2026-09-17). The guard under this used to ask for N rows
 *  and treat "came back with N" as truncation — but PostgREST enforces its OWN max-rows, and when
 *  that is lower than the number we ask for, the response never reaches our figure and the cut
 *  stays invisible. The list reads short, the period prices low, "the credit covers it in full"
 *  passes on a number smaller than the one markPeriodPaid then freezes, and a pay period is locked
 *  that the money never covered. So these reads are PAGED to the end, advancing by the rows
 *  actually returned and stopping only on an empty page — the same contract payroll/page.tsx and
 *  storage-sweep use, for the same reason. MAX_PAGES is a stated bound that refuses OUT LOUD. */
const PAGE_ROWS = 1000;
const MAX_PAGES = 12;

/** Every row of a list, or an explicit failure. `what` is a bare plural noun in Erik's words. */
async function readEvery<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; failure: PayReadFailure | null }> {
  const out: T[] = [];
  for (let i = 0, from = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error) return { rows: [], failure: { what, cause: error } };
    if (!Array.isArray(data)) return { rows: [], failure: { what, cause: new Error(`${what}: read returned no rows array`) } };
    if (!data.length) return { rows: out, failure: null };
    out.push(...data);
    from += data.length;
  }
  return { rows: [], failure: { what, cause: new Error(`${what}: more rows than this page can read at once`) } };
}

/** The first of these reads that errored or came back as a non-list. Null means every list is
 *  trustworthy enough to decide a lock on. Truncation is no longer one of the arms here: a row
 *  ceiling cannot detect a cut made BELOW it, so every list that decides a lock is paged to the
 *  end by readEvery instead of asked for in one bounded gulp. */
function payReadFailure(
  reads: [string, { data: any; error: any } | null | undefined][],
): PayReadFailure | null {
  for (const [what, res] of reads) {
    if (!res) return { what, cause: new Error(`${what}: read returned nothing`) };
    if (res.error) return { what, cause: res.error };
    // `data ?? []` is what hid this class: a null payload read as "no rows" and priced as zero.
    if (!Array.isArray(res.data)) return { what, cause: new Error(`${what}: read returned no rows array`) };
  }
  return null;
}

/** Everything ONE person's balance is made of, read fresh — or an explicit failure.
 *
 *  THE PROJECTION LAW: the select lists below carry every field balanceForPerson reads — a missing
 *  one here reads on screen as zero hours or a phantom open shift, not as an error.
 *
 *  Entries are narrowed to rows where at least one lock is still open. A base-paid, mileage-settled
 *  entry contributes nothing to either half of this math (its wages are in the frozen run, its
 *  miles are settled), so leaving it out keeps this query small forever instead of growing with
 *  every shift the crew ever worked. */
async function payContext(
  supabase: any,
  profileId: string,
  name: string,
  tz: string,
): Promise<
  | {
      ok: true;
      payments: PayPaymentRow[];
      lockedRuns: { period_start: string; period_end: string; gross: number }[];
      entries: any[];
      fallbackRate: number;
      balance: PersonBalance;
    }
  | { ok: false; failure: PayReadFailure }
> {
  // Ordered by a primary key so the pages tile exactly, with no row read twice or skipped.
  const [paymentsRead, runsRead, entriesRead, profRes] = await Promise.all([
    readEvery<any>("payments", (from, to) =>
      supabase
        .from("pay_payments")
        .select("id, profile_id, amount, paid_on, method, reference, note, needs_check, voided_at")
        .eq("profile_id", profileId)
        .order("id")
        .range(from, to),
    ),
    readEvery<any>("payroll records", (from, to) =>
      supabase
        .from("payroll_runs")
        .select("id, period_start, period_end, gross")
        .eq("profile_id", profileId)
        .eq("kind", "base")
        .order("id")
        .range(from, to),
    ),
    readEvery<any>("hours", (from, to) =>
      supabase
        .from("time_entries")
        .select("id, profile_id, status, clock_in, clock_out, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override")
        .eq("profile_id", profileId)
        .or("paid_at.is.null,mileage_paid_at.is.null")
        .order("id")
        .range(from, to),
    ),
    supabase.from("profile_pay").select("hourly_rate").eq("id", profileId).maybeSingle(),
  ]);
  const paymentsRes = { data: paymentsRead.rows, error: null as any };
  const runsRes = { data: runsRead.rows, error: null as any };
  const entriesRes = { data: entriesRead.rows, error: null as any };
  const pagedFailure = paymentsRead.failure ?? runsRead.failure ?? entriesRead.failure;
  if (pagedFailure) return { ok: false, failure: pagedFailure };

  const failure =
    payReadFailure([
      ["payments", paymentsRes],
      ["locked pay periods", runsRes],
      ["time entries", entriesRes],
    ]) ??
    // The rate matters as much as the rows: a fallback of 0 prices an unlocked period at nothing,
    // which skips it and lets a LATER period lock out of turn. Oldest first is the rule.
    (profRes?.error ? { what: "pay rate", cause: profRes.error } : null);
  if (failure) return { ok: false, failure };

  const payments = (paymentsRes.data as any[]).map(toPayPaymentRow);
  const lockedRuns = runsRes.data as { period_start: string; period_end: string; gross: number }[];
  const entries = entriesRes.data as any[];
  const fallbackRate = Number((profRes.data as any)?.hourly_rate ?? 0);
  const balance = balanceForPerson({ profileId, name, entries, lockedRuns, payments, tz, fallbackRate });
  return { ok: true, payments, lockedRuns, entries, fallbackRate, balance };
}

/** THE LOCK RULE, exactly as Erik chose it: a payment locks only the periods it covers IN FULL,
 *  oldest first, so a half-paid week stays correctable.
 *
 *  The credit is every non-voided payment MINUS every period already locked — not just the payment
 *  that was entered a second ago. Two $300 drops that between them cover a $520 week lock that week
 *  on the second one, which is exactly how Erik pays: "sometimes i need to throw his a few hundred".
 *
 *  It stops at the FIRST period the credit cannot cover (never skipping ahead to a cheaper later
 *  one — money pays off the oldest debt first), and at the first period markPeriodPaid REFUSES. A
 *  refusal is not a failure of the payment: the money moved, the lock did not, and the sentence
 *  says both. */
async function lockedGrossCents(
  supabase: any,
  profileId: string,
): Promise<{ ok: true; cents: number } | { ok: false; failure: PayReadFailure }> {
  // Paged to the end for the same reason as every read above, and a stronger one: this figure is
  // SUBTRACTED from what has been paid, so reading it short hands out a credit already spent — and
  // a short read is exactly what a row ceiling cannot see.
  const read = await readEvery<any>("locked pay periods", (from, to) =>
    supabase
      .from("payroll_runs")
      .select("id, gross")
      .eq("profile_id", profileId)
      .eq("kind", "base")
      .order("id")
      .range(from, to),
  );
  if (read.failure) return { ok: false, failure: read.failure };
  return { ok: true, cents: read.rows.reduce((sum, r) => sum + cents(r?.gross), 0) };
}

async function applyLocks(
  supabase: any,
  input: { profileId: string; tz: string; schedule: any; anchor: string; fallbackRate: number; entries: any[]; paidCents: number; lockedCents: number },
): Promise<{
  locked: { start: string; end: string }[];
  blocked: { start: string; end: string; reason: string } | null;
  /** A read stopped the walk partway. Whatever locked, locked; the rest was never looked at. */
  unchecked: boolean;
}> {
  const locked: { start: string; end: string }[] = [];
  let blocked: { start: string; end: string; reason: string } | null = null;
  let unchecked = false;
  let credit = input.paidCents - input.lockedCents;
  if (credit <= 0) return { locked, blocked, unchecked };

  // Bucket the still-unlocked closed hours into the org's pay periods — the SAME windowing the
  // payroll page reads through (payPeriodBounds under payPeriodForOffset), so a period here is the
  // period Erik sees there. Open shifts are left out on purpose: markPeriodPaid refuses a period
  // holding one, and that refusal is the message we want, not a silent skip.
  const periods = new Map<string, { start: string; end: string; entries: any[] }>();
  for (const e of input.entries) {
    // The same three conditions markPeriodPaid's own query uses (closed, clocked out, unpaid), so
    // the rows priced here are the rows it will lock.
    if (e.paid_at || !e.clock_out || e.status !== "closed") continue;
    const t = Date.parse(e.clock_in);
    if (!Number.isFinite(t)) continue;
    const p = payPeriodBounds(input.schedule, input.anchor, todayStrInTz(input.tz, new Date(t)));
    const key = `${p.start}|${p.end}`;
    const bucket = periods.get(key) ?? { start: p.start, end: p.end, entries: [] };
    bucket.entries.push(e);
    periods.set(key, bucket);
  }

  const oldestFirst = [...periods.values()].sort((a, b) => a.start.localeCompare(b.start));
  for (const p of oldestFirst) {
    // The gross is computed by the SAME function markPeriodPaid freezes with, on the same rows and
    // the same fallback rate, so what we subtract from the credit is what the snapshot will say.
    const [agg] = aggregatePayrollEntries(p.entries, input.tz, input.fallbackRate);
    const grossCents = cents(agg?.unpaidGross ?? 0);
    // A period whose hours come to nothing (a zero-hour auto-closed ghost) owes nothing, so there
    // is nothing for a payment to cover. Leave it open for Timecards to fix.
    if (grossCents <= 0) continue;
    if (credit < grossCents) break; // IN FULL or not at all
    const res = await markPeriodPaid({ profileId: input.profileId, periodStart: p.start, periodEnd: p.end });
    if (!res.ok) {
      blocked = { start: p.start, end: p.end, reason: lockRefusalReason(res.error) };
      break;
    }
    locked.push({ start: p.start, end: p.end });
    // SPEND WHAT WAS ACTUALLY FROZEN, not what was predicted a moment ago. markPeriodPaid prices
    // the period from the database at the instant it runs, so an entry that landed in between (or
    // a row a concurrent lock took) makes the real snapshot differ from the figure above. Re-reading
    // the locked total is what keeps "covers it IN FULL" literally true for the NEXT period, which
    // is Erik's whole rule: a half-paid week has to stay correctable.
    //
    // And if THAT read does not come back whole, the walk stops here rather than carrying on with a
    // stale credit. The period just locked is real and is reported; nothing further is guessed at.
    const reread = await lockedGrossCents(supabase, input.profileId);
    if (!reread.ok) {
      reportError("payroll:applyLocks:reread", reread.failure.cause, {
        profileId: input.profileId,
        what: reread.failure.what,
        lockedSoFar: locked,
      });
      unchecked = true;
      break;
    }
    credit = input.paidCents - reread.cents;
  }
  return { locked, blocked, unchecked };
}

/** Both payroll surfaces, plus the Pay page wherever it lives. A path with no page is a no-op. */
function revalidatePay() {
  revalidatePath("/payroll");
  revalidatePath("/pay");
  revalidatePath("/timecards");
}

/** RECORD MONEY THAT LEFT ERIK'S HAND. The amount is his, never defaulted and never computed; the
 *  date is his too (he pays early and he pays late). Then the lock rule runs, and the sentence
 *  says what happened: what moved, what locked, what could not lock and why, what is left. */
export async function recordPayment(input: {
  profileId: string;
  amount: number;
  paidOn: string; // YYYY-MM-DD, the ORG's day
  method: PayMethod;
  reference?: string;
  note?: string;
}): Promise<PayResult> {
  const ctx = await staffClient();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

  // THE AMOUNT IS REQUIRED AND NEVER DEFAULTED (settleMileage's discipline). Rounded to cents
  // first, so a figure that rounds away to nothing is refused here instead of by a DB constraint.
  const raw = Number(input.amount);
  const amount = Math.round((Number.isFinite(raw) ? raw : 0) * 100) / 100;
  if (!Number.isFinite(raw) || amount <= 0) return { ok: false, error: "Enter an amount above $0." };
  if (amount > 9_999_999) {
    return { ok: false, error: "That amount is bigger than this app can record. Check the figure and enter it again." };
  }

  const method: PayMethod = (input.method ?? "cash") || "cash";
  if (!isPayMethod(method)) return { ok: false, error: "Pick how you paid: cash, check, transfer or other." };

  const { tz, schedule, anchor } = await orgPay(supabase);
  const today = todayStrInTz(tz);
  // Days are ORG-local. An empty date means today, which is what the form shows; a date that isn't
  // a date is refused rather than quietly filed on the wrong day.
  const paidOn = String(input.paidOn ?? "").trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) {
    return { ok: false, error: "That date didn't read as a day. Pick the day you paid and try again." };
  }

  // WHO IS BEING PAID. RLS scopes profiles to the caller's org, so a row that does not come back is
  // not this shop's person. A read that ERRORED is a different fact and says so: refusing with the
  // wrong reason is its own dead end.
  const { data: person, error: personErr } = await supabase
    .from("profiles")
    .select("id, full_name, active, role")
    .eq("id", input.profileId)
    .maybeSingle();
  if (personErr) {
    return { ok: false, error: `Looking that person up didn't go through, so nothing was recorded. ${dbError(personErr)}` };
  }
  if (!person) return { ok: false, error: "That person isn't on this shop's list. Reload the page and pick them again." };
  const name = (person as any).full_name ?? "";
  // THE OWNER IS PAID BY OWNER'S DRAW (0286): role 'owner' is exactly profile_pay.paid_by_draw's
  // own predicate, read here off the row already in hand. Refused before the insert, in words;
  // refuse_wages_for_an_owner would refuse the insert anyway.
  if ((person as any).role === "owner") return { ok: false, error: ownerWagesRefusal(name) };

  // SWITCHED OFF IS NOT A REFUSAL. Settling up with someone who has LEFT is the most ordinary
  // version of Erik's complaint ("i have paid brian a large chunk of that... theres been no way for
  // me to record it properly"), and a person who is switched off still shows on the owed board with
  // a real figure, because page.tsx builds its list from entries, runs and payments and profile_pay
  // carries `active` without filtering on it. Bouncing the payment there is a dead end on a row the
  // page itself put in front of him.
  //
  // And the remedy a refusal would have to name is worse than the problem: per 0158, profiles.active
  // is the trust root under auth_org_id / is_org_staff / is_staff / app_user_role, so "switch them
  // back on and it will save" means handing a former employee the org's customers, jobs, schedule
  // and timeclock back to write down cash that already changed hands. Nothing in 0264 asks for this
  // check either: its RLS is org + staff on the WRITER and says nothing about the payee.
  //
  // So it records, and the sentence STATES the fact instead of blocking on it.
  const inactive = (person as any).active === false;

  // org_id is stamped by the set_org_id trigger — never sent from here.
  // THE SILENT-WRITE LAW: a zero-row insert is a 204, so the row comes back and gets checked.
  const { data: inserted, error: insErr } = await supabase
    .from("pay_payments")
    .insert({
      profile_id: input.profileId,
      amount,
      paid_on: paidOn,
      method,
      reference: String(input.reference ?? "").trim() || null,
      note: String(input.note ?? "").trim() || null,
      created_by: userId,
    })
    .select("id");
  if (insErr) return { ok: false, error: `That payment didn't save, so nothing was recorded. ${dbError(insErr)}` };
  if (!inserted?.length) {
    reportError("payroll:recordPayment", new Error("payment insert wrote no rows"), {
      profileId: input.profileId,
      amount,
      paidOn,
    });
    return { ok: false, error: "That payment didn't save, so nothing was recorded. Try it again." };
  }
  const paymentId = String((inserted[0] as any).id);

  // Read the whole picture back, INCLUDING the row just written, then spend the credit on locks.
  //
  // THE PAYMENT IS ALREADY SAVED AND ROW-CHECKED. What comes next only decides what gets LOCKED, and
  // a lock made from a partial picture is money spent twice: the credit walks off a runs total that
  // read low, or a period prices low and gets frozen for less than it is worth. So a read that did
  // not come back whole stops the lock rule dead. Nothing is undone, nothing is guessed, and the
  // sentence says the money is recorded and the periods were not checked.
  const state = await payContext(supabase, input.profileId, name, tz);
  if (!state.ok) {
    reportError("payroll:recordPayment:read", state.failure.cause, {
      profileId: input.profileId,
      paymentId,
      what: state.failure.what,
    });
    revalidatePay();
    return {
      ok: true,
      paymentId,
      message: paymentSentence({
        name,
        amount,
        method,
        paidOn,
        today,
        locked: [],
        blocked: null,
        owed: null,
        unchecked: true,
        inactive,
      }),
      lockedPeriods: [],
      blocked: null,
    };
  }

  const { locked, blocked, unchecked } = await applyLocks(supabase, {
    profileId: input.profileId,
    tz,
    schedule,
    anchor,
    fallbackRate: state.fallbackRate,
    entries: state.entries,
    paidCents: cents(state.balance.paid),
    lockedCents: cents(sumLockedGross(state.lockedRuns)),
  });

  // A LOCK SHOULD NOT MOVE EARNED: markPeriodPaid freezes the same gross this figure already
  // counted live, with the same function on the same rows. "Should not" is not "cannot" (a shift
  // entered between the two reads prices differently), and this number is read aloud as what Erik
  // still owes, so when something actually locked it is read again instead of assumed. When
  // nothing locked, nothing moved, and the page gets its numbers without another round trip.
  let balance: PersonBalance | null = state.balance;
  if (locked.length) {
    const after = await payContext(supabase, input.profileId, name, tz);
    if (after.ok) {
      balance = after.balance;
    } else {
      // The locks are real and are reported. The BALANCE is not known, so it is not spoken.
      reportError("payroll:recordPayment:reread", after.failure.cause, {
        profileId: input.profileId,
        paymentId,
        what: after.failure.what,
      });
      balance = null;
    }
  }

  revalidatePay();
  return {
    ok: true,
    paymentId,
    message: paymentSentence({
      name,
      amount,
      method,
      paidOn,
      today,
      locked,
      blocked,
      owed: balance ? balance.owed : null,
      unchecked: unchecked || !balance,
      inactive,
    }),
    earned: balance?.earned,
    paid: balance?.paid,
    owed: balance?.owed,
    lockedPeriods: locked,
    blocked,
  };
}

/** UNDO A PAYMENT. Voided, never deleted (the undo-trail law): the row stays on screen and stops
 *  counting. And because a lock was a CONSEQUENCE of payments covering a period, taking the money
 *  back has to take the lock back too — newest locked period first, until what is still locked is
 *  covered again by what is still paid. Hours quietly staying locked behind a cancelled payment is
 *  exactly the silence this page exists to end. */
export async function voidPayment(id: string): Promise<PayResult> {
  const ctx = await staffClient();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

  const { data: row } = await supabase
    .from("pay_payments")
    .select("id, profile_id, amount, paid_on, method, voided_at")
    .eq("id", String(id ?? ""))
    .maybeSingle();
  if (!row) return { ok: false, error: "That payment isn't here anymore. Reload the page." };
  if ((row as any).voided_at) return { ok: false, error: "That payment is already voided, so there is nothing to undo." };

  const profileId = String((row as any).profile_id);
  const amount = Number((row as any).amount ?? 0);
  const paidOn = String((row as any).paid_on ?? "");

  const { tz } = await orgPay(supabase);
  const today = todayStrInTz(tz);
  const { data: person } = await supabase.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
  const name = (person as any)?.full_name ?? "";

  // Claim the void: only a row still live can be voided, and the row check means a second tap on a
  // slow connection reports the truth instead of a second success.
  const { data: voided, error: vErr } = await supabase
    .from("pay_payments")
    .update({ voided_at: new Date().toISOString(), voided_by: userId })
    .eq("id", String(id ?? ""))
    .is("voided_at", null)
    .select("id");
  if (vErr) return { ok: false, error: `That void didn't go through, so the payment still stands. ${dbError(vErr)}` };
  if (!voided?.length) return { ok: false, error: "Someone else just voided that payment. Reload the page." };

  // What is left paid, against what is still locked. Periods come off NEWEST first — the mirror of
  // the oldest-first lock rule, so the oldest debt stays settled and the most recent lock is the
  // one that gives way.
  //
  // The void itself is written and row-checked, so it stands whatever happens here. But UNLOCKING is
  // decided by the same two totals the lock rule uses, and a partial read gets it wrong in both
  // directions: a short runs list leaves hours locked behind money that is gone, a short payments
  // list unlocks periods that are still covered. Neither is worth guessing at, so it stops and says
  // so, and the hours stay exactly as they are until someone can look.
  const after = await payContext(supabase, profileId, name, tz);
  if (!after.ok) {
    reportError("payroll:voidPayment:read", after.failure.cause, {
      profileId,
      paymentId: String(id ?? ""),
      what: after.failure.what,
    });
    revalidatePay();
    return {
      ok: true,
      message: voidSentence({ name, amount, paidOn, today, unlocked: [], blocked: null, owed: null, unchecked: true }),
      unlockedPeriods: [],
      blocked: null,
    };
  }

  const groups = new Map<string, { start: string; end: string; cents: number }>();
  for (const r of after.lockedRuns) {
    const key = `${r.period_start}|${r.period_end}`;
    const g = groups.get(key) ?? { start: r.period_start, end: r.period_end, cents: 0 };
    g.cents += cents(r.gross); // a late entry locked later adds a SECOND run for the same period
    groups.set(key, g);
  }
  let lockedCents = [...groups.values()].reduce((s, g) => s + g.cents, 0);
  const paidCents = cents(after.balance.paid);
  const unlocked: { start: string; end: string }[] = [];
  let blocked: { start: string; end: string; reason: string } | null = null;
  for (const g of [...groups.values()].sort((a, b) => b.start.localeCompare(a.start))) {
    if (lockedCents <= paidCents) break; // still covered: leave it locked
    const res = await unmarkPeriodPaid({ profileId, periodStart: g.start, periodEnd: g.end });
    if (!res.ok) {
      blocked = { start: g.start, end: g.end, reason: lockRefusalReason(res.error) };
      reportError("payroll:voidPayment:unlock", new Error(res.error ?? "unmarkPeriodPaid refused"), {
        profileId,
        paymentId: String(id ?? ""),
        periodStart: g.start,
        periodEnd: g.end,
      });
      break;
    }
    lockedCents -= g.cents;
    unlocked.push({ start: g.start, end: g.end });
  }

  // Unlocking moves hours from the FROZEN half of earned back to the live half, and a raise since
  // then means those two figures differ on purpose (forward only). So the balance is read again
  // rather than assumed — and if that read does not come back whole, the unlocks are still reported
  // as the facts they are and the balance simply is not spoken.
  let balance: PersonBalance | null = after.balance;
  if (unlocked.length) {
    const final = await payContext(supabase, profileId, name, tz);
    if (final.ok) {
      balance = final.balance;
    } else {
      reportError("payroll:voidPayment:reread", final.failure.cause, {
        profileId,
        paymentId: String(id ?? ""),
        what: final.failure.what,
      });
      balance = null;
    }
  }

  revalidatePay();
  return {
    ok: true,
    message: voidSentence({
      name,
      amount,
      paidOn,
      today,
      unlocked,
      blocked,
      owed: balance ? balance.owed : null,
      unchecked: !balance,
    }),
    earned: balance?.earned,
    paid: balance?.paid,
    owed: balance?.owed,
    unlockedPeriods: unlocked,
    blocked,
  };
}

/** 0265 imported every old Mark Paid tick as a payment and flagged it "check this", because an
 *  imported figure is a RECONSTRUCTION, not a receipt: the amount is what the app said the period
 *  came to, and the date is the period's last day because a tick never recorded one. This is Erik
 *  saying he has looked at one and it is right. */
export async function confirmImportedPayment(id: string): Promise<PayResult> {
  const ctx = await staffClient();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase } = ctx;

  const paymentId = String(id ?? "");
  const { data: row } = await supabase
    .from("pay_payments")
    .select("id, profile_id, amount, paid_on, note, needs_check, voided_at")
    .eq("id", paymentId)
    .maybeSingle();
  if (!row) return { ok: false, error: "That payment isn't here anymore. Reload the page." };
  if (!(row as any).needs_check) return { ok: false, error: "That payment is already checked off." };

  /**
   * THE INSTRUCTION MUST NOT OUTLIVE THE DEED (audit finding, 2026-09-20). 0265 wrote the note
   * "Recorded from the old Mark Paid button, and still needs checking. It covers ..." beside the
   * flag, and this action cleared the flag and left the sentence. The note is the only part of the
   * row still on screen once the needs-check banner is gone, which makes it the part that has to
   * stay true - and it is durable ledger text, reachable by SQL and by any export, so it has to
   * stop EXISTING rather than stop being drawn. The row keeps where the figure came from and
   * loses the order attached to it, in the same statement that drops the flag. 0279 did the same
   * to the two rows that were already checked off before this shipped.
   */
  const storedNote = String((row as any).note ?? "");
  const checkedNote =
    storedNote
      .replace(", and still needs checking.", ".")
      .replace(" - check this.", ".")
      .replace(" — check this.", ".") || null;

  const { data: cleared, error } = await supabase
    .from("pay_payments")
    .update({ needs_check: false, ...(checkedNote !== storedNote ? { note: checkedNote } : {}) })
    .eq("id", paymentId)
    .eq("needs_check", true)
    .select("id");
  if (error) return { ok: false, error: `That didn't save, so it is still flagged. ${dbError(error)}` };
  if (!cleared?.length) return { ok: false, error: "Someone else just checked that one off. Reload the page." };

  const { tz } = await orgPay(supabase);
  const { data: person } = await supabase.from("profiles").select("full_name").eq("id", String((row as any).profile_id)).maybeSingle();
  const name = firstName((person as any)?.full_name);

  revalidatePay();
  return {
    ok: true,
    paymentId,
    message: `Checked off: the ${sayMoney(Number((row as any).amount ?? 0))} payment to ${name} from ${dayPhrase(String((row as any).paid_on ?? ""), todayStrInTz(tz))}.`,
  };
}
