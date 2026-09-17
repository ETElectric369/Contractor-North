import { attachRates, payRateMap, payRateMapRead } from "@/lib/profile-columns";
import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { redirect } from "next/navigation";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  formatCurrency,
  formatDuration,
  formatDate,
  formatTime,
  hoursBetween,
  initials,
} from "@/lib/utils";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { formatDateTimeTz, timeEntryGridSpan, tzDayStartUtc, tzMinutesOfDay, todayStrInTz } from "@/lib/tz";
import { summarizeMileage } from "@/lib/mileage-math";
import { balanceForPerson, toPayPaymentRow, type PayPaymentRow, type PersonBalance } from "@/lib/payroll-math";
import { getCrewStatus } from "@/lib/crew-status";
import { firstNameOf, pillColorForPerson } from "@/lib/employee-color";
import { TimecardStack } from "./timecard-stack";
import { hmToMin } from "@/lib/tz";
import { AddEntryButton } from "../timeclock/add-entry-button";
import { EditEntryButton } from "./edit-entry-button";
import { OpenEntryEditor } from "./open-entry-editor";
import { DuplicateEntryButton } from "./duplicate-entry-button";
import { MarkReportReviewedButton } from "./mark-report-reviewed-button";
import type { DailyReportSummary } from "../timeclock/actions";
import type { JobCode } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";
import { tolerateMissingColumns } from "@/lib/inspection/schema";
import { comparePlanToActual, needsAttention as needsAttentionRows, explain } from "@/lib/plan-vs-actual";

export const dynamic = "force-dynamic";

// The pay-week window as UTC instants, anchored on the org's LOCAL day — not the
// (UTC-on-Vercel) server day — so a Pacific evening shift buckets into the right
// week. Starts Monday unless Settings → Scheduling says the week starts Sunday
// (org settings week_start). `start`/`end` are the UTC instants of local
// midnight, end exclusive.
function weekRange(offset: number, tz: string, weekStart: "sunday" | "monday") {
  const todayStr = todayStrInTz(tz);
  const utcDow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // Sunday = 0
  const dow = weekStart === "sunday" ? utcDow : (utcDow + 6) % 7; // days since the week started
  const startDate = new Date(`${todayStr}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - dow - offset * 7);
  const start = tzDayStartUtc(startDate.toISOString().slice(0, 10), tz);
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 7);
  const end = tzDayStartUtc(endDate.toISOString().slice(0, 10), tz);
  // The 7 local day-strings of the week — the time grid's columns.
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setUTCDate(d.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return { start, end, days };
}

/** ── THE OWED ROW'S READS ────────────────────────────────────────────────────────────────────
 *
 *  This page used to carry its own roster of every person with hours, gross and a paid badge — a
 *  read-only mirror of /payroll sitting two inches under a grid of the same hours. Erik: "there is
 *  way too much in my face i dont even know what it all is and it looks like duplicates." The Pay
 *  page now owns "what do I owe" with real payments behind it, so the mirror collapses to ONE row
 *  carrying its headline figure and a way in.
 *
 *  The figure is computed by balanceForPerson — the SAME pure function /payroll uses, so the two
 *  screens cannot disagree about a man's money. Only the READ CONTRACT is copied here, and it is
 *  copied rather than shared because it has to behave identically: PostgREST stops at its
 *  db-max-rows cap with a 200 and no error, so a bare read is how a short list becomes a confident
 *  wrong number. Page it, advance by the rows ACTUALLY returned, stop only on an empty page. If
 *  either half of that contract is ever changed on /payroll, change it here in the same breath. */
const BALANCE_MONTHS = 18;
const PAGE_ROWS = 1000;
const MAX_PAGES = 12;
/** One projection, used by both entry reads, so a column can never go missing from one of them
 *  (THE PROJECTION LAW: the failure is always a select list). */
const BALANCE_ENTRY_COLS =
  "id, profile_id, clock_in, clock_out, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override, profiles(full_name)";

type WholeRead<T> = { rows: T[]; problem: string | null };

async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<WholeRead<T>> {
  const out: T[] = [];
  for (let i = 0, from = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error || !data) return { rows: [], problem: "read failed" };
    if (!data.length) return { rows: out, problem: null };
    out.push(...data);
    from += data.length;
  }
  return { rows: [], problem: "too many rows to read at once" };
}

export default async function TimecardsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; entry?: string }>;
}) {
  const { week, entry: entryParam } = await searchParams;
  const offset = Math.max(0, parseInt(week ?? "0", 10) || 0);
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !isStaffRole(me.role)) {
    redirect("/timeclock");
  }

  const [{ data: members }, { data: jobCodes }, { data: jobs }, { data: org }, crew] = await Promise.all([
    // hourly_rate + bill_rate feed the edit/add modals' pay-rate anchor + the
    // bill-rate tripwire. Safe to select flat here — the page redirects non-staff
    // above, so the rates never serialize into a tech's props.
    supabase.from("profile_pay").select("id, full_name, hourly_rate, bill_rate").eq("active", true).order("full_name"),
    supabase.from("job_codes").select("*").eq("active", true).order("code"),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    // The live crew pulse (who's on the clock now) — moved here from My Day's
    // CrewBoard so presence lives next to the hours it becomes.
    getCrewStatus(supabase),
  ]);
  // Render times in the BUSINESS timezone, not the UTC server's, so the list
  // matches the (browser-local) edit modal instead of being hours off.
  const orgSettings = getOrgSettings((org as any)?.settings);
  const tz = orgSettings.timezone;

  const { start, end, days: weekDayStrs } = weekRange(offset, tz, orgSettings.week_start);

  // Crew-lead daily reports — the office review surface the daily_report bell/push
  // (url "/timecards") and the planner card's "Review in timecards" land on. Last 14
  // org-local days, newest first; the planner card shows TODAY only, so this is where
  // yesterday's report lives (with the GPS day story + the filed→reviewed check-off).
  const reportsSince = todayStrInTz(tz, new Date(Date.now() - 14 * 86_400_000));
  const { data: reportRows } = await supabase
    .from("daily_reports")
    .select("id, profile_id, report_date, did_today, materials_tomorrow, gps_summary, status, created_at, profiles:profile_id(full_name)")
    .gte("report_date", reportsSince)
    .order("report_date", { ascending: false })
    .order("created_at", { ascending: false });
  const dailyReports = ((reportRows ?? []) as any[]).map((r) => ({
    id: r.id as string,
    report_date: r.report_date as string,
    did_today: (r.did_today ?? null) as string | null,
    materials_tomorrow: (r.materials_tomorrow ?? null) as string | null,
    gps: (r.gps_summary ?? null) as DailyReportSummary | null,
    status: (r.status ?? "filed") as string,
    name: (r.profiles?.full_name ?? "Crew member") as string,
  }));

  // rate_override MUST be selected here: the edit modal round-trips it on save, so
  // omitting the column made every unrelated week-list edit send undefined→null and
  // WIPE a supervisor override (the cn-v291 wipe-fix silently defeated). paid_at /
  // mileage_paid_at let the modal show the payroll locks instead of a save error.
  const { data: entries } = await supabase
    .from("time_entries")
    .select(
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, rate_override, paid_at, mileage_paid_at, job_id, job_code, status, notes, source, profiles:profile_id(full_name), job:job_id(job_number, name), time_allocations(job_id, job_code, hours, description)",
    )
    .gte("clock_in", start.toISOString())
    .lt("clock_in", end.toISOString())
    .order("clock_in", { ascending: true });
  // The pay spine (rate + commute baseline) rides the staff-scoped profile_pay view, not this
  // embed: 0216 revoked those columns from the authenticated role. This grid read them through
  // an ALIASED embed — profiles:profile_id(...) — which two earlier sweeps' patterns missed,
  // so the whole page 42501'd until this merge landed.
  {
    const pay = await payRateMap(supabase);
    for (const e of (entries ?? []) as any[]) {
      if (!e?.profile_id || !e.profiles) continue;
      e.profiles = { ...e.profiles, ...(pay.get(String(e.profile_id)) ?? {}) };
    }
  }

  // "Needs attention" pull — open entries that should have been closed: anything
  // still open from a PAST day (a forgotten clock-out) or open more than 12 hours
  // today. One cheap org-wide query (open entries are a handful at most), so the
  // strip works regardless of which week is being viewed.
  //
  // AND THE ZERO-HOUR ROWS (0193). A forgotten shift is now closed at zero hours by the DB when
  // its owner punches in again, so the person is never locked out of their own timecard. But a
  // CLOSED row does not match `status = 'open'`, so without this it would have vanished from the
  // one screen that exists to catch it — a real day silently worth nothing. `auto_closed_reason`
  // is null on every ordinary shift, so this adds exactly the rows that need a human.
  const { data: openNow } = await supabase
    .from("time_entries")
    .select(
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, job_id, job_code, status, notes, source, rate_override, auto_closed_reason, profiles:profile_id(full_name), job:job_id(job_number, name), time_allocations(job_id, job_code, hours, description)",
    )
    .or("status.eq.open,auto_closed_reason.not.is.null")
    .order("clock_in", { ascending: true });
  const todayStartMs = tzDayStartUtc(todayStrInTz(tz), tz).getTime();
  const needsAttention = (openNow ?? []).filter((e: any) => {
    // A zero-closed row needs the office WHENEVER it happened — it is not a forgotten shift any
    // more, it is a shift with no hours on it, and that never ages out of being wrong.
    if (e.auto_closed_reason) return true;
    const inMs = new Date(e.clock_in).getTime();
    return inMs < todayStartMs || Date.now() - inMs > 12 * 3_600_000;
  });

  /**
   * PLAN vs ACTUAL for the week on screen. What the crew calendar said, against where the hours
   * actually landed. This is only meaningful now that the calendar holds real rows instead of a
   * suggestion that vanished on refresh — you cannot be wrong about a guess.
   *
   * Read tolerantly: the 0170 `kind` column is young, and a payroll review page must not go blank
   * because one column isn't there yet.
   */
  const planRows = await tolerateMissingColumns<{ profile_id: string; work_date: string; job_id: string | null; kind: string }[]>(
    () =>
      supabase
        .from("crew_day_assignments")
        .select("profile_id, work_date, job_id, kind")
        .gte("work_date", weekDayStrs[0])
        .lte("work_date", weekDayStrs[6]),
  );
  const drift = needsAttentionRows(
    comparePlanToActual(
      (planRows ?? []).map((r) => ({
        profileId: r.profile_id,
        workDate: r.work_date,
        jobId: r.job_id,
        kind: (r.kind === "off" ? "off" : "job") as "job" | "off",
      })),
      (entries ?? []).map((e: any) => ({
        profileId: e.profile_id,
        workDate: todayStrInTz(tz, new Date(e.clock_in)),
        jobId: e.job_id ?? null,
        // THE SAME ONE RULE. This hand-rolled `hoursBetween(...) - lunch/60` instead of handing
        // hoursBetween the lunch it already knows how to deduct, which skipped the clamp — a
        // short shift with a long lunch came out NEGATIVE here and zero everywhere else, and a
        // negative day is read as "no hours", which is the difference between a no_show finding
        // and an unplanned one. Two formulas that agree on ordinary days are still two formulas.
        hours: e.clock_out ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : 0,
      })),
    ),
  );
  const nameById = new Map<string, string>(((members ?? []) as any[]).map((m) => [m.id, m.full_name ?? "Crew member"]));
  // THE NAME, NOT THE NUMBER. Erik, three separate bug reports: "timecards and all jobs need to be
  // displayed as job name not job number everywhere" / "need to see job name not job number" /
  // "this week should show jobs worked not job codes". A number is a filing reference; nobody
  // recognises their own week from J-022. jobLabel is the SSOT and already prefers the name — these
  // three call sites were hand-rolling the label instead of asking it.
  const jobLabelById = new Map<string, string>(((jobs ?? []) as any[]).map((j) => [j.id, jobLabel(j)]));

  // Group by tech. (The hours-per-job-code tally that lived here is gone —
  // Erik: analytics territory, clutter on a payroll review page.)
  const byTech = new Map<string, { name: string; entries: any[]; hours: number; miles: number }>();

  for (const e of entries ?? []) {
    const name = (e as any).profiles?.full_name ?? "—";
    const rec =
      byTech.get(e.profile_id) ?? { name, entries: [] as any[], hours: 0, miles: 0 };
    rec.entries.push(e);
    rec.miles += Number(e.miles ?? 0);
    if (e.status === "closed" && e.clock_out) {
      rec.hours += hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    }
    byTech.set(e.profile_id, rec);
  }

  // Split each person's miles into the commute baseline vs reimbursable business
  // miles (baseline subtracted once per day-driven).
  const techs = [...byTech.values()]
    .map((rec) => {
      const baseline = Number(rec.entries[0]?.profiles?.commute_baseline_miles ?? 0);
      return { ...rec, baseline, mileage: summarizeMileage(rec.entries, baseline, tz) };
    })
    .sort((a, b) => b.hours - a.hours);
  const label = `${start.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })} – ${new Date(
    end.getTime() - 1,
  ).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}`;

  // ── THE week grid (Erik: "I work a lot better seeing the blocks located in
  // their time allotment") — every entry is a pill positioned by clock-in →
  // clock-out, ONE COLOR PER PERSON (stable hash of profile id), open entries
  // running to the live now line. A heavier column divider marks the day a new
  // PAY PERIOD starts, so the payroll week reads against the pay cycle.
  const todayStr = todayStrInTz(tz);
  const workWin = workDayWindowHm((org as any)?.settings);
  // The single-week grid arrays died with the single-week grid: each week in the stack
  // builds its own events from the wide read below.
  /* ── THE SCROLLING RECORD ────────────────────────────────────────────────────────────────
     Erik: "continuous scroll which should also be on timecards with pay period break lines."
     A separate, LIGHT read: only what a pill needs, over a wide span, so the stack has weeks to
     scroll through without dragging the edit modal's whole projection (rate_override, allocations,
     payroll locks) across six months of rows. The single-week `entries` above still feeds the
     per-person lists and the editor, unchanged. */
  const stackFrom = new Date(start.getTime() - 26 * 7 * 86_400_000).toISOString();
  const stackTo = new Date(end.getTime() + 8 * 7 * 86_400_000).toISOString();
  const { data: stackRows } = await supabase
    .from("time_entries")
    .select("id, profile_id, clock_in, clock_out, lunch_minutes, job_id, profiles:profile_id(full_name), job:job_id(job_number, name)")
    .gte("clock_in", stackFrom)
    .lt("clock_in", stackTo)
    /* DESCENDING, because LIMIT applies after ORDER. Ascending kept the OLDEST 4000 rows, so the
       moment an org crossed the cap the CURRENT week — the page's anchor and default view — went
       blank while six-month-old weeks rendered fine. Overflow now eats the far end of the scroll,
       which the "Six months back" notice already marks as bounded. Render order is irrelevant:
       the stack groups by day and the grid positions by minutes. */
    .order("clock_in", { ascending: false })
    .limit(4000);
  /* The deep link names the ENTRY'S OWN WEEK. The stack shows 26 weeks but this page anchors on
     ?week=, so a link stamped with the PAGE's offset pointed a two-weeks-ago entry at the current
     week — the editor still opened (the fallback fetch), but a refresh or share of that URL lost
     the week it belonged to. Pure day-string arithmetic against the anchor week's first day. */
  const anchorStartMs = Date.parse(`${weekDayStrs[0]}T00:00:00Z`);
  const weekOf = (dayStr: string): number => {
    const ms = Date.parse(`${dayStr}T00:00:00Z`);
    if (!Number.isFinite(ms) || !Number.isFinite(anchorStartMs)) return offset;
    return Math.max(0, offset - Math.floor((ms - anchorStartMs) / (7 * 86_400_000)));
  };
  const stackEntries = ((stackRows ?? []) as any[]).map((e) => {
    const { dayStr, startMin, endMin } = timeEntryGridSpan(e.clock_in, e.clock_out, tz);
    /* ONE WEEK, ONE NUMBER (Erik: "it looks like duplicates").
     *
     * This mapper used to run an open shift against `Date.now()` and hand the stack a LIVE,
     * growing figure, while every other total on this page — and every total on /payroll — counts
     * closed shifts only. So the moment anybody was on the clock the same week showed two numbers
     * that disagreed, and neither said why. Two totals that differ by a shift in progress is not a
     * detail; it is the whole reason the page read as duplicated.
     *
     * The rule is now the app's one rule: hoursBetween, lunch deducted (the SSOT in lib/utils).
     * An open shift is worth ZERO hours — it has not been worked yet, and nothing gets paid on a
     * guess. But it is real and it is happening, so it still DRAWS on the grid, and `open` carries
     * the fact up to the stack, which says "still on the clock" where the number would be. Stated,
     * not hidden: the old live number was the app quietly counting hours nobody had earned. */
    const open = !e.clock_out;
    return {
      id: e.id as string,
      dayStr,
      startMin,
      endMin,
      hours: open ? 0 : hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes),
      open,
      label: `${firstNameOf(e.profiles?.full_name)}${e.job ? ` · ${jobLabel(e.job)}` : ""}`,
      sub: `${formatTime(e.clock_in, tz)}–${e.clock_out ? formatTime(e.clock_out, tz) : "now"}`,
      color: pillColorForPerson(e.profile_id).pill,
      href: `/timecards?week=${weekOf(dayStr)}&entry=${e.id}`,
    };
  });

  const gridLegend = [...byTech.entries()].map(([pid, rec]) => ({
    id: pid,
    name: rec.name,
    dot: pillColorForPerson(pid).dot,
  }));
  const gridNow = { dayStr: todayStr, min: tzMinutesOfDay(new Date(), tz) };
  const onClock = crew.filter((c) => c.clockedIn);

  const supId = getOrgSettings((org as any)?.settings).timecard_supervisor_id;
  const approver = supId
    ? (members?.find((m: any) => m.id === supId)?.full_name ?? "—")
    : "Owner";

  /* ── WHAT HE OWES, IN ONE ROW ──────────────────────────────────────────────────────────────
   *
   *  WHAT WAS HERE: the "Pay period" card — every person with hours, their gross, and a paid
   *  badge. It answered a real question in July, when nothing else did. It is now a read-only
   *  mirror of /payroll printed two inches under a grid of the same hours, which is exactly what
   *  Erik is looking at when he says "way too much in my face i dont even know what it all is and
   *  it looks like duplicates" and "mold as much together as possible". /payroll shipped last
   *  night with real payments behind that question, so this becomes its headline and a door.
   *
   *  THE SAME ARITHMETIC, NOT A SECOND ONE: balanceForPerson (pure, unit-tested) over the same
   *  reads /payroll makes, so the figure he taps and the figure he lands on cannot disagree.
   *
   *  AND THE SAME REFUSAL: a balance is subtraction, so a list that came back short or broken
   *  does not read as an error, it reads as a confident wrong number. Any broken read and this
   *  row shows NO figure at all — just the way in (MONEY: never invent a figure). */
  const balanceWindowYmd = (() => {
    const d = new Date(`${todayStr}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - BALANCE_MONTHS);
    return d.toISOString().slice(0, 10);
  })();
  const balanceWindowIso = tzDayStartUtc(balanceWindowYmd, tz).toISOString();
  const [balClosed, balOpen, balPayments, balRuns, balRates] = await Promise.all([
    readAll<any>((from, to) =>
      supabase
        .from("time_entries")
        .select(BALANCE_ENTRY_COLS)
        .eq("status", "closed")
        .not("clock_out", "is", null)
        .gte("clock_in", balanceWindowIso)
        .order("id")
        .range(from, to),
    ),
    // Open shifts ride along so balanceForPerson can SEE them; hoursBetween prices them at zero,
    // so they can never inflate a balance — the same rule the grid above now obeys.
    readAll<any>((from, to) =>
      supabase
        .from("time_entries")
        .select(BALANCE_ENTRY_COLS)
        .is("clock_out", null)
        .gte("clock_in", balanceWindowIso)
        .order("id")
        .range(from, to),
    ),
    // EVERY payment, all time, never windowed: `paid` is an all-time sum by contract, and a
    // payment dropped by a date filter reappears on screen as money he still owes.
    readAll<any>((from, to) =>
      supabase
        .from("pay_payments")
        .select("id, profile_id, amount, paid_on, method, reference, note, needs_check, voided_at, created_at")
        .order("id")
        .range(from, to),
    ),
    // The FROZEN half of earned. kind='base' ONLY — mileage dollars must never reach a wages
    // balance (0095's two-lock rule).
    readAll<any>((from, to) =>
      supabase
        .from("payroll_runs")
        .select("profile_id, period_start, period_end, gross")
        .eq("kind", "base")
        .order("id")
        .range(from, to),
    ),
    // The rate multiplies every unlocked dollar, so a dropped read prices every unpaid hour at
    // zero and "You Owe $0" is a lie. It refuses with the other four.
    payRateMapRead(supabase),
  ]);
  const owedUnreadable = [balClosed, balOpen, balPayments, balRuns, balRates].some((r) => !!r.problem);
  let owedTotal = 0;
  let owedPeople = 0;
  if (!owedUnreadable) {
    // Rates come from the staff-scoped profile_pay view, not the embed (0215/0216 revoked those
    // columns from the authenticated role).
    attachRates(balClosed.rows, balRates.rates, (e: any) => ({ id: e.profile_id, holder: e }));
    attachRates(balOpen.rows, balRates.rates, (e: any) => ({ id: e.profile_id, holder: e }));
    const push = <T,>(m: Map<string, T[]>, k: string, v: T) => {
      const a = m.get(k);
      if (a) a.push(v);
      else m.set(k, [v]);
    };
    const entriesByPerson = new Map<string, any[]>();
    for (const e of [...balClosed.rows, ...balOpen.rows]) {
      const id = e.profile_id ? String(e.profile_id) : "";
      if (id) push(entriesByPerson, id, e);
    }
    const lockedByPerson = new Map<string, { period_start: string; period_end: string; gross: number }[]>();
    for (const r of balRuns.rows) {
      const id = r.profile_id ? String(r.profile_id) : "";
      if (id) {
        push(lockedByPerson, id, {
          period_start: String(r.period_start),
          period_end: String(r.period_end),
          gross: Number(r.gross ?? 0),
        });
      }
    }
    const paymentsByPerson = new Map<string, PayPaymentRow[]>();
    for (const p of balPayments.rows.map(toPayPaymentRow)) push(paymentsByPerson, p.profileId, p);

    const ids = new Set<string>([...entriesByPerson.keys(), ...lockedByPerson.keys(), ...paymentsByPerson.keys()]);
    const balances: PersonBalance[] = [...ids].map((id) =>
      balanceForPerson({
        profileId: id,
        name: nameById.get(id) ?? "—",
        entries: entriesByPerson.get(id) ?? [],
        lockedRuns: lockedByPerson.get(id) ?? [],
        payments: paymentsByPerson.get(id) ?? [],
        tz,
        fallbackRate: Number(balRates.rates.get(id)?.hourly_rate ?? 0),
      }),
    );
    // /payroll's rule, word for word: what he OWES, not a net position. A man who is ahead does
    // not reduce what the next man is owed, so only positive balances are summed — and a zero or
    // negative balance is not a person he owes, so it is not in the count either.
    const owing = balances.filter((b) => b.owed > 0.005);
    owedPeople = owing.length;
    owedTotal = Math.round(owing.reduce((s, b) => s + b.owed, 0) * 100) / 100;
  }

  /* ── FIX THESE ─────────────────────────────────────────────────────────────────────────────
   *
   *  TWO CARDS BECOME ONE. "Different from the plan" and "Needs attention" sat back to back with
   *  near-identical amber chrome and no line between them, so they read as one long
   *  undifferentiated warning list — Erik: "i dont even know what it all is and it looks like
   *  duplicates". They ARE one list, so this stops pretending otherwise and puts them in the
   *  order the money is in.
   *
   *  WORST MONEY FIRST. A broken shift is hours that are WRONG — a forgotten clock-out inflating
   *  a week, or a 0193 ghost auto-closed at zero and worth nothing — and that is the next check.
   *  A plan drift is hours that are probably RIGHT but filed against the wrong job, which costs
   *  later, at invoicing. So broken rows first in normal weight, drift under a rule in lighter
   *  type.
   *
   *  Both feeders are unchanged: `needsAttention` above, and comparePlanToActual / needsAttention
   *  / explain from lib/plan-vs-actual. */
  const entryIdByPersonDay = new Map<string, string>();
  for (const e of (entries ?? []) as any[]) {
    const k = `${e.profile_id}|${todayStrInTz(tz, new Date(e.clock_in))}`;
    if (!entryIdByPersonDay.has(k)) entryIdByPersonDay.set(k, String(e.id));
  }
  const brokenRows = (needsAttention as any[]).map((e) => {
    const day = todayStrInTz(tz, new Date(e.clock_in));
    const openHrs = formatDuration(hoursBetween(e.clock_in, new Date(), 0));
    return {
      id: String(e.id),
      name: e.profiles?.full_name ?? "—",
      when: formatDateTimeTz(e.clock_in, tz),
      job: e.job ? jobLabel(e.job) : null,
      /* A zero-closed row is NOT open (audit 7: "Brian · open 98h" on a shift 0193 closed at zero
         on Monday was a lie that grew by the hour). Say what the system actually did, with its
         reason. Kept word for word from the card this replaces. */
      badge: e.auto_closed_reason
        ? `auto-closed — ${String(e.auto_closed_reason).replace(/_/g, " ")}`
        : new Date(e.clock_in).getTime() < todayStartMs
          ? `open ${openHrs} · past day`
          : `open ${openHrs}`,
      // The deep link names the ENTRY'S OWN WEEK, not the page's (same reason as the grid pills).
      href: `/timecards?week=${weekOf(day)}&entry=${e.id}`,
    };
  });
  const driftRows = drift.slice(0, 8).map((r) => {
    const entryId = entryIdByPersonDay.get(`${r.profileId}|${r.workDate}`);
    return {
      key: `${r.profileId}|${r.workDate}`,
      date: formatDate(r.workDate),
      text: explain(r, (id) => jobLabelById.get(id) ?? "a job", nameById.get(r.profileId) ?? "Someone"),
      /* ONE WAY IN, NOT TWO. A drift row with hours has an entry behind it, so it opens that
         entry's editor through the ?entry= door OpenEntryEditor already answers — no second
         mechanism invented here. A no_show has no entry to open BY DEFINITION (that is what
         no_show means), and a row with nowhere to go is a dead end, so that one goes to its day
         on the calendar, where the stale plan actually lives. */
      href: entryId ? `/timecards?week=${weekOf(r.workDate)}&entry=${entryId}` : `/schedule?view=day&date=${r.workDate}`,
    };
  });
  const fixCount = brokenRows.length + drift.length;

  // The ?entry= deep link (a grid pill tap) — find the entry and auto-open its editor below.
  // The stack scrolls 26 weeks, but `entries` holds ONE week — so a tap on any pill outside the
  // anchor week found nothing and silently opened nothing (Erik: "i cant get into the timecard
  // entry by clicking on it i had to go around into the job"). Missing from the week? Fetch the
  // row itself, same projection the editor round-trips.
  let focusEntry = entryParam
    ? (([...(entries ?? []), ...(openNow ?? [])] as any[]).find((e) => e.id === entryParam) ?? null)
    : null;
  if (entryParam && !focusEntry) {
    const { data: one } = await supabase
      .from("time_entries")
      .select(
        "id, profile_id, clock_in, clock_out, lunch_minutes, miles, rate_override, paid_at, mileage_paid_at, job_id, job_code, status, notes, source, profiles:profile_id(full_name), job:job_id(job_number, name), time_allocations(job_id, job_code, hours, description)",
      )
      .eq("id", entryParam)
      .maybeSingle();
    if (one) {
      const pay = await payRateMap(supabase);
      if ((one as any).profile_id && (one as any).profiles) {
        (one as any).profiles = { ...(one as any).profiles, ...(pay.get(String((one as any).profile_id)) ?? {}) };
      }
      focusEntry = one as any;
    }
  }

  return (
    <div>
      <PageHeader title="Timecards" description={`Review your crew's hours by week.  ·  Approver: ${approver}`}>
        <div className="flex flex-wrap items-center gap-2">
          <AddEntryButton
            isStaff
            jobCodesEnabled={orgSettings.timeclock_job_codes}
            members={members ?? []}
            jobCodes={(jobCodes ?? []) as JobCode[]}
            jobs={jobs ?? []}
            tz={tz}
          />
          <Link
            href={`/timecards?week=${offset + 1}`}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            title="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[140px] text-center text-sm font-medium text-slate-700">
            {offset === 0 ? "This week" : label}
          </span>
          <Link
            href={`/timecards?week=${Math.max(0, offset - 1)}`}
            className={`rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50 ${
              offset === 0 ? "pointer-events-none opacity-40" : ""
            }`}
            title="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </PageHeader>

      {/* Live presence — the crew pulse that used to be My Day's CrewBoard: who's on
          the clock RIGHT NOW, living next to the hours it becomes (Erik, cn-v503). The block
          stays exactly where cn-v503 put it and reads the same getCrewStatus; only the SIZE
          changed. It was text-xs pills wrapped into one line, and this is the thing he checks
          from a ladder in the sun — 10px of grey inside a pill is not readable at arm's length.
          One person per row, at reading size. */}
      {crew.length > 0 && (
        <Card className="mb-4">
          <CardContent className="py-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">On the clock</span>
              <span className="text-xs text-slate-500">
                {onClock.length} of {crew.length}
              </span>
            </div>
            {onClock.length === 0 ? (
              <p className="mt-1 text-base text-slate-400">Nobody right now</p>
            ) : (
              <ul className="mt-0.5">
                {onClock.map((c) => (
                  <li key={c.id} className="flex min-h-[44px] items-center gap-2.5 text-base">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" aria-hidden />
                    <span className="shrink-0 font-medium text-slate-900">{c.name}</span>
                    {c.jobLabel && <span className="min-w-0 truncate text-slate-500">{c.jobLabel}</span>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* THE PRIMARY VIEW — the week as a Google-Calendar-style time grid: each
          entry a pill in its time allotment, one color per person (legend above),
          the heavier divider = a pay-period boundary day. The editable per-person
          table stays below — this grid is display; edits keep their tools. */}
      <div className="mb-4">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-semibold text-slate-900">Hours</span>
          {gridLegend.map((p) => (
            <span key={p.id} className="flex items-center gap-1 text-xs text-slate-600">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.dot}`} aria-hidden /> {p.name}
            </span>
          ))}
        </div>
        {/* THE WEEKS RUN, AND THE PAY PERIODS ARE MARKED ACROSS THEM. The single week behind two
            arrows is gone: reading "what did we pay him last period" used to mean clicking back,
            reading, clicking back, reading, and holding both halves in your head — for the one
            number this page exists to produce. Same grid and same scroll hook as the schedule. */}
        <TimecardStack
          entries={stackEntries}
          anchorWeek={weekDayStrs}
          todayStr={todayStr}
          workStartMin={hmToMin(workWin.start)}
          workEndMin={hmToMin(workWin.end)}
          tz={tz}
          nowMin={gridNow.min}
          paySchedule={orgSettings.pay_schedule}
          payAnchor={orgSettings.pay_anchor}
        />
      </div>

      {/* A grid pill tap lands here: mount THAT entry's editor already open.
          Keyed by id so tapping a different pill remounts fresh state. */}
      {focusEntry && (
        <OpenEntryEditor
          key={focusEntry.id}
          entry={focusEntry}
          jobCodes={(jobCodes ?? []) as JobCode[]}
          jobs={jobs ?? []}
          members={members ?? []}
          jobCodesEnabled={orgSettings.timeclock_job_codes}
        />
      )}

      {/* ONE ROW WHERE THE ROSTER WAS. The Pay page owns "what do I owe" now, with the payments
          behind it; this is its headline and the door. The WHOLE ROW is the target (a link inside
          a row is a smaller thing to hit than the row), 44px, and the figure is the same
          balanceForPerson arithmetic that page runs — or no figure at all. */}
      <Link
        href="/payroll"
        className="mb-4 flex min-h-[44px] w-full items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 active:bg-slate-50"
      >
        <span className="min-w-0 flex-1">
          {owedUnreadable ? (
            <>
              <span className="block text-base font-semibold text-slate-900">Open Pay</span>
              {/* NOTHING SILENT, and never a figure he could act on that might be wrong. */}
              <span className="block text-sm text-slate-500">
                No amount is shown here right now because the pay records could not be read whole. Your hours below are
                fine.
              </span>
            </>
          ) : owedPeople === 0 ? (
            <>
              <span className="block text-base font-semibold text-slate-900">Everyone is paid up</span>
              <span className="block text-sm text-slate-500">Open Pay</span>
            </>
          ) : (
            <>
              <span className="block text-base font-semibold text-slate-900">You Owe {formatCurrency(owedTotal)}</span>
              <span className="block text-sm text-slate-500">
                across {owedPeople} {owedPeople === 1 ? "person" : "people"} · Open Pay
              </span>
            </>
          )}
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
      </Link>

      {/* ── FIX THESE ─────────────────────────────────────────────────────────────────────────
          One amber card where "Needs attention" and "Different from the plan" used to sit back to
          back. Both are still here, both feeders untouched — broken hours first (money on the
          next check), plan drift under the rule in lighter type (money at invoicing).

          KEPT FROM THE PLAN CARD, because it is the reason that list is allowed to exist: this is
          NOT a discipline tool. A mismatch is nearly always a stale plan, not somebody lying — a
          crew gets pulled to a callback, a job finishes early. The value is the office seeing it
          on Friday rather than at invoicing, when the hours are already on the wrong job and the
          customer is already looking at the number. */}
      {fixCount > 0 ? (
        <Card className="mb-4 border-amber-200 bg-amber-50/60">
          <CardContent className="py-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0" /> Fix These ({fixCount})
            </h3>
            {brokenRows.length > 0 && (
              <ul className="divide-y divide-amber-200/60">
                {brokenRows.map((r) => (
                  <li key={r.id}>
                    {/* The WHOLE ROW opens that entry's editor, through the ?entry= door that was
                        already there and simply had a small button in front of it. */}
                    <Link
                      href={r.href}
                      scroll={false}
                      className="flex min-h-[44px] items-center gap-2 py-2 text-sm active:bg-amber-100/60"
                    >
                      <span className="min-w-0 flex-1 text-slate-800">
                        <span className="font-medium">{r.name}</span>
                        <span className="text-slate-500"> · in {r.when}</span>
                        {r.job && <span className="text-slate-500"> · {r.job}</span>}
                        <Badge tone="amber" className="ml-2">
                          {r.badge}
                        </Badge>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {driftRows.length > 0 && (
              <>
                {brokenRows.length > 0 && <div className="my-1 border-t border-amber-200/80" />}
                <ul>
                  {driftRows.map((r) => (
                    <li key={r.key}>
                      <Link
                        href={r.href}
                        scroll={false}
                        className="flex min-h-[44px] items-center gap-2 py-2 text-sm font-light text-slate-600 active:bg-amber-100/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-xs tabular-nums text-slate-400">{r.date}</span> {r.text}
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
                {drift.length > driftRows.length && (
                  <p className="text-xs text-slate-400">+{drift.length - driftRows.length} more this week.</p>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  A plan line is usually the plan moving and nobody updating it. Worth a look before these hours go on
                  an invoice.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        /* NOTHING SILENT: a missing warning has to be AFFIRMED. Without this line the page looks
           exactly the same when everything is clean and when the check never ran, and "no news"
           is not something you can trust a payroll week to. */
        <p className="mb-4 flex min-h-[44px] items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 text-sm font-medium text-emerald-900">
          <Check className="h-4 w-4 shrink-0" aria-hidden /> Nothing needs fixing this week.
        </p>
      )}

      {/* Crew-lead daily reports — what got done + materials needed tomorrow, with the
          GPS day story. This is the review surface the daily_report notification deep-links
          to; "Mark reviewed" checks a report off (0128's filed → reviewed).
          KNOWN GAP (audit 2026-07-16): 0128's design says "filed for office EDITING" and the
          update RLS grants staff that write, but no UI anywhere edits a report's
          did_today/materials_tomorrow — this list is read+review only. Build the edit
          affordance here if the office ever needs to correct a filed report. */}
      {dailyReports.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <span className="text-sm font-semibold text-slate-800">Daily reports</span>
            <span className="text-xs font-medium text-slate-500">last 14 days</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {dailyReports.map((r) => (
              <li key={r.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-sm">
                    <span className="font-semibold text-slate-900">{r.name}</span>
                    <span className="ml-2 text-slate-500">{formatDate(r.report_date)}</span>
                    {r.status === "reviewed" && <Badge tone="green" className="ml-2">reviewed</Badge>}
                  </div>
                  {r.status !== "reviewed" && <MarkReportReviewedButton id={r.id} />}
                </div>
                {r.did_today && (
                  <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{r.did_today}</p>
                )}
                {r.materials_tomorrow && (
                  <p className="mt-1 whitespace-pre-line text-sm text-amber-700">
                    <span className="font-medium">Materials for tomorrow:</span> {r.materials_tomorrow}
                  </p>
                )}
                {r.gps && (
                  <div className="mt-1.5 text-xs text-slate-500">
                    <span className="font-medium text-slate-600">{formatDuration(Number(r.gps.total_hours) || 0)}</span>
                    {Number(r.gps.miles) > 0 && <span> · {Number(r.gps.miles).toFixed(1)} mi</span>}
                    {r.gps.first_in && <span> · first in {formatTime(r.gps.first_in, tz)}</span>}
                    {r.gps.last_out && <span> · last out {formatTime(r.gps.last_out, tz)}</span>}
                    {(r.gps.jobs ?? []).length > 0 && (
                      <span>
                        {" · "}
                        {(r.gps.jobs ?? [])
                          .map((jr) => `${jr.label} ${formatDuration(Number(jr.hours) || 0)}`)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* THE THREE STAT TILES ARE GONE (Erik: "way too much in my face i dont even know what it
          all is and it looks like duplicates"). All three predate the week stack — "Crew hours"
          and "People with entries" came with the original page in June, "Business miles" with
          cn-v138 — and the stack took over what two of them said without anyone retiring them:

            · "Crew hours" restated the week total the stack header prints two inches above it,
              and DISAGREED with it whenever somebody was on the clock (that gap is the arithmetic
              bug fixed in this wave). The stack header is now the one week number.
            · "People with entries" was the length of the list immediately below it.
            · "Business miles" survives per person, on each person's card below, where a mileage
              settlement is actually made. Miles are DATA — no app-computed dollars, here or
              there: mileage pay is a human-typed settlement on /payroll, never rate × miles.

          Also long gone, and staying gone (Erik 7/15, analytics territory): "Hours by job code",
          "Hours this pay period", "Accumulated hours · all time". */}

      {techs.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No time entries this week"
          description="Clock-ins for the selected week will show up here."
        />
      ) : (
        <div className="space-y-4">
          {techs.map((rec) => (
            <Card key={rec.name}>
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                    {initials(rec.name)}
                  </div>
                  <span className="text-sm font-semibold text-slate-900">{rec.name}</span>
                </div>
                <span className="text-sm font-bold text-slate-900">
                  {formatDuration(rec.hours)}
                  {rec.mileage.recorded > 0 && (
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      {rec.baseline > 0
                        ? `${rec.mileage.business.toFixed(1)} mi business · ${rec.mileage.recorded.toFixed(1)} logged`
                        : `${rec.mileage.recorded.toFixed(1)} mi`}
                    </span>
                  )}
                </span>
              </div>
              <ul className="divide-y divide-slate-100">
                {rec.entries.map((e: any) => {
                  const h =
                    e.status === "closed" && e.clock_out
                      ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes)
                      : null;
                  return (
                    <li key={e.id} className="px-5 py-3">
                      <div className="flex items-center justify-between text-sm">
                        <div className="text-slate-700">
                          {formatDateTimeTz(e.clock_in, tz)}
                          {" → "}
                          {e.clock_out ? formatDateTimeTz(e.clock_out, tz) : (
                            <Badge tone="green">open</Badge>
                          )}
                          {e.job && (
                            <Link href={`/jobs/${e.job_id}`} className="ml-2 font-medium text-brand hover:underline">
                              {jobLabel(e.job)}
                            </Link>
                          )}
                          {e.job_code && (
                            <Badge tone="slate" className="ml-2">
                              {e.job_code}
                            </Badge>
                          )}
                          {e.source === "manual" && (
                            <Badge tone="amber" className="ml-1">manual</Badge>
                          )}
                          {/* DISCLOSURE IS THE GUARD (0168). An offline punch's start time came
                              from the phone, not the server clock — nothing can prove it was made
                              live rather than backdated, so the card says where it came from and
                              lets the office judge. */}
                          {e.source === "offline" && (
                            <Badge tone="blue" className="ml-1" title="Punched with no signal — time came from the phone">
                              offline
                            </Badge>
                          )}
                          {e.lunch_minutes > 0 && (
                            <span className="ml-2 text-xs text-slate-400">
                              lunch {e.lunch_minutes}m
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-800">
                            {h != null ? formatDuration(h) : "—"}
                          </span>
                          {e.status === "closed" && <DuplicateEntryButton id={e.id} />}
                          <EditEntryButton
                            entry={e}
                            jobCodes={(jobCodes ?? []) as JobCode[]}
                            jobs={jobs ?? []}
                            members={members ?? []}
                            isStaff
                            jobCodesEnabled={orgSettings.timeclock_job_codes}
                          />
                        </div>
                      </div>
                      {e.notes && (
                        <p className="mt-1 text-xs text-slate-500">{e.notes}</p>
                      )}
                      {e.time_allocations && e.time_allocations.length > 0 && (
                        <ul className="mt-1.5 space-y-1">
                          {e.time_allocations.map((a: any, i: number) => (
                            <li key={i} className="flex items-start gap-2 text-xs text-slate-600">
                              {a.job_code && <Badge tone="blue">{a.job_code}</Badge>}
                              <span className="text-slate-500">{formatDuration(a.hours)}</span>
                              {a.description && <span>· {a.description}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
