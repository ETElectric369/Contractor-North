/** Pure math for a Fixed-Bid job's payment schedule (the "payment structure" from
 *  the deal-to-cash spine). A milestone bills a % of the contract (or a fixed $);
 *  "Request next payment" draws the next pending one. Extracted from the server
 *  action so the money math is unit-tested without a database. */

const fin = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number) => Math.round(n * 100) / 100;

export type Milestone = {
  id?: string;
  sort_order: number;
  label: string;
  percent?: number | null;
  amount?: number | null;
  status?: string | null;
  invoice_id?: string | null;
  /** $ frozen at draw time, so editing the quote later can't retro-change a billed
   *  milestone. Used for billed rows; pending rows still compute percent-of-contract. */
  billed_amount?: number | null;
};

/** Contract total for a job = the agreed amount. Prefer the accepted quote(s); only
 *  if none are accepted yet fall back to the sum of all quotes (so a revised quote
 *  doesn't double the contract once one is accepted). One rule, shared by the job
 *  page, billing actions, and contract generation so they never diverge. */
export function contractTotalFromQuotes(quotes: { total?: number | null; status?: string | null }[]): number {
  const all = quotes ?? [];
  const accepted = all.filter((q) => q.status === "accepted");
  const base = accepted.length ? accepted : all;
  return cents(base.reduce((s, q) => s + fin(q.total), 0));
}

/** The $ a milestone bills: percent of the contract when a percent is set, else the
 *  fixed amount. Always finite, never negative. */
export function milestoneAmount(m: Milestone, contractTotal: number): number {
  const pct = fin(m.percent);
  const dollars = pct > 0 ? (fin(contractTotal) * pct) / 100 : fin(m.amount);
  return cents(Math.max(0, dollars));
}

/** Which draw kind a milestone maps to by position: the first is a deposit, the last
 *  is the final, everything between is a progress draw. */
export function milestoneKind(index: number, count: number): "deposit" | "progress" | "final" {
  if (count <= 1) return "final";
  if (index <= 0) return "deposit";
  if (index >= count - 1) return "final";
  return "progress";
}

export type ScheduleStatus = {
  rows: Array<Milestone & { dollars: number; billed: boolean; index: number; kind: "deposit" | "progress" | "final" }>;
  scheduledPct: number;
  scheduledTotal: number;
  billedTotal: number;
  remaining: number;
  /** The next unbilled milestone, or null when the schedule is fully billed. */
  next: (Milestone & { dollars: number; index: number; kind: "deposit" | "progress" | "final" }) | null;
  /** True when percents are set and don't add to ~100 — surface a gentle warning. */
  percentOff: boolean;
  /** Percents are set and sum to UNDER 100% — a silent underbill (the contract is never
   *  fully drawn). Distinct from percentOff (any deviation) so the UI can flag underbill
   *  specifically rather than only ever warning about overage. */
  percentUnder: boolean;
  /** Total scheduled $ (percent + fixed-amount milestones combined) exceeds the contract
   *  total — a MIXED schedule that would over-bill. Only meaningful when there's a
   *  contract to compare against (contractTotal > 0). */
  overContract: boolean;
};

/** Decorate a schedule with computed $ + flags and surface the next pending milestone. */
export function scheduleStatus(milestones: Milestone[], contractTotal: number): ScheduleStatus {
  const sorted = [...(milestones ?? [])].sort((a, b) => fin(a.sort_order) - fin(b.sort_order));
  const count = sorted.length;
  // "Billed" keys off the linked invoice, not a flag: deleting a mistaken draft draw
  // nulls the FK (on delete set null) and cleanly re-offers that milestone. A billed
  // milestone shows its frozen snapshot ($ at draw time); pending ones compute live.
  const rows = sorted.map((m, index) => {
    const billed = !!m.invoice_id;
    const dollars =
      billed && m.billed_amount != null
        ? Math.max(0, fin(m.billed_amount))
        : milestoneAmount(m, contractTotal);
    return { ...m, index, kind: milestoneKind(index, count), dollars, billed };
  });
  const scheduledPct = cents(rows.reduce((s, r) => s + fin(r.percent), 0));
  const scheduledTotal = cents(rows.reduce((s, r) => s + r.dollars, 0));
  const billedTotal = cents(rows.filter((r) => r.billed).reduce((s, r) => s + r.dollars, 0));
  const next = rows.find((r) => !r.billed) ?? null;
  const usesPercent = rows.some((r) => fin(r.percent) > 0);
  const contract = fin(contractTotal);
  return {
    rows,
    scheduledPct,
    scheduledTotal,
    billedTotal,
    remaining: cents(scheduledTotal - billedTotal),
    next: next ? { ...next } : null,
    percentOff: usesPercent && Math.abs(scheduledPct - 100) > 0.5,
    // Silent underbill: percents are set but leave part of the contract un-drawn.
    percentUnder: usesPercent && scheduledPct < 100 - 0.5,
    // Mixed-schedule over-bill: the dollars (percent + fixed combined) exceed the contract.
    // Guard on contract > 0 so a job without a quote yet doesn't false-positive.
    overContract: contract > 0.005 && scheduledTotal > contract + 0.01,
  };
}

/** A sensible default schedule from the org's deposit %: deposit + progress + final
 *  that always sums to exactly 100. */
export function defaultSchedule(depositPercent: number): Milestone[] {
  const dep = Math.min(Math.max(Math.round(fin(depositPercent)), 0), 90);
  const deposit = dep > 0 ? dep : 30;
  const rest = 100 - deposit;
  const progress = Math.round(rest / 2);
  const final = rest - progress; // absorbs the rounding so the three always total 100
  return [
    { sort_order: 0, label: "Deposit", percent: deposit },
    { sort_order: 1, label: "Progress payment", percent: progress },
    { sort_order: 2, label: "Final payment", percent: final },
  ];
}
