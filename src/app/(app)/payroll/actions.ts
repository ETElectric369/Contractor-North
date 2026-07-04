"use server";

import { revalidatePath } from "next/cache";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { tzDayStartUtc } from "@/lib/tz";
import { aggregatePayrollEntries } from "@/lib/payroll-math";
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

  const { startIso, endIso, tz } = await periodInstants(supabase, input.periodStart, input.periodEnd);
  const openErr = await openEntryError(supabase, input.profileId, startIso, endIso);
  if (openErr) return { ok: false, error: openErr };

  const { data: prof } = await supabase.from("profiles").select("hourly_rate").eq("id", input.profileId).maybeSingle();
  const rate = Number(prof?.hourly_rate ?? 0);

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

  // Freeze the snapshot's hours+gross via the EXACT function the approval screen renders
  // (aggregatePayrollEntries) — one code path, so the number the accountant exports can't
  // drift from what the owner approved. Every fetched entry is unpaid (query filter) and
  // one profile, so they roll into a single row's UNPAID bucket; pass the base rate as the
  // fallback because this query doesn't join profiles. Miles aren't selected here, so the
  // aggregator's mileage side reads 0 — exactly right, this is the base bucket only.
  const [agg] = aggregatePayrollEntries(list, tz, rate);
  const hours = agg?.unpaidHours ?? 0;
  const gross = agg?.unpaidGross ?? 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const ids = list.map((e) => e.id);
  const { error: upErr } = await supabase
    .from("time_entries")
    .update({ paid_at: new Date().toISOString() })
    .in("id", ids);
  if (upErr) return { ok: false, error: upErr.message };

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
    const { error: compErr } = await supabase.from("time_entries").update({ paid_at: null }).in("id", ids);
    return {
      ok: false,
      error: compErr
        ? `Payroll record failed (${runErr.message}) and unlocking the entries also failed (${compErr.message}) — check this period on Timecards before retrying.`
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
  const { error } = await supabase
    .from("time_entries")
    .update({ paid_at: null })
    .eq("profile_id", input.profileId)
    .eq("status", "closed")
    .not("paid_at", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso);
  if (error) return { ok: false, error: error.message };

  await supabase
    .from("payroll_runs")
    .delete()
    .eq("profile_id", input.profileId)
    .eq("period_start", input.periodStart)
    .eq("period_end", input.periodEnd)
    .eq("kind", "base");

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

  const { startIso, endIso, tz } = await periodInstants(supabase, input.periodStart, input.periodEnd);
  const openErr = await openEntryError(supabase, input.profileId, startIso, endIso);
  if (openErr) return { ok: false, error: openErr };

  const { data: prof } = await supabase.from("profiles").select("commute_baseline_miles").eq("id", input.profileId).maybeSingle();
  const baseline = Math.max(0, Number(prof?.commute_baseline_miles ?? 0));

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
  const { error: upErr } = await supabase
    .from("time_entries")
    .update({ mileage_paid_at: new Date().toISOString() })
    .in("id", ids);
  if (upErr) return { ok: false, error: upErr.message };

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
    // Same compensation as markPeriodPaid: no lock without a record.
    const { error: compErr } = await supabase.from("time_entries").update({ mileage_paid_at: null }).in("id", ids);
    return {
      ok: false,
      error: compErr
        ? `Settlement record failed (${runErr.message}) and unlocking the miles also failed (${compErr.message}) — check this period before retrying.`
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
  const { error } = await supabase
    .from("time_entries")
    .update({ mileage_paid_at: null })
    .eq("profile_id", input.profileId)
    .eq("status", "closed")
    .not("mileage_paid_at", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso);
  if (error) return { ok: false, error: error.message };

  await supabase
    .from("payroll_runs")
    .delete()
    .eq("profile_id", input.profileId)
    .eq("period_start", input.periodStart)
    .eq("period_end", input.periodEnd)
    .eq("kind", "mileage");

  revalidatePath("/payroll");
  revalidatePath("/timecards");
  return { ok: true };
}
