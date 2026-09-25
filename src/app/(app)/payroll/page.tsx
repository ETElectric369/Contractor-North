import { attachRates, payRateMapRead } from "@/lib/profile-columns";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { getOrgSettings } from "@/lib/org-settings";
import { payPeriodBounds, payPeriodForOffset, tzDayStartUtc, todayStrInTz } from "@/lib/tz";
import { hoursBetween } from "@/lib/utils";
import {
  aggregatePayrollEntries,
  balanceForPerson,
  drawIdsFrom,
  payRateForEntry,
  toPayPaymentRow,
  wagesOnly,
  type PayPaymentRow,
  type PersonBalance,
} from "@/lib/payroll-math";
import { PayrollView } from "./payroll-view";

export const dynamic = "force-dynamic";

/** HOW FAR BACK THE BALANCE READS — and why it is not a pay period.
 *
 *  THE BIGGEST READ CHANGE ON THIS PAGE. Until today every query here was windowed to ONE pay
 *  period, so a period Erik never got around to three cycles back was invisible unless he paged
 *  backwards to it one offset at a time. That is precisely why he could not see what he owed:
 *  "i need an easy way to be able to see how much i owe each employee". A balance is not a week,
 *  so the reads below are not windowed to one.
 *
 *  18 months is a BOUND, not a rule — it stops one query growing forever while covering far more
 *  than a year of neglected periods (Brian's oldest unpaid hours are ~2 months old). The frozen
 *  payroll_runs snapshots that make up the locked half of `earned` are NOT windowed at all, so
 *  only never-locked hours older than this could fall out of view. */
const BALANCE_MONTHS = 18;

/** Every column the balance math and the mileage block read off a time entry. One list, used by
 *  both entry queries, so a field can never go missing from one of them (THE PROJECTION LAW: the
 *  failure is always a select list). */
// split_from: a split shift's miles count on the day the shift began (summarizeMileage, audit v994 SW5).
const ENTRY_COLS =
  "id, profile_id, clock_in, clock_out, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override, split_from, profiles(full_name)";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** THE MONEY READS COME BACK WHOLE, OR THIS PAGE SHOWS NO AMOUNTS AT ALL.
 *
 *  Every figure here is subtraction — owed = earned − paid — so a list that came back short or
 *  broken does not read as an error, it reads as a confident wrong number. Two ways that used to
 *  be possible, both closed here.
 *
 *  THE ERROR DROPPED. Destructuring `{ data }` and throwing `error` away meant a failed
 *  pay_payments read was an empty payments list: `paid` 0, and the board announcing "You Owe
 *  $5,857" for money Erik had already handed Brian — the exact complaint this page was rebuilt to
 *  answer. A failed time_entries read tells the same lie the other way and he underpays.
 *
 *  THE SILENT TRUNCATION. PostgREST stops at its db-max-rows cap with status 200 and no error
 *  (storage-sweep.ts, audit v921: it is how still-referenced plan PDFs got classified as orphans
 *  and deleted). The OLD page was windowed to one pay period — ~50 rows, never near the cap.
 *  Reading 18 months is a new exposure: a three-man crew at five shifts a week is ~1,200 rows and
 *  climbing. A bare .limit() alone would not catch it, because if the server's cap sits BELOW the
 *  limit we ask for, the returned count never reaches our number and the cut stays invisible. So
 *  page it and advance by the rows ACTUALLY returned, stopping only on an EMPTY page — the same
 *  contract storage-sweep uses for the same reason. MAX_PAGES is the stated ceiling, and hitting
 *  it refuses OUT LOUD rather than paying a man off a truncated list.
 *
 *  Every read below is ordered by a primary key so the pages tile exactly, with no row read twice
 *  or skipped between them. */
const PAGE_ROWS = 1000;
/** 12,000 rows per read — a bound, not a target (18 months of a three-man crew is ~1,200). */
const MAX_PAGES = 12;

type WholeRead<T> = { rows: T[]; problem: string | null };

async function readAll<T>(
  /** A bare plural noun in Erik's words ("payments", "hours") — it lands in a sentence he reads. */
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<WholeRead<T>> {
  const out: T[] = [];
  for (let i = 0, from = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error || !data) return { rows: [], problem: `the ${what} could not be read` };
    if (!data.length) return { rows: out, problem: null };
    out.push(...data);
    from += data.length;
  }
  return { rows: [], problem: `there are too many ${what} for this page to read at once` };
}

function pushInto<T>(m: Map<string, T[]>, key: string, value: T) {
  const a = m.get(key);
  if (a) a.push(value);
  else m.set(key, [value]);
}

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: pRaw } = await searchParams;
  const offset = Math.max(0, parseInt(pRaw ?? "0", 10) || 0);
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  // A tech must never see another person's pay. This redirect is the boundary for the WHOLE
  // page — nothing below it serializes one man's figures into another man's props.
  if (!me || !isStaffRole(me.role)) redirect("/timeclock");

  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const settings = getOrgSettings((org as any)?.settings);
  const tz = settings.timezone;
  const today = todayStrInTz(tz);

  // The pay period still exists — it is the ACCOUNTANT's unit, and it lives collapsed at the
  // bottom of the page with the pager and the CSV. It is no longer the lens the page reads through.
  const period = payPeriodForOffset(settings.pay_schedule, settings.pay_anchor, today, offset);
  const startMs = tzDayStartUtc(period.start, tz).getTime();
  const endMs = tzDayStartUtc(period.end, tz).getTime();

  // Days are ORG-local (lib/tz), so the window's first instant is the org's midnight, not the
  // server's — the same rule every other date on this page obeys.
  const windowStartYmd = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - BALANCE_MONTHS);
    return d.toISOString().slice(0, 10);
  })();
  const windowIso = tzDayStartUtc(windowStartYmd, tz).toISOString();

  // THE SIX READS EVERY FIGURE ON THIS PAGE IS MADE OF. Each is paged to the end and each reports
  // its own failure (see readAll above); nothing below does arithmetic until they are all whole.
  const [closedRead, openRead, autoClosedRead, paymentsRead, baseRunsRead, mileageRead, { data: people }, ratesRead] =
    await Promise.all([
      readAll<any>("hours", (from, to) =>
        supabase
          .from("time_entries")
          .select(ENTRY_COLS)
          .eq("status", "closed")
          .not("clock_out", "is", null)
          .gte("clock_in", windowIso)
          .order("id")
          .range(from, to),
      ),
      // Open shifts come back too: their hours are worth ZERO (hoursBetween with no clock_out
      // returns 0), so they cannot inflate a balance, but the page has to be able to SAY a shift
      // is running rather than quietly showing a number that is short a day's work.
      readAll<any>("hours", (from, to) =>
        supabase.from("time_entries").select(ENTRY_COLS).is("clock_out", null).gte("clock_in", windowIso).order("id").range(from, to),
      ),
      readAll<any>("auto-closed entries", (from, to) =>
        supabase
          .from("time_entries")
          .select("id, profile_id, profiles(full_name)")
          .not("auto_closed_reason", "is", null)
          .is("paid_at", null)
          .gte("clock_in", windowIso)
          .order("id")
          .range(from, to),
      ),
      // EVERY payment, all time, never windowed: `paid` is an all-time sum by contract, and a
      // payment dropped by a date filter reappears on screen as money Erik still owes. Newest
      // first for the Paid Recently list, with id as the tie-break so the paging is total.
      readAll<any>("payments", (from, to) =>
        supabase
          .from("pay_payments")
          .select("id, profile_id, amount, paid_on, method, reference, note, needs_check, voided_at, created_at")
          .order("paid_on", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      ),
      // The FROZEN half of `earned`: what each locked period came to at the moment it locked.
      // kind='base' ONLY — mileage dollars must never reach a wages balance (0095's two-lock rule).
      readAll<any>("locked pay periods", (from, to) =>
        supabase.from("payroll_runs").select("profile_id, period_start, period_end, gross, hours, rate").eq("kind", "base").order("id").range(from, to),
      ),
      // Settled mileage $ for the VIEWED period only — the mileage block below is period-scoped and
      // stays that way (settleMileage takes a period). SUM per person: a late entry settled later is
      // a second run row for the same period. (Org scoping is RLS.)
      readAll<any>("mileage settlements", (from, to) =>
        supabase
          .from("payroll_runs")
          .select("profile_id, mileage_amount")
          .eq("kind", "mileage")
          .eq("period_start", period.start)
          .eq("period_end", period.end)
          .order("id")
          .range(from, to),
      ),
      supabase.from("profile_pay").select("id, full_name"),
      // THE SEVENTH MONEY READ. The rate multiplies every live dollar on this board, so a dropped
      // read prices every unlocked hour at zero and a man owed thousands reads "Paid Up" — the exact
      // confident wrong number the rule below exists to prevent. It refuses with the other six.
      //
      // WHO IS THE CREW AND WHO IS THE OWNER rides this same read now (0286: paid_by_draw sits
      // beside the rates). It used to be a separate `profiles` roles read with a soft fallback that
      // counted everyone when it broke. That fallback is gone on purpose: this read already refuses
      // the whole page when it fails, so there is no state left in which the owner could be mistaken
      // for crew and the board still show a figure.
      payRateMapRead(supabase),
    ]);

  // NOTHING SILENT. One rule, because a simple rule is the only kind that holds: if ANY of those
  // six came back broken or short, this page shows no amount at all and says which one. A balance
  // is what a payment gets measured against, so half a list here is how a man gets paid twice or
  // not at all — and money is the one place where saying nothing is worse than showing nothing.
  const problems = [closedRead, openRead, autoClosedRead, paymentsRead, baseRunsRead, mileageRead, ratesRead]
    .map((r) => r.problem)
    .filter((p): p is string => !!p);
  const uniqueProblems = [...new Set(problems)];

  // THE REFUSAL. Plain words, and two ways out — a wrong number he acts on is the one failure this
  // page cannot recover from, and a blank screen with no explanation is the other (NO DEAD ENDS).
  if (uniqueProblems.length > 0) {
    const said = uniqueProblems.join(" and ");
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="Pay" description="What you owe each person, and what you have paid them." />
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50">
          <div className="px-4 py-3 text-sm text-red-800">
            <div className="font-semibold text-red-900">No amounts are shown right now.</div>
            <p className="mt-1">
              {said.charAt(0).toUpperCase() + said.slice(1)}. Every amount on this page is built from that, so none is
              shown rather than one you cannot trust. Nothing changed and nobody was paid.
            </p>
          </div>
          <a
            href="/payroll"
            className="flex min-h-[44px] items-center border-t border-red-200 px-4 text-sm font-medium text-red-900 active:bg-red-100"
          >
            Reload
          </a>
          <Link
            href="/timecards"
            className="flex min-h-[44px] items-center border-t border-red-200 px-4 text-sm font-medium text-red-900 active:bg-red-100"
          >
            Open Timecards
          </Link>
        </div>
      </div>
    );
  }

  const closed = closedRead.rows;
  const open = [...openRead.rows].sort((a, b) => String(a.clock_in).localeCompare(String(b.clock_in)));

  // Rates come from the staff-scoped view, not the embed (0215/0216): those columns are revoked
  // from the authenticated role, so `profiles(hourly_rate)` would break for staff too.
  attachRates(closed, ratesRead.rates, (e: any) => ({ id: e.profile_id, holder: e }));
  attachRates(open, ratesRead.rates, (e: any) => ({ id: e.profile_id, holder: e }));
  const baseRateFor = (id: string) => Number(ratesRead.rates.get(id)?.hourly_rate ?? 0);

  // NAMES. profile_pay is the staff-scoped view (0215); a person it no longer lists still has a
  // name on their own entries, so fall back to the embed rather than filing money against "—".
  const nameById: Record<string, string> = {};
  for (const p of (people ?? []) as any[]) if (p?.id) nameById[String(p.id)] = p.full_name ?? "—";
  for (const e of [...closed, ...open]) {
    const id = e.profile_id ? String(e.profile_id) : "";
    if (id && !nameById[id] && e.profiles?.full_name) nameById[id] = e.profiles.full_name;
  }

  // OWNERS ARE NOT ON THIS BOARD (0286). An owner is paid by owner's draw, not wages: no balance
  // row, no owed periods, no CSV line. The old board listed Erik as owed $42,640 (341 h x $125),
  // money nobody ever owed anyone, and then explained it away underneath. His hours stay on
  // Timecards; recording what he takes out belongs to the accountant's books, not this page.
  const drawIds = drawIdsFrom(ratesRead.rates);
  const ownersWithHours = (list: any[]) => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const e of list) {
      const id = e.profile_id ? String(e.profile_id) : "";
      if (id && drawIds.has(id) && !seen.has(id)) seen.set(id, { id, name: nameById[id] ?? e.profiles?.full_name ?? "" });
    }
    return [...seen.values()];
  };

  // One mapper, shared with the actions (toPayPaymentRow), so a database row can never mean one
  // thing on the page and another thing in the write path.
  const payments: PayPaymentRow[] = paymentsRead.rows.map(toPayPaymentRow);

  // Group the three inputs balanceForPerson takes, then let IT do the arithmetic. The math is
  // pure and lives in one place on purpose, so this page and any future surface cannot disagree
  // about what a man is owed.
  const entriesByPerson = new Map<string, any[]>();
  for (const e of [...closed, ...open]) {
    const id = e.profile_id ? String(e.profile_id) : "";
    if (id) pushInto(entriesByPerson, id, e);
  }
  const lockedByPerson = new Map<string, { period_start: string; period_end: string; gross: number }[]>();
  for (const r of baseRunsRead.rows) {
    const id = r.profile_id ? String(r.profile_id) : "";
    if (!id) continue;
    pushInto(lockedByPerson, id, {
      period_start: String(r.period_start),
      period_end: String(r.period_end),
      gross: Number(r.gross ?? 0),
    });
  }
  const paymentsByPerson = new Map<string, PayPaymentRow[]>();
  for (const p of payments) pushInto(paymentsByPerson, p.profileId, p);

  // WHO GETS A ROW: anyone with hours, a payment, or a locked period inside the window. A person
  // with none of the three has no balance to be right or wrong about, and a row for him would be
  // the fluff Erik asked to skim.
  const personIds = new Set<string>([...entriesByPerson.keys(), ...lockedByPerson.keys(), ...paymentsByPerson.keys()]);
  for (const id of drawIds) personIds.delete(id);

  const balances: PersonBalance[] = [...personIds]
    .map((id) =>
      balanceForPerson({
        profileId: id,
        name: nameById[id] ?? "—",
        entries: entriesByPerson.get(id) ?? [],
        lockedRuns: lockedByPerson.get(id) ?? [],
        payments: paymentsByPerson.get(id) ?? [],
        tz,
        fallbackRate: baseRateFor(id),
      }),
    )
    .sort((a, b) => b.owed - a.owed || a.name.localeCompare(b.name));

  // WHAT THE OWED FIGURE IS MADE OF, period by period — the line inside the Pay modal
  // ("Aug 16-31 $520 · Sep 1-15 $892"). Only UNLOCKED hours: a locked period's gross is frozen on
  // its payroll_run and is already inside `earned`, so re-pricing it here at today's rate would be
  // the very drift the CSV bug was. Bucketed by the entry's ORG-local day, the same way the pay
  // period itself is drawn.
  const owedPeriods: Record<string, { start: string; end: string; gross: number }[]> = {};
  {
    const byPerson = new Map<string, Map<string, { start: string; end: string; gross: number }>>();
    for (const e of closed) {
      if (e.paid_at) continue;
      const id = e.profile_id ? String(e.profile_id) : "";
      if (!id || drawIds.has(id)) continue;
      const day = todayStrInTz(tz, new Date(e.clock_in));
      const p = payPeriodBounds(settings.pay_schedule, settings.pay_anchor, day);
      const key = `${p.start}|${p.end}`;
      const per = byPerson.get(id) ?? new Map<string, { start: string; end: string; gross: number }>();
      const cur = per.get(key) ?? { start: p.start, end: p.end, gross: 0 };
      cur.gross += hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) * payRateForEntry(e, baseRateFor(id));
      per.set(key, cur);
      byPerson.set(id, per);
    }
    for (const [id, per] of byPerson) {
      owedPeriods[id] = [...per.values()]
        .map((x) => ({ start: x.start, end: x.end, gross: r2(x.gross) }))
        .filter((x) => x.gross > 0)
        .sort((a, b) => a.start.localeCompare(b.start));
    }
  }

  // THE PERIOD SLICE — feeds ONLY the mileage block and the accountant CSV, both of which are
  // period-shaped by nature. The owed board above never reads it.
  const inPeriod = closed.filter((e) => {
    const t = new Date(e.clock_in).getTime();
    return Number.isFinite(t) && t >= startMs && t < endMs;
  });
  // Wages people only: the mileage block and the accountant's file carry no owner row (0286). The
  // owners who did work in this period are named at the foot of the file instead.
  const rows = wagesOnly(aggregatePayrollEntries(inPeriod, tz), drawIds);
  const ownersOnFile = ownersWithHours(inPeriod);
  const ownersOnBoard = ownersWithHours([...closed, ...open]);

  const settledMileage: Record<string, number> = {};
  for (const run of mileageRead.rows) {
    const amt = Number(run.mileage_amount ?? 0);
    if (!run.profile_id || !Number.isFinite(amt)) continue;
    settledMileage[run.profile_id] = r2((settledMileage[run.profile_id] ?? 0) + amt);
  }

  // THE FROZEN FIGURES FOR THE VIEWED PERIOD — the CSV fix. Re-exporting an old period used to
  // re-price its locked hours at TODAY's rate, so the file the accountant already had stopped
  // matching the one Erik sent after a raise. The lock froze a gross; the export reads that.
  const frozenBase: Record<string, { hours: number; gross: number; rates: number[] }> = {};
  for (const r of baseRunsRead.rows) {
    if (r.period_start !== period.start || r.period_end !== period.end) continue;
    const id = r.profile_id ? String(r.profile_id) : "";
    if (!id) continue;
    const cur = frozenBase[id] ?? { hours: 0, gross: 0, rates: [] as number[] };
    cur.hours = r2(cur.hours + Number(r.hours ?? 0));
    cur.gross = r2(cur.gross + Number(r.gross ?? 0));
    const rate = Number(r.rate ?? 0);
    if (rate > 0 && !cur.rates.includes(rate)) cur.rates.push(rate);
    frozenBase[id] = cur;
  }

  // THE OPEN-SHIFT GUARD, with somewhere to go. The old banner named the problem and left him to
  // find the entry himself; this carries the entry id so the row on screen is one tap from the fix.
  // One row per person (earliest open shift wins) — the same guard, not a second one.
  const openShifts: { profileId: string; name: string; entryId: string }[] = [];
  for (const e of open) {
    const id = e.profile_id ? String(e.profile_id) : "";
    // The owner's running shift moves no wage, so it is no reason to hold this board's figures.
    if (!id || drawIds.has(id) || openShifts.some((o) => o.profileId === id)) continue;
    openShifts.push({ profileId: id, name: nameById[id] ?? e.profiles?.full_name ?? "Someone", entryId: String(e.id) });
  }

  // Same for an auto-closed shift: it blocks a pay period from locking, and the owner has none.
  const autoClosed = autoClosedRead.rows.filter((e: any) => !drawIds.has(String(e.profile_id ?? "")));
  const autoClosedNames = [...new Set(autoClosed.map((e: any) => e.profiles?.full_name ?? nameById[String(e.profile_id)]).filter(Boolean))];

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Pay" description="What you owe each person, and what you have paid them." />
      {/* The auto-closed guard, kept word for word (audit v921) apart from the button it used to
          name: a 0193 auto-close closes a forgotten shift at clock_out = clock_in when the next
          punch lands, so the row IS closed, passes every filter, and adds ZERO hours. The
          open-shift guard can never catch it, and the balance would read low with nothing said. */}
      {autoClosedNames.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          {autoClosed.length} auto-closed {autoClosed.length === 1 ? "entry" : "entries"} ({autoClosedNames.join(", ")}) — the app closed {autoClosed.length === 1 ? "it" : "them"} at the next punch, so {autoClosed.length === 1 ? "its hours are" : "those hours are"} probably wrong (often zero). Fix {autoClosed.length === 1 ? "it" : "them"} on the timecards page — a payment cannot lock that pay period until you do.
        </div>
      )}
      <PayrollView
        balances={balances}
        payments={payments}
        nameById={nameById}
        ownersOnBoard={ownersOnBoard}
        ownersOnFile={ownersOnFile}
        viewerId={user?.id ?? null}
        owedPeriods={owedPeriods}
        openShifts={openShifts}
        today={today}
        rows={rows}
        period={period}
        offset={offset}
        settledMileage={settledMileage}
        frozenBase={frozenBase}
        taxNumber={settings.tax_number}
      />
    </div>
  );
}
