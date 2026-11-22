/** Pure math for a Fixed-Bid job's payment schedule (the "payment structure" from
 *  the deal-to-cash spine). A milestone bills a % of the contract (or a fixed $);
 *  "Request next payment" draws the next pending one. Extracted from the server
 *  action so the money math is unit-tested without a database. */

import { depositFor, type DepositRule } from "./deposit-rule";

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
export function contractTotalFromQuotes(
  quotes: { total?: number | null; status?: string | null; created_at?: string | null }[],
): number {
  const all = quotes ?? [];
  const accepted = all.filter((q) => q.status === "accepted");
  // ACCEPTED quotes sum — a job legitimately wins phase 1 and phase 2, and both are the deal.
  if (accepted.length) return cents(accepted.reduce((s, q) => s + fin(q.total), 0));
  /**
   * NOTHING ACCEPTED YET: the newest proposal stands ALONE (audit 8).
   *
   * Summing them all made a revision ADD to the estimate it replaced — write $10k, revise to
   * $12k, and the generated contract said "Contract price: $22,000" with a deposit computed on
   * it. The customer signs a number that was never quoted, and the draws bill against the same
   * inflated base (jobContractTotal shares this rule, which is why it lives here and not in
   * either caller). A revision supersedes; it never accumulates.
   */
  // A CALLER THAT OMITS created_at MUST NOT DEGRADE SILENTLY (audit v800). Four projections
  // shipped without it; every comparison then returned 0, the stable sort preserved PostgREST's
  // arbitrary row order, and "newest wins" quietly became "whichever row came back first" — in
  // practice the OLDEST. When more than one candidate is in play and the timestamps are missing,
  // that is a bug in the caller's select list, not a tie to resolve.
  if (all.length > 1 && all.some((q) => !q.created_at)) {
    throw new Error(
      "contractTotalFromQuotes: quotes are missing created_at — add it to the select list, or the newest-revision rule cannot be applied.",
    );
  }
  const newest = [...all].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  return cents(fin(newest?.total));
}

/** ACCEPTED quotes only — the legal-figure rule (audit 8). A preliminary notice's "estimated
 *  total" and the lien editor's prefill must agree, and neither may include a proposal the
 *  customer never accepted; contractTotalFromQuotes' newest-quote fallback is right for a
 *  CONTRACT (a price you are about to offer) and wrong for a figure served under oath. */
export function acceptedQuoteTotal(quotes: { total?: number | null; status?: string | null }[]): number {
  return cents((quotes ?? []).filter((q) => q.status === "accepted").reduce((s, q) => s + fin(q.total), 0));
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
  const contract = fin(contractTotal);
  /**
   * THE LAST PENDING MILESTONE ABSORBS THE ROUNDING (audit v921).
   *
   * Each percent milestone rounded to cents on its own, so 30/35/35 of a $100.01 contract
   * scheduled $30.00 + $35.00 + $35.00 = $100.00 — a cent of the accepted quote that no draw
   * ever bills. Nothing surfaced it either: `remaining` measures against the SCHEDULE, not the
   * contract, and the percents do sum to 100 so percentUnder stays false. defaultSchedule
   * already makes its final percent absorb the rounding; the dollars must do the same.
   *
   * Bounded to rounding scale (a cent per row) on purpose: a schedule that genuinely underbills
   * the contract must still read as percentUnder/percentOff, not be silently topped up here.
   */
  const lastRow = rows[rows.length - 1];
  if (contract > 0.005 && lastRow && !lastRow.billed && fin(lastRow.percent) > 0 && Math.abs(scheduledPct - 100) <= 0.5) {
    const drift = cents(contract - cents(rows.reduce((s, r) => s + r.dollars, 0)));
    if (drift !== 0 && Math.abs(drift) <= 0.01 * rows.length) {
      lastRow.dollars = cents(Math.max(0, lastRow.dollars + drift));
    }
  }
  const scheduledTotal = cents(rows.reduce((s, r) => s + r.dollars, 0));
  const billedTotal = cents(rows.filter((r) => r.billed).reduce((s, r) => s + r.dollars, 0));
  const next = rows.find((r) => !r.billed) ?? null;
  const usesPercent = rows.some((r) => fin(r.percent) > 0);
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

/**
 * LEFT TO BILL (W1-19): the one figure the Overview leads with on a job billed by its CONTRACT, the
 * twin of the Unbilled card's "Open" on a job billed by its work. Pure, so the card and its tests
 * read the same arithmetic the pages already hold (never a figure worked out a second way):
 *
 *   contract   a fixed-price job with a live estimate and no schedule: the contract
 *              (contractTotalFromQuotes, the page's progress.estimate) less what went out on sent,
 *              non-void bills (progress.invoiced; a draft is not a bill). The job's New Invoice bills
 *              from it (Part of the Estimate takes a part of exactly this figure).
 *   schedule   a job on a payment schedule, any billing type: scheduleStatus' own remaining (the
 *              scheduled dollars not drawn yet), and the next payment Request Next Payment draws.
 *
 * `left` is never below zero; `over` says how far a contract's bills went past it (a change order
 * billed on top, say), and a schedule that draws less or more than the contract says by how much.
 */
export type LeftToBill = {
  kind: "contract" | "schedule";
  /** The contract the figure is measured against. */
  contract: number;
  /** Billed toward it: sent non-void bills (contract), or the payments drawn (schedule). */
  billed: number;
  /** Left to bill, never below zero. */
  left: number;
  /** Nothing is left: the contract, or every scheduled payment, is billed. */
  billedInFull: boolean;
  /** contract: how far the sent bills went past the contract (0 when they didn't). */
  over: number;
  /** schedule: every payment the schedule holds, in dollars. */
  scheduled: number;
  /** schedule: the next payment Request Next Payment draws; null when all are drawn. */
  next: { label: string; dollars: number } | null;
  /** schedule: the schedule draws this much LESS than the contract (0 when it doesn't). */
  scheduleShort: number;
  /** schedule: the schedule draws this much MORE than the contract (0 when it doesn't). */
  scheduleOver: number;
};

export function leftToBill(
  progress: { estimate: number; invoiced: number },
  schedule: ScheduleStatus | null | undefined,
): LeftToBill {
  const contract = cents(Math.max(0, fin(progress.estimate)));
  if (schedule && schedule.rows.length > 0) {
    const scheduled = cents(Math.max(0, fin(schedule.scheduledTotal)));
    const billed = cents(Math.max(0, fin(schedule.billedTotal)));
    const left = cents(Math.max(0, fin(schedule.remaining)));
    const next = schedule.next ? { label: schedule.next.label, dollars: cents(Math.max(0, fin(schedule.next.dollars))) } : null;
    // Only against a real contract: a schedule on a job with no estimate yet has nothing to be short of.
    const gap = contract > 0.005 ? cents(contract - scheduled) : 0;
    return {
      kind: "schedule",
      contract,
      billed,
      left,
      billedInFull: !next && left <= 0.005,
      over: 0,
      scheduled,
      next,
      scheduleShort: gap > 0.01 ? gap : 0,
      scheduleOver: gap < -0.01 ? -gap : 0,
    };
  }
  const billed = cents(Math.max(0, fin(progress.invoiced)));
  const rest = cents(contract - billed);
  return {
    kind: "contract",
    contract,
    billed,
    left: rest > 0 ? rest : 0,
    billedInFull: contract > 0.005 && rest <= 0.005,
    over: rest < -0.005 ? -rest : 0,
    scheduled: 0,
    next: null,
    scheduleShort: 0,
    scheduleOver: 0,
  };
}

/**
 * A sensible default schedule from the company's DEPOSIT RULE (cn-v1177): the deposit is what
 * lib/deposit-rule depositFor makes of the contract (a percent held under a dollar cap), written as the
 * percent of the contract it comes to, then progress and final split the rest. Always sums to exactly
 * 100 (in millionths of a percent, so a capped deposit's odd percent never leaves a remainder).
 *
 * Before cn-v1177 this took a bare percent and read 0 as "unset", answering 30. A stored 0 is now a
 * company's choice of no deposit (lib/org-settings), so it answers no deposit row: progress and final.
 * With no contract to take a capped figure of, the rule's own percent stands.
 */
export function defaultSchedule(
  contractTotal: number,
  rule: DepositRule,
  /** cn-v1178 (audit D6): the job already has a live deposit request (paid or not). Its deposit was
   *  asked for by that request, which comes off the job's next bill; a Deposit row here would ask for it
   *  again as a draw the request then nets to $0.00. So no Deposit row: progress and final only. */
  opts?: { depositRequested?: boolean },
): Milestone[] {
  const total = Math.max(0, fin(contractTotal));
  const pct = Math.min(Math.max(fin(rule?.percent), 0), 100);
  const raw = opts?.depositRequested ? 0 : total > 0.005 ? (depositFor(total, rule) / total) * 100 : pct;
  // In millionths of a percent (a capped deposit's percent is rarely round: $1,000 of $30,000 is
  // 3.333333%, which bills $1,000.00 to the cent, where 3.33% would bill $999); the deposit never
  // takes more than 90 so two rows always follow it.
  const U = 1_000_000;
  const dep = Math.min(Math.max(Math.round(raw * U), 0), 90 * U);
  const rest = 100 * U - dep;
  const progress = Math.round(rest / 2);
  const final = rest - progress; // absorbs the rounding so the rows always total 100
  const rows: Omit<Milestone, "sort_order">[] = [
    ...(dep > 0 ? [{ label: "Deposit", percent: dep / U }] : []),
    { label: "Progress payment", percent: progress / U },
    { label: "Final payment", percent: final / U },
  ];
  return rows.map((r, i) => ({ sort_order: i, ...r }));
}

/**
 * DOES THE JOB HAVE A LIVE DEPOSIT REQUEST (cn-v1178, audit D6), from the job's live requests as the
 * Request a Payment seed lists them (void and draft ones are not listed): one that is an estimate's
 * deposit, or one made as a deposit (its built-in name, lib/prepayments prepaymentLabel).
 */
export function depositIsRequested(requests: readonly { quoteId?: string | null; label?: string | null; status?: string | null }[] | null | undefined): boolean {
  return (requests ?? []).some((r) => r && r.status !== "void" && r.status !== "draft" && (!!r.quoteId || (r.label ?? "").trim() === "Deposit"));
}
