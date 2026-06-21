/** Pure job progress-billing math, extracted from job-financials.ts so the
 *  estimate / invoiced / collected / work-to-date computation is unit-testable
 *  without a DB. The server fn does the fetching, then calls this. */

export type JobProgressFinancials = {
  /** Sum of the job's quotes — the agreed estimate (a cap on fixed-price, a
   *  reference on Time & Material). */
  estimate: number;
  /** Billable work to date: labor at charge rate + materials with markup. Computed
   *  the SAME way importLabor/importCosts bill, so it reconciles to the penny. */
  workToDate: number;
  /** Invoices actually sent to the customer (non-void, non-draft). */
  invoiced: number;
  /** Cash collected on the job (amount_paid on non-void invoices). */
  collected: number;
  /** "fixed" (estimate is a contract cap) or "tm" (estimate is a reference). */
  billingType: "fixed" | "tm";
};

const num = (x: unknown): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const cents = (n: number) => Math.round(n * 100) / 100;

/** Roll the fetched rows + already-computed billable labor into the progress
 *  financials. Materials are marked up PER ROW (cost > 0 only) exactly like
 *  importCostsIntoInvoice; invoiced excludes void/draft; collected excludes void. */
export function computeJobProgress(input: {
  billingTypeRaw: string | null | undefined;
  quotes: { total: number | null }[];
  invoices: { total: number | null; status: string; amount_paid: number | null }[];
  billableLabor: number;
  pos: { total: number | null }[];
  bills: { amount: number | null }[];
  markupPercent: number;
}): JobProgressFinancials {
  const billingType: "fixed" | "tm" = input.billingTypeRaw === "tm" ? "tm" : "fixed";

  const estimate = cents((input.quotes ?? []).reduce((s, q) => s + num(q.total), 0));
  const invoiced = cents(
    (input.invoices ?? []).reduce(
      (s, i) => (i.status !== "void" && i.status !== "draft" ? s + num(i.total) : s),
      0,
    ),
  );
  const collected = cents(
    (input.invoices ?? []).reduce((s, i) => (i.status !== "void" ? s + num(i.amount_paid) : s), 0),
  );

  const markup = num(input.markupPercent);
  const mk = (cost: number) => cents(cost * (1 + markup / 100));
  const billableMaterials =
    (input.pos ?? []).reduce((s, p) => (num(p.total) > 0 ? s + mk(num(p.total)) : s), 0) +
    (input.bills ?? []).reduce((s, b) => (num(b.amount) > 0 ? s + mk(num(b.amount)) : s), 0);

  const workToDate = cents(num(input.billableLabor) + billableMaterials);
  return { estimate, workToDate, invoiced, collected, billingType };
}
