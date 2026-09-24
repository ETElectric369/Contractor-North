import { attachRates, payRateMap, payRateMapRead } from "@/lib/profile-columns";
import Link from "next/link";
import type { ReactNode } from "react";
import { isStaffRole } from "@/lib/actions/perms";
import { redirect } from "next/navigation";
import { AlertTriangle, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/segmented";
import {
  formatCurrency,
  formatDuration,
  formatDateShort,
  formatTime,
  hoursBetween,
} from "@/lib/utils";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { formatDateTimeTz, timeEntryGridSpan, tzDayStartUtc, tzMinutesOfDay, todayStrInTz } from "@/lib/tz";
import { balanceForPerson, drawIdsFrom, toPayPaymentRow, wagesOnly, type PayPaymentRow, type PersonBalance } from "@/lib/payroll-math";
import { getCrewStatus } from "@/lib/crew-status";
import { firstNameOf, pillColorForPerson } from "@/lib/employee-color";
import { TimecardStack, type Grouping, type StackEntry } from "./timecard-stack";
import { hmToMin } from "@/lib/tz";
import { AddEntryButton } from "../timeclock/add-entry-button";
import { EditEntryButton } from "./edit-entry-button";
import { OpenEntryEditor } from "./open-entry-editor";
import { familyWasConverted, splitFamilies, splitNeighbors } from "@/lib/split-family";
import { DuplicateEntryButton } from "./duplicate-entry-button";
import type { JobCode } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";
import { LONG_SHIFT_HOURS, isLongOpenShift } from "@/lib/long-shift";

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
  searchParams: Promise<{ week?: string; entry?: string; group?: string; split?: string; at?: string; job?: string; code?: string }>;
}) {
  const { week, entry: entryParam, group, split: splitParam, at: splitAtParam, job: splitJobParam, code: splitCodeParam } = await searchParams;
  const offset = Math.max(0, parseInt(week ?? "0", 10) || 0);
  /* ── HOW THE LEDGER IS STACKED ────────────────────────────────────────────────────────────
   *  By Day or By Person, in the URL, because he is not choosing it once: he pages weeks with
   *  the arrows, taps a shift, saves, and the page revalidates under him. A ?group= ride-along
   *  survives every one of those AND a refresh, where component state would have quietly put him
   *  back on By Day each time. It changes the GROUPING INSIDE each week and nothing else — never
   *  the span, so the number in a week header is always summed from the rows under it. */
  const grouping: Grouping = group === "person" ? "person" : "day";
  /** Every link back to this page carries the grouping, or the toggle resets the moment he pages
   *  a week or opens an entry (the paging arrows, the stack rows, the Fix These rows). */
  const hrefFor = (weekOffset: number, extra?: string) =>
    `/timecards?week=${weekOffset}${grouping === "person" ? "&group=person" : ""}${extra ? `&${extra}` : ""}`;
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
    supabase.from("profile_pay").select("id, full_name, hourly_rate, bill_rate, paid_by_draw").eq("active", true).order("full_name"),
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

  // rate_override MUST be selected here: the edit modal round-trips it on save, so
  // omitting the column made every unrelated week-list edit send undefined→null and
  // WIPE a supervisor override (the cn-v291 wipe-fix silently defeated). paid_at /
  // mileage_paid_at let the modal show the payroll locks instead of a save error.
  const { data: entries } = await supabase
    .from("time_entries")
    .select(
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, rate_override, paid_at, mileage_paid_at, job_id, job_code, status, notes, source, split_from, split_how, profiles:profile_id(full_name), job:job_id(job_number, name)",
    )
    .gte("clock_in", start.toISOString())
    .lt("clock_in", end.toISOString())
    .order("clock_in", { ascending: true });
  // The pay spine (rate + commute baseline) rides the staff-scoped profile_pay view, not this
  // embed: 0216 revoked those columns from the authenticated role. This grid read them through
  // an ALIASED embed — profiles:profile_id(...) — which two earlier sweeps' patterns missed,
  // so the whole page 42501'd until this merge landed.
  const payMap = await payRateMap(supabase);
  for (const e of (entries ?? []) as any[]) {
    if (!e?.profile_id || !e.profiles) continue;
    e.profiles = { ...e.profiles, ...(payMap.get(String(e.profile_id)) ?? {}) };
  }
  /** The commute baseline, per person, for the By Person mileage split (cn-v138). Off the
   *  staff-scoped view, never off `profiles` (0216). */
  const baselineById: Record<string, number> = {};
  for (const [id, r] of payMap) baselineById[id] = Number(r.commute_baseline_miles ?? 0);

  // "Needs attention" pull — open entries that should have been closed: anything
  // still open from a PAST day (a forgotten clock-out) or open LONG_SHIFT_HOURS or more
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
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, job_id, job_code, status, notes, source, rate_override, auto_closed_reason, split_from, split_how, profiles:profile_id(full_name), job:job_id(job_number, name)",
    )
    .or("status.eq.open,auto_closed_reason.not.is.null")
    .order("clock_in", { ascending: true });
  const todayStartMs = tzDayStartUtc(todayStrInTz(tz), tz).getTime();
  const needsAttention = (openNow ?? []).filter((e: any) => {
    // A zero-closed row needs the office WHENEVER it happened — it is not a forgotten shift any
    // more, it is a shift with no hours on it, and that never ages out of being wrong.
    if (e.auto_closed_reason) return true;
    const inMs = new Date(e.clock_in).getTime();
    // The shared long-shift rule (lib/long-shift), not a threshold of this page's own.
    return inMs < todayStartMs || Date.now() - inMs >= LONG_SHIFT_HOURS * 3_600_000;
  });

  const nameById = new Map<string, string>(((members ?? []) as any[]).map((m) => [m.id, m.full_name ?? "Crew member"]));

  /* WHO IS IN THIS WEEK — names for the grid legend, in the order their first shift lands.
   *  (The per-person TALLY that used to be built here — hours, miles, a Card each — is gone: it
   *  was a second rendering of the stack's own shifts, and it is now the stack's By Person
   *  grouping, summing the same rows. The hours-per-job-code tally died before it, Erik:
   *  analytics territory, clutter on a payroll review page.) */
  const legendNames = new Map<string, string>();
  for (const e of (entries ?? []) as any[]) {
    const id = String(e.profile_id ?? "");
    if (id && !legendNames.has(id)) legendNames.set(id, e.profiles?.full_name ?? "—");
  }
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
     scroll through without dragging the edit modal's whole projection (rate_override,
     payroll locks) across six months of rows. The single-week `entries` above still feeds the
     per-person lists and the editor, unchanged. */
  const stackFrom = new Date(start.getTime() - 26 * 7 * 86_400_000).toISOString();
  const stackTo = new Date(end.getTime() + 8 * 7 * 86_400_000).toISOString();
  const { data: stackRows } = await supabase
    .from("time_entries")
    .select(
      /* job_code / source / notes / miles ride along now that this list is THE list: they are
         four flat columns, not the editor's projection, and two of them are disclosures (0168's
         manual/offline provenance) that must not go quiet just because a row is three weeks old.
         split_from / split_how (0288) are what brackets the pieces of one split shift. */
      "id, profile_id, clock_in, clock_out, lunch_minutes, job_id, job_code, source, notes, miles, split_from, split_how, profiles:profile_id(full_name), job:job_id(job_number, name)",
    )
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
  /* ── THE DETAIL THAT USED TO BE A SECOND LIST ─────────────────────────────────────────────
   *
   *  Under the stack sat one Card per person, re-listing that person's week. The SAME SHIFTS the
   *  stack was already drawing. Erik: "it looks like duplicates … lets try and mold as much
   *  together as possible." So the detail moves ONTO the stack's row and the cards go.
   *
   *  The two controls need the editor's whole projection (the payroll locks, rate_override), which
   *  is read for the ANCHORED WEEK only. A row from an older week still opens its editor with one
   *  tap (the ?entry= door below fetches the row it needs), so an older row is never a dead end.
   *
   *  A SPLIT SHIFT IS ENTRIES (0288). The pieces of one shift are ordinary rows; the editor offers
   *  Move The Split and Join Back between two touching pieces of the same family, found here from
   *  the same week's rows. */
  const weekRows = (entries ?? []) as any[];
  const neighborLabel = (r: any) => (r?.job ? jobLabel(r.job) : (r?.job_code ?? "no job"));
  const neighborsOf = (rows: any[], id: string) => {
    const n = splitNeighbors(rows, id);
    const pack = (r: any) =>
      r
        ? {
            id: String(r.id),
            clock_in: String(r.clock_in),
            clock_out: String(r.clock_out),
            label: neighborLabel(r),
            // Join Back names whose job the hours land on, and its Undo cuts the shift back the way it was.
            job_id: r.job_id ?? null,
            job_code: r.job_code ?? null,
            lunch_minutes: r.lunch_minutes ?? 0,
            miles: r.miles ?? 0,
          }
        : null;
    return n.prev || n.next ? { prev: pack(n.prev), next: pack(n.next) } : null;
  };
  /** The first piece of a rebuilt split carries no split_how of its own; its family says it. */
  const rebuiltOf = (rows: any[], id: string) => {
    const key = splitFamilies(rows).get(id);
    return !!key && familyWasConverted(rows, key);
  };
  const detailById = new Map<string, { controls: ReactNode }>();
  for (const e of weekRows) {
    detailById.set(String(e.id), {
      controls: (
        <>
          {e.status === "closed" && (
            <DuplicateEntryButton
              id={e.id}
              profileId={e.profile_id}
              personName={e.profiles?.full_name}
              members={members ?? []}
            />
          )}
          <EditEntryButton
            entry={e}
            jobCodes={(jobCodes ?? []) as JobCode[]}
            jobs={jobs ?? []}
            members={members ?? []}
            isStaff
            jobCodesEnabled={orgSettings.timeclock_job_codes}
            tz={tz}
            neighbors={neighborsOf(weekRows, String(e.id))}
            rebuiltFromOldSplit={rebuiltOf(weekRows, String(e.id))}
            workDayEnd={workWin.end}
          />
        </>
      ),
    });
  }
  /* WHICH ROWS ARE ONE SHIFT: families over everything the stack draws (the wide read plus the
     anchored week), so the bracket holds whichever pieces are on screen. */
  const familyRows = [...((stackRows ?? []) as any[]), ...weekRows];
  const familyById = splitFamilies(familyRows);

  const toStackEntry = (e: any): StackEntry => {
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
    const detail = detailById.get(String(e.id));
    const color = pillColorForPerson(e.profile_id);
    return {
      id: String(e.id),
      personId: String(e.profile_id ?? ""),
      personName: e.profiles?.full_name ?? "—",
      person: firstNameOf(e.profiles?.full_name),
      dayStr,
      clockIn: String(e.clock_in),
      startMin,
      endMin,
      hours: open ? 0 : hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes),
      open,
      miles: Number(e.miles ?? 0),
      label: `${firstNameOf(e.profiles?.full_name)}${e.job ? ` · ${jobLabel(e.job)}` : ""}`,
      /* THE DAY IT ENDED, WHEN THAT IS NOT THE DAY IT STARTED.
       *
       * A row is filed under its clock-IN day — the By Day group header, or the day that leads
       * the row in By Person — and the span beside it is times only. So a shift punched 10:00 PM
       * Monday and closed 6:30 AM Tuesday read "10:00 PM–6:30 AM" under Monday, with nothing on
       * screen saying the clock-out was the next morning. timeEntryGridSpan clamps exactly this
       * case at 1440, so the app knows these shifts happen; the per-person card this row replaced
       * printed the DATE on both ends and never had the ambiguity.
       *
       * The hours were always right (hoursBetween is a duration), but this row is now the only
       * rendering of the shift and Erik pays people off it. So the out-day is named whenever it
       * differs, and stays out of the way on the ordinary shifts that end when they started. */
      sub: (() => {
        const from = formatTime(e.clock_in, tz);
        if (!e.clock_out) return `${from}–now`;
        const crossed = todayStrInTz(tz, new Date(e.clock_out)) !== dayStr;
        return `${from}–${formatTime(e.clock_out, tz)}${crossed ? ` ${formatDateShort(e.clock_out, tz)}` : ""}`;
      })(),
      color: color.pill,
      dot: color.dot,
      href: hrefFor(weekOf(dayStr), `entry=${e.id}`),
      // THE NAME, NOT THE NUMBER, and still a way into the job itself (jobLabel is the SSOT).
      job: e.job_id && e.job ? { href: `/jobs/${e.job_id}`, label: jobLabel(e.job) } : null,
      jobCode: e.job_code ?? null,
      source: e.source === "manual" ? "manual" : e.source === "offline" ? "offline" : null,
      lunchMin: Number(e.lunch_minutes ?? 0),
      notes: e.notes ?? null,
      family: familyById.get(String(e.id)) ?? null,
      familyConverted: (() => {
        const f = familyById.get(String(e.id));
        return f ? familyWasConverted(familyRows, f) : false;
      })(),
      controls: detail?.controls,
    };
  };

  /* ONE LIST, AND THE ANCHORED WEEK IS ALWAYS IN IT. The wide read is capped at 4000 rows, so on
     a busy org a week deep in the scroll can fall off the far end — which mattered little when a
     second list rendered it anyway, and matters now that this is the only one. Any anchored-week
     entry the wide read missed is added from the deep read. Then sorted by day and start time, so
     a day reads top to bottom in the order it was worked (the wide read comes back DESC, which is
     a cap trick, not a reading order). */
  const seenStackIds = new Set<string>();
  const stackEntries: StackEntry[] = [];
  for (const row of (stackRows ?? []) as any[]) {
    seenStackIds.add(String(row.id));
    stackEntries.push(toStackEntry(row));
  }
  for (const e of (entries ?? []) as any[]) {
    if (!seenStackIds.has(String(e.id))) stackEntries.push(toStackEntry(e));
  }
  stackEntries.sort((a, b) => (a.dayStr < b.dayStr ? -1 : a.dayStr > b.dayStr ? 1 : a.startMin - b.startMin));

  const gridLegend = [...legendNames.entries()].map(([pid, name]) => ({
    id: pid,
    name,
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
    // zero and "You Owe $0" is a lie. It refuses with the other four. It also says who is paid by
    // owner's draw (0286), so the crew/owner split can never be read from a separate query that
    // fails on its own: if this read breaks, no figure is shown at all.
    payRateMapRead(supabase),
  ]);
  const owedUnreadable = [balClosed, balOpen, balPayments, balRuns, balRates].some((r) => !!r.problem);
  /* YOU OWE COUNTS THE CREW ONLY (0286). The owner is paid by owner's draw, not wages, so he has
   * no balance here at all: the old "Your own $40,498 is a draw" line was his hours priced at his
   * own $125 rate, a figure nobody ever owed anyone. His hours stay in the week ledger below, with
   * no dollars beside them. */
  const drawIds = drawIdsFrom(balRates.rates);
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
    for (const id of drawIds) ids.delete(id); // the owner has no wages balance (0286)
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
    // wagesOnly is the same filter /payroll's board runs, so the two screens cannot disagree about
    // who is on it.
    const owing = wagesOnly(balances, drawIds).filter((b) => b.owed > 0.005);
    owedPeople = owing.length;
    owedTotal = Math.round(owing.reduce((s, b) => s + b.owed, 0) * 100) / 100;
  }

  /* ── FIX THESE: BROKEN SHIFTS ONLY ─────────────────────────────────────────────────────────
   *
   *  A broken shift is hours that are WRONG: a clock still running from a forgotten clock-out, or a
   *  0193 ghost auto-closed at zero and worth nothing. Every row names the verb that fixes it and
   *  opens that entry through the ?entry= door, which is now the Stop The Clock sheet for a
   *  running clock.
   *
   *  THE PLAN-DRIFT HALF IS GONE (2026-09-24). It compared the job calendar to where the hours
   *  landed and listed "moved", "unplanned" and "no-show" days under the broken rows. Erik asked
   *  on 09-18 "Is this box accurate in any way that can help us", and on 09-23, three minutes after
   *  fixing Brian's forgotten Herringbone shift by hand: "there's no way to fix it, I don't think
   *  this is useful". He was right both times. A calendar edited after the fact produced findings
   *  that no row could act on: the hours were already on the job they were worked on, and the only
   *  thing "wrong" was a schedule nobody needs to rewrite. So the box shows the rows that have a
   *  fix, and nothing else. */
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
         reason. */
      badge: e.auto_closed_reason
        ? // Older reasons were written with an em-dash (0193, the geofence close); the card says them plainly.
          `auto-closed: ${String(e.auto_closed_reason).replace(/_/g, " ").replace(/\s*—\s*/g, ": ")}`
        : new Date(e.clock_in).getTime() < todayStartMs
          ? `open ${openHrs} · past day`
          : `open ${openHrs}`,
      // The row names what tapping it does.
      verb: e.auto_closed_reason ? "Set The Hours" : "Stop The Clock",
      // The deep link names the ENTRY'S OWN WEEK, not the page's (same reason as the grid pills).
      href: hrefFor(weekOf(day), `entry=${e.id}`),
    };
  });
  const fixCount = brokenRows.length;

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
        "id, profile_id, clock_in, clock_out, lunch_minutes, miles, rate_override, paid_at, mileage_paid_at, job_id, job_code, status, notes, source, split_from, split_how, profiles:profile_id(full_name), job:job_id(job_number, name)",
      )
      .eq("id", entryParam)
      .maybeSingle();
    if (one) {
      if ((one as any).profile_id && (one as any).profiles) {
        (one as any).profiles = { ...(one as any).profiles, ...(payMap.get(String((one as any).profile_id)) ?? {}) };
      }
      focusEntry = one as any;
    }
  }
  // NORT'S FILL NAMES ITS JOB. time.splitEntry resolves any job the office can see, and the list
  // above is only the 50 newest: without this the sheet's second part read "That job", and a person
  // was asked to tap Split Shift without seeing whose job the hours were going to.
  let focusJobs = (jobs ?? []) as { id: string; job_number: string; name: string }[];
  if (focusEntry && splitParam === "1" && splitJobParam && !focusJobs.some((j) => j.id === splitJobParam)) {
    const { data: fj } = await supabase.from("jobs").select("id, job_number, name").eq("id", splitJobParam).maybeSingle();
    if (fj) focusJobs = [fj as { id: string; job_number: string; name: string }, ...focusJobs];
  }

  return (
    <div>
      <PageHeader title="Timecards" description={`Review your crew's hours by week.  ·  Approver: ${approver}`}>
        <div className="flex flex-wrap items-center gap-2">
          <AddEntryButton
            isStaff
            /* Opens on the viewer BY NAME. Erik read his own name twice in this picker — once as
               "Me" and once as himself — and took it for two records of one man. */
            viewerId={user?.id}
            jobCodesEnabled={orgSettings.timeclock_job_codes}
            members={members ?? []}
            jobCodes={(jobCodes ?? []) as JobCode[]}
            jobs={jobs ?? []}
            tz={tz}
          />
          <Link
            href={hrefFor(offset + 1)}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            title="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[140px] text-center text-sm font-medium text-slate-700">
            {offset === 0 ? "This week" : label}
          </span>
          <Link
            href={hrefFor(Math.max(0, offset - 1))}
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
                {/* EACH ROW IS THE WAY TO STOP THAT CLOCK (2026-09-24). Erik could see Brian's
                    clock running here and had nothing to tap. The row opens the entry through the
                    ?entry= door, which is the Stop The Clock sheet for a running clock. A clock
                    running LONG_SHIFT_HOURS or more is tinted, because it was probably forgotten. */}
                {onClock.map((c) => {
                  const inMs = c.clockIn ? Date.parse(c.clockIn) : NaN;
                  const long = Number.isFinite(inMs) && isLongOpenShift(inMs, Date.now());
                  const inDay = c.clockIn ? todayStrInTz(tz, new Date(c.clockIn)) : todayStr;
                  const since = c.clockIn
                    ? inDay === todayStr
                      ? formatTime(c.clockIn, tz)
                      : `${new Date(c.clockIn).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${formatTime(c.clockIn, tz)}`
                    : null;
                  const body = (
                    <>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" aria-hidden />
                      {/* "since" gets its own line: it is the fact that shows a forgotten clock, and
                          sharing one truncated line with the name, the job and the verb cut it off
                          at 375px. */}
                      <span className="flex min-w-0 flex-1 flex-col py-1">
                        <span className="truncate">
                          <span className="font-medium text-slate-900">{c.name}</span>
                          {c.jobLabel && <span className="text-slate-500"> · {c.jobLabel}</span>}
                        </span>
                        {since && <span className={`truncate text-sm ${long ? "text-amber-800" : "text-slate-500"}`}>since {since}</span>}
                      </span>
                    </>
                  );
                  return (
                    <li key={c.id}>
                      {c.entryId ? (
                        <Link
                          href={hrefFor(weekOf(inDay), `entry=${c.entryId}`)}
                          scroll={false}
                          className={`-mx-2 flex min-h-[44px] items-center gap-2.5 rounded-lg px-2 text-base active:bg-slate-100 ${
                            long ? "bg-amber-50 text-amber-900" : ""
                          }`}
                        >
                          {body}
                          <span className={`flex shrink-0 items-center gap-0.5 text-sm font-medium ${long ? "text-amber-800" : "text-slate-600"}`}>
                            Stop The Clock
                            <ChevronRight className="h-4 w-4" aria-hidden />
                          </span>
                        </Link>
                      ) : (
                        <div className="flex min-h-[44px] items-center gap-2.5 text-base">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── THE LEDGER, ONCE ──────────────────────────────────────────────────────────────────
          The week as pills in their time allotment on a desktop, as a list of shifts on a phone,
          and under it — until now — the SAME shifts again, one Card per person. Erik: "it looks
          like duplicates … lets try and mold as much together as possible."

          They are one list now, stacked either way you need to read it: By Day to answer "what
          happened Tuesday", By Person to answer "what do I owe Brian for this week". Same rows,
          same arithmetic, same tap into the editor. The toggle regroups INSIDE each week and
          never changes the span, so a header's number always belongs to the rows beneath it. */}
      <div className="mb-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="min-w-0 text-sm font-semibold text-slate-900">
            Hours Worked
            <span className="ml-2 text-xs font-normal text-slate-500">tap any shift to fix it</span>
          </span>
          <SegmentedControl
            activeId={grouping}
            items={[
              { id: "day", label: "By Day", href: `/timecards?week=${offset}` },
              { id: "person", label: "By Person", href: `/timecards?week=${offset}&group=person` },
            ]}
          />
        </div>
        {/* The color key belongs to the grouping that needs decoding. By Person writes each
            person's name across the top of their own shifts, so it needs no legend. */}
        {grouping === "day" && gridLegend.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {gridLegend.map((p) => (
              <span key={p.id} className="flex items-center gap-1 text-xs text-slate-600">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.dot}`} aria-hidden /> {p.name}
              </span>
            ))}
          </div>
        )}
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
          group={grouping}
          baselineById={baselineById}
        />
      </div>

      {/* A grid pill tap lands here: mount THAT entry's editor already open.
          Keyed by id so tapping a different pill remounts fresh state. */}
      {focusEntry && (
        <OpenEntryEditor
          key={focusEntry.id}
          entry={focusEntry}
          jobCodes={(jobCodes ?? []) as JobCode[]}
          jobs={focusJobs}
          members={members ?? []}
          jobCodesEnabled={orgSettings.timeclock_job_codes}
          tz={tz}
          neighbors={neighborsOf([...weekRows.filter((r) => r.id !== focusEntry.id), focusEntry], String(focusEntry.id))}
          rebuiltFromOldSplit={rebuiltOf([...weekRows.filter((r) => r.id !== focusEntry.id), focusEntry], String(focusEntry.id))}
          workDayEnd={workWin.end}
          /* Nort's fill (time.splitEntry): the sheet opens with its cut in it; a person taps Split Shift. */
          initialSplit={splitParam === "1" ? { at: splitAtParam ?? null, jobId: splitJobParam ?? null, code: splitCodeParam ?? null } : null}
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
              {/* "The crew": the owner is paid by owner's draw and is never on this figure (0286). */}
              <span className="block text-base font-semibold text-slate-900">The crew is paid up</span>
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

      {/* ── FIX THESE: the broken shifts, each with the verb that fixes it (see brokenRows). ── */}
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
                      <span className="flex shrink-0 items-center gap-0.5 text-sm font-medium text-amber-800">
                        {r.verb}
                        <ChevronRight className="h-4 w-4 text-amber-700" aria-hidden />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
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

      {/* THE DAILY REPORTS CARD IS GONE FROM HERE — it lives on My Day now (cn-v958).
          A crew lead's debrief says what got done and WHAT MATERIALS ARE NEEDED TOMORROW, and
          tomorrow is a My Day question, not a payroll-review one. It was the single biggest
          block competing for room with the money Erik opens this page for ("way too much in my
          face i dont even know what it all is"). The whole card moved intact — the person, the
          reviewed badge, did-today, materials-tomorrow, the GPS day story and Mark Reviewed —
          and the bell/push deep link moved with it, so a daily_report notification still lands
          on the page that holds the report. */}

      {/* THE THREE STAT TILES AND THE PER-PERSON CARDS ARE GONE (Erik: "way too much in my face i
          dont even know what it all is and it looks like duplicates").

          The tiles predate the week stack — "Crew hours" and "People with entries" came with the
          original page in June, "Business miles" with cn-v138 — and the stack took over what two
          of them said without anyone retiring them:

            · "Crew hours" restated the week total the stack header prints two inches above it,
              and DISAGREED with it whenever somebody was on the clock. The stack header is now
              the one week number.
            · "People with entries" was the length of the list immediately below it.
            · "Business miles" survives per person, in the stack's By Person grouping, on the
              person header where a mileage settlement is actually read. Miles stay DATA — no
              app-computed dollars, here or there: mileage pay is a human-typed settlement on
              /payroll, never rate × miles.

          The per-person Cards that used to render here went the same way, and for the harder
          reason: they were not a summary of the stack, they were a SECOND RENDERING of its
          shifts, which is the duplicate Erik was actually looking at. Everything they carried —
          the initials header, the week hours, the mileage split, and per shift the times, the job
          link, the code badge, manual/offline, lunch, the hours, duplicate, pencil and the notes —
          now rides on the stack's one row, under [By Day | By Person] above.
          The EmptyState that stood in for them went too: the stack says "No hours this week" in
          each week it owns, so there is exactly one of those on screen instead of two.

          Also long gone, and staying gone (Erik 7/15, analytics territory): "Hours by job code",
          "Hours this pay period", "Accumulated hours · all time". */}
    </div>
  );
}
