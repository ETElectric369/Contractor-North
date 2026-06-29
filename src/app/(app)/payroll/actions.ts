"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { tzDayStartUtc } from "@/lib/tz";
import { hoursBetween } from "@/lib/utils";
import { payRateForEntry } from "@/lib/payroll-math";
import { summarizeMileage } from "@/lib/mileage-math";

export type Result = { ok: boolean; error?: string };

async function staffClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." as const };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "admin", "office"].includes(me.role)) return { error: "Not allowed." as const };
  return { supabase, userId: user.id };
}

async function periodInstants(supabase: any, periodStart: string, periodEnd: string) {
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings(org?.settings).timezone;
  return { startIso: tzDayStartUtc(periodStart, tz).toISOString(), endIso: tzDayStartUtc(periodEnd, tz).toISOString() };
}

/** Lock an employee's UNPAID closed hours in a pay period as paid, and snapshot
 *  the run for the accountant export. Idempotent: only touches unpaid entries. */
export async function markPeriodPaid(input: {
  profileId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD (exclusive)
}): Promise<Result> {
  const ctx = await staffClient();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, userId } = ctx;

  const { startIso, endIso } = await periodInstants(supabase, input.periodStart, input.periodEnd);
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((org as any)?.settings).timezone;
  const { data: prof } = await supabase.from("profiles").select("hourly_rate, commute_baseline_miles").eq("id", input.profileId).maybeSingle();
  const rate = Number(prof?.hourly_rate ?? 0);
  const baseline = Math.max(0, Number(prof?.commute_baseline_miles ?? 0));

  const { data: entries } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out, lunch_minutes, miles, rate_override")
    .eq("profile_id", input.profileId)
    .eq("status", "closed")
    .is("paid_at", null)
    .not("clock_out", "is", null)
    .gte("clock_in", startIso)
    .lt("clock_in", endIso);
  const list = (entries ?? []) as any[];
  if (!list.length) return { ok: false, error: "No unpaid hours in this period." };

  // Accumulate gross PER ENTRY at its own pay rate (rate_override ?? base) — the exact same
  // resolver the approval screen uses, so the snapshot the accountant exports can't diverge
  // from what the owner approved, and a mixed-rate week is paid correctly.
  let hours = 0, gross = 0;
  for (const e of list) {
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    hours += h;
    gross += h * payRateForEntry(e, rate);
  }
  // Reimbursable mileage = BUSINESS miles (logged net of the daily commute baseline), the same
  // netting the approval screen + tax report use — so the exported run can't overpay the commute.
  const miles = summarizeMileage(list, baseline, tz).business;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const { error: upErr } = await supabase
    .from("time_entries")
    .update({ paid_at: new Date().toISOString() })
    .in("id", list.map((e) => e.id));
  if (upErr) return { ok: false, error: upErr.message };

  // org_id is stamped by the set_org_id trigger.
  await supabase.from("payroll_runs").insert({
    profile_id: input.profileId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    hours: r2(hours),
    miles: r2(miles),
    rate, // base rate, for reference — gross below is summed per entry (honors overrides)
    gross: r2(gross),
    created_by: userId,
  });

  revalidatePath("/payroll");
  revalidatePath("/timecards");
  return { ok: true };
}

/** Undo: re-open an employee's paid hours in a period (and drop the run snapshot)
 *  — for a mis-click before the check is actually cut. */
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
    .eq("period_end", input.periodEnd);

  revalidatePath("/payroll");
  revalidatePath("/timecards");
  return { ok: true };
}
