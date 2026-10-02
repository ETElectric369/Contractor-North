/**
 * NEW INVOICE ON /BILLING ASKS ONE QUESTION (W1-28): "Which Job Or Customer?". The modal had an
 * estimate/blank toggle, an Estimate select, a Title, a Customer select and a Job select - five
 * decisions, two of which (which estimate, which title) the job's own door already knows. A job is
 * billed through the job's own door (createInvoiceForJob: its open draft, its estimate on a
 * fixed-price job, only the hours and bills no bill holds); a customer with no job gets a blank one.
 *
 * Pure, so the list the person sees and the door a pick runs are pinned by test, not by eye.
 */

export type PickJob = {
  id: string;
  job_number: string | null;
  name: string | null;
  customer_id: string | null;
  /** The job's customer, by name: rows read "J-011 · Thistlewood · Tess Zane". */
  customer_name?: string | null;
};
export type PickCustomer = { id: string; name: string };

export type Pick = { kind: "job" | "customer"; id: string; label: string };

export type PickRow =
  | { kind: "job"; id: string; label: string }
  | { kind: "customer"; id: string; label: string }
  /** No match: the last row makes the customer ("+ New Customer 'Tess Zane'") and picks them. */
  | { kind: "new-customer"; name: string };

/** Before anything is typed: the newest jobs that aren't cancelled (the page reads them that way). */
export const RECENT_JOBS = 8;
/** At most this many of each kind while typing: the list stays one screen on a phone. */
export const MATCHES_EACH = 12;

/** "J-011 · Thistlewood · Tess Zane": the J-number once (a name that already starts with it isn't
 *  given it twice), the job's name, its customer. */
export function jobRowLabel(j: PickJob): string {
  const num = (j.job_number ?? "").trim();
  let name = (j.name ?? "").trim();
  if (num && name.toLowerCase().startsWith(num.toLowerCase())) name = name.slice(num.length).replace(/^[\s·:—-]+/, "").trim();
  return [num, name, (j.customer_name ?? "").trim()].filter(Boolean).join(" · ") || "Untitled job";
}

/** The rows under the box, for what is typed: jobs first, then customers; nothing matches → the
 *  one row that makes the customer. */
export function pickRows(query: string, jobs: readonly PickJob[], customers: readonly PickCustomer[]): PickRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return jobs.slice(0, RECENT_JOBS).map((j) => ({ kind: "job", id: j.id, label: jobRowLabel(j) }));
  const has = (v: string | null | undefined) => (v ?? "").toLowerCase().includes(q);
  const jobRows: PickRow[] = jobs
    .filter((j) => has(j.job_number) || has(j.name) || has(j.customer_name))
    .slice(0, MATCHES_EACH)
    .map((j) => ({ kind: "job", id: j.id, label: jobRowLabel(j) }));
  const customerRows: PickRow[] = customers
    .filter((c) => has(c.name))
    .slice(0, MATCHES_EACH)
    .map((c) => ({ kind: "customer", id: c.id, label: c.name }));
  const rows = [...jobRows, ...customerRows];
  return rows.length ? rows : [{ kind: "new-customer", name: query.trim() }];
}

/** The Tax Rate % field shows for a pick of either kind while Sales Tax is on (0352's switch). */
export function showsTaxRate(pick: Pick | null, salesTax: boolean): boolean {
  return salesTax && !!pick;
}

/**
 * WHAT A PICK RUNS. A job: its own door, createInvoiceForJob(jobId, { taxRate }) - the rate is used
 * only when that door makes a NEW invoice (a blank one, or an estimate copy whose estimate has no
 * tax of its own); landing on an open draft keeps the draft's own tax, and the toast says so. A
 * customer: a blank invoice for them at the rate on the form. Sales Tax off: no rate at all, never
 * a hidden one.
 */
export type PickRoute = { action: "job"; jobId: string; taxRate?: number } | { action: "customer"; customerId: string; taxRate: number };

export function routePick(pick: Pick, o: { salesTax: boolean; taxRate: number }): PickRoute {
  const rate = o.salesTax && Number.isFinite(o.taxRate) && o.taxRate > 0 && o.taxRate < 1 ? o.taxRate : 0;
  if (pick.kind === "job") return rate > 0 ? { action: "job", jobId: pick.id, taxRate: rate } : { action: "job", jobId: pick.id };
  return { action: "customer", customerId: pick.id, taxRate: rate };
}

/** The draft kept across a reload (useDraft "invoice-new"): the pick, and nothing of the old
 *  form's shape (mode/quoteId/title) - an old draft restores to no pick at all. */
export function restoredPick(d: unknown): Pick | null {
  const p = (d as { pick?: Partial<Pick> } | null)?.pick;
  if (!p || (p.kind !== "job" && p.kind !== "customer") || typeof p.id !== "string" || !p.id) return null;
  return { kind: p.kind, id: p.id, label: typeof p.label === "string" ? p.label : "" };
}
