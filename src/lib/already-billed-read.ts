/**
 * ALREADY BILLED: THE READS (server side). The rules are lib/already-billed (pure); the write is
 * migration 0357's mark_already_billed / unmark_already_billed. Nothing here writes.
 *
 *   readHandClaimsForJob   which of a job's rows a person marked as billed, and on which line: the
 *                          Costs tab's "Billed By Hand On INV-00023 · Not Billed After All"
 *   loadAlreadyBilledSheet what the sheet offers for one cost (a receipt, an order, a take, or the
 *                          job's open hours): the eligible bills and their lines, the drafts it can't
 *                          use and why, and for hours the open shifts
 *   alreadyBilledOffer     the supplier-paper card's done-line question, "Already Billed On INV-x?",
 *                          or null when no bill on the job could have charged for the paper
 *
 * EVERY READ SAYS WHEN IT FAILED, and a database without 0357 (no hand_claims) answers "needs an
 * update", never a crash and never an empty list that reads as "nothing billed".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { billableBillCost } from "@/lib/bill-itemisation";
import { featureOn } from "@/lib/features";
import { jobBillsItsActuals } from "@/lib/invoice-import-rule";
import { fetchJobLaborRows, laborPersonKey, withoutClaimedLabor } from "@/lib/labor-billing";
import { getOrgSettings } from "@/lib/org-settings";
import { readJobStock, stockCostLabel } from "@/lib/stock-billing";
import { claimedSourcesOnJob, laborRowIds } from "@/lib/unbilled-work";
import {
  NEEDS_UPDATE,
  eligibleInvoice,
  eligibleLines,
  preselectLine,
  sortInvoicesFor,
  type AbEntry,
  type AbInvoice,
  type AbLine,
  type AlreadyBilledKind,
} from "@/lib/already-billed";

type Db = Pick<SupabaseClient, "from">;

/** The one error shape a database without 0357 gives for hand_claims. */
export function isMissingHandClaims(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return (code === "42703" || code === "PGRST204" || /does not exist|could not find/i.test(msg)) && /hand_claims/i.test(msg);
}

/** The RPC isn't there yet (0357 not applied): PostgREST's "could not find the function", or Postgres'. */
export function isMissingAlreadyBilledRpc(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "PGRST202" || code === "42883" || /could not find the function|function .*already_billed.* does not exist/i.test(msg);
}

// ── Which of a job's rows a person marked ───────────────────────────────────────────────────────

export type HandClaim = { lineId: string; invoiceId: string; invoiceNumber: string | null; status: string };
export type HandClaims = { ready: boolean; byId: Map<string, HandClaim> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job's invoices, and its customer's invoices with no job (a mark may land on one of those).
 *  The ids go into a PostgREST filter string, so anything but a uuid is refused, never spliced in. */
function jobOrCustomersJobless(jobId: string, customerId: string | null | undefined): string {
  if (!UUID_RE.test(String(jobId))) throw new Error("already-billed: a job id that is not a uuid");
  const cust = customerId && UUID_RE.test(String(customerId)) ? String(customerId) : null;
  return cust ? `job_id.eq.${jobId},and(job_id.is.null,customer_id.eq.${cust})` : `job_id.eq.${jobId}`;
}

/**
 * Every id a person marked as billed on the job's live invoices (and its customer's invoices with no
 * job), by the id: which line holds it. `ready` false = 0357 isn't on this database. A lost read
 * throws: the caller says the Billed fold couldn't tell, never that nothing was marked.
 */
export async function readHandClaimsForJob(supabase: Db, jobId: string, customerId: string | null | undefined): Promise<HandClaims> {
  const { data, error } = await supabase
    .from("invoice_items")
    .select("id, invoice_id, hand_claims, invoices!inner(invoice_number, status, job_id, customer_id)")
    .neq("hand_claims", "{}")
    .neq("invoices.status", "void")
    .or(jobOrCustomersJobless(jobId, customerId), { referencedTable: "invoices" })
    .limit(2000);
  if (error) {
    if (isMissingHandClaims(error)) return { ready: false, byId: new Map() };
    throw error;
  }
  const byId = new Map<string, HandClaim>();
  for (const r of (data ?? []) as { id: string; invoice_id: string; hand_claims?: string[] | null; invoices?: { invoice_number?: string | null; status?: string | null } | null }[]) {
    for (const id of r.hand_claims ?? []) {
      if (!byId.has(String(id)))
        byId.set(String(id), { lineId: String(r.id), invoiceId: String(r.invoice_id), invoiceNumber: r.invoices?.invoice_number ?? null, status: String(r.invoices?.status ?? "") });
    }
  }
  return { ready: true, byId };
}

// ── The sheet ────────────────────────────────────────────────────────────────────────────────────

export type AlreadyBilledTarget = { kind: AlreadyBilledKind; ids: string[] };

export type AlreadyBilledSheetData = {
  jobId: string;
  jobNumber: string;
  tz: string;
  shopStock: boolean;
  target: {
    kind: AlreadyBilledKind;
    /** The ids a mark claims (a take: every move of it). */
    ids: string[];
    /** "CED 8802-1101475", "From Stock · 12/2 NM-B, 40 ft", "PO-00012 · CED". Empty for hours. */
    words: string;
    /** What it cost, before markup: a receipt's billable cost (what the next bill would pick up). */
    cost: number | null;
    /** The cost's own date, for the order the bills are offered in. */
    date: string | null;
    /** A supplier return: it takes money off. */
    negative: boolean;
    /** A receipt with lines (the shelf can take some of it). */
    billHasLines: boolean;
    /** The receipt the shelf question is about. */
    billId: string | null;
  };
  /** Eligible bills, in the order to offer them, each with only the lines that can hold it. */
  invoices: { invoice: AbInvoice; preselect: string | null }[];
  /** Drafts on the job, said instead of offered: "INV-081 is still a draft: Add To INV-081 puts it there." */
  drafts: string[];
  /** For hours: the shifts nobody has billed (never a running one, never a non-billable code). */
  entries: AbEntry[];
};

const LINE_COLUMNS = "id, description, quantity, unit, unit_price, line_total, import_source, import_key, edited, line_kind, sort_order, hand_claims";

type Loaded = { ok: true; data: AlreadyBilledSheetData } | { ok: false; error: string; needsUpdate?: boolean };

/**
 * What the Already Billed sheet offers for one cost on one job. Staff only (the caller checks, and
 * RLS reads nothing money-shaped for a tech anyway). Only on a job that bills its actual costs.
 */
export async function loadAlreadyBilledSheet(supabase: Db, orgId: string, jobId: string, target: AlreadyBilledTarget): Promise<Loaded> {
  const kind = target?.kind;
  const ids = [...new Set((target?.ids ?? []).map((x) => String(x ?? "")).filter(Boolean))];
  if (!["bill", "po", "stock", "time"].includes(String(kind))) return { ok: false, error: "Couldn't tell what you meant to mark. Nothing was changed." };
  if (kind !== "time" && !ids.length) return { ok: false, error: "Couldn't tell what you meant to mark. Nothing was changed." };

  const [jobRead, msRead, orgRead] = await Promise.all([
    supabase.from("jobs").select("id, job_number, name, customer_id, billing_type").eq("id", jobId).eq("org_id", orgId).maybeSingle(),
    supabase.from("payment_milestones").select("id").eq("job_id", jobId).eq("org_id", orgId),
    supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
  ]);
  if (jobRead.error || msRead.error || orgRead.error) return { ok: false, error: "Couldn't read this job just now. Nothing was changed - try again in a moment." };
  const job = jobRead.data as { id: string; job_number?: string | null; name?: string | null; customer_id?: string | null; billing_type?: string | null } | null;
  if (!job) return { ok: false, error: "That job isn't here anymore. Reload the page." };
  const jobNumber = String(job.job_number ?? "").trim() || "This job";
  if (!jobBillsItsActuals(job.billing_type, (msRead.data ?? []).length))
    return { ok: false, error: `${jobNumber} is billed by its contract, not by its time and materials, so nothing on it is marked billed line by line.` };
  const settings = getOrgSettings((orgRead.data as { settings?: unknown } | null)?.settings);

  // The bills: the job's, and its customer's with no job. With hand_claims, which is how 0357 is known.
  const invRead = await supabase
    .from("invoices")
    .select(`id, invoice_number, status, invoice_kind, job_id, created_at, invoice_items(${LINE_COLUMNS})`)
    .eq("org_id", orgId)
    .neq("status", "void")
    .or(jobOrCustomersJobless(job.id, job.customer_id));
  if (invRead.error) {
    if (isMissingHandClaims(invRead.error)) return { ok: false, error: NEEDS_UPDATE, needsUpdate: true };
    return { ok: false, error: "Couldn't read this job's bills just now. Nothing was changed - try again in a moment." };
  }
  const all: AbInvoice[] = ((invRead.data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    invoice_number: r.invoice_number ?? null,
    status: String(r.status ?? ""),
    invoice_kind: r.invoice_kind ?? null,
    job_id: r.job_id ?? null,
    created_at: String(r.created_at ?? ""),
    lines: ((r.invoice_items ?? []) as any[]).map(
      (l): AbLine => ({
        id: String(l.id),
        description: String(l.description ?? ""),
        quantity: Number(l.quantity) || 0,
        unit: l.unit ?? null,
        unit_price: Number(l.unit_price) || 0,
        line_total: Number(l.line_total) || 0,
        import_source: l.import_source ?? null,
        import_key: l.import_key ?? null,
        edited: l.edited === true,
        line_kind: l.line_kind ?? null,
        sort_order: l.sort_order ?? null,
      }),
    ),
  }));

  // What is being marked.
  const t: AlreadyBilledSheetData["target"] = { kind, ids, words: "", cost: null, date: null, negative: false, billHasLines: false, billId: null };
  let entries: AbEntry[] = [];
  if (kind === "bill") {
    const { data: b, error } = await supabase
      .from("bills")
      .select("id, supplier, bill_number, supplier_invoice_number, amount, bill_date, job_id, bill_line_items(id, description, quantity, unit_price, amount, category, billable, billed_amount)")
      .eq("id", ids[0])
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) return { ok: false, error: "Couldn't read that bill just now. Nothing was changed - try again in a moment." };
    if (!b || (b as any).job_id !== jobId) return { ok: false, error: `That bill isn't on ${jobNumber} anymore. Reload the page.` };
    const bill = b as any;
    const lines = (bill.bill_line_items ?? []) as any[];
    const amount = Number(bill.amount) || 0;
    t.negative = amount < 0;
    t.cost = t.negative ? amount : billableBillCost(amount, lines);
    t.date = bill.bill_date ?? null;
    t.words = [String(bill.supplier ?? "").trim() || "The bill", bill.supplier_invoice_number || bill.bill_number || null].filter(Boolean).join(" ");
    t.billHasLines = lines.length > 0;
    t.billId = String(bill.id);
    t.ids = [String(bill.id)];
  } else if (kind === "po") {
    const { data: p, error } = await supabase.from("purchase_orders").select("id, po_number, vendor, total, job_id, created_at").eq("id", ids[0]).eq("org_id", orgId).maybeSingle();
    if (error) return { ok: false, error: "Couldn't read that order just now. Nothing was changed - try again in a moment." };
    if (!p || (p as any).job_id !== jobId) return { ok: false, error: `That order isn't on ${jobNumber} anymore. Reload the page.` };
    t.cost = Number((p as any).total) || 0;
    t.date = String((p as any).created_at ?? "") || null;
    t.words = [(p as any).po_number, (p as any).vendor].filter(Boolean).join(" · ") || "The order";
    t.ids = [String((p as any).id)];
  } else if (kind === "stock") {
    let stock: Awaited<ReturnType<typeof readJobStock>>;
    try {
      stock = await readJobStock(supabase as any, jobId, { orgId });
    } catch {
      return { ok: false, error: "Couldn't read the pieces taken from stock just now. Nothing was changed - try again in a moment." };
    }
    const take = stock.takes.find((x) => ids.some((id) => x.moveIds.includes(id)));
    if (!take) return { ok: false, error: `That take isn't on ${jobNumber} anymore. Reload the page.` };
    t.cost = take.cost;
    t.date = take.takenAt;
    t.words = stockCostLabel(take);
    t.ids = [...take.moveIds];
  } else {
    // HOURS: the job's closed shifts nobody has billed, the ones "Also not billed yet: X h" counts.
    try {
      const labor = await fetchJobLaborRows(supabase, jobId);
      const claims = await claimedSourcesOnJob(supabase as SupabaseClient, jobId, null, laborRowIds(labor));
      const free = withoutClaimedLabor(labor.jobEntries, new Set(claims.owner.keys()));
      entries = free.jobEntries
        .filter((e: any) => e?.clock_out && !(e.job_code && labor.nonBillableCodes.has(String(e.job_code).trim())))
        .map(
          (e: any): AbEntry => ({
            id: String(e.id),
            person: laborPersonKey(e.profiles),
            name: String(e.profiles?.full_name ?? "Crew"),
            clockIn: String(e.clock_in),
            hours: Math.max(0, Math.round(((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 - (Math.max(0, Number(e.lunch_minutes) || 0)) / 60) * 100) / 100),
          }),
        )
        .filter((e) => e.hours > 0)
        .sort((a, b) => a.clockIn.localeCompare(b.clockIn));
    } catch {
      return { ok: false, error: "Couldn't read this job's hours just now. Nothing was changed - try again in a moment." };
    }
    t.ids = entries.map((e) => e.id);
    t.words = "";
  }

  const drafts = all
    .filter((i) => i.status === "draft" && i.job_id === jobId)
    .map((i) => {
      const n = i.invoice_number ?? "A draft";
      return `${n} is still a draft: Add To ${n} puts it there.`;
    });
  const offered = sortInvoicesFor(all.filter(eligibleInvoice), t.date)
    .map((invoice) => {
      const lines = eligibleLines(invoice, { kind, negative: t.negative });
      return { invoice: { ...invoice, lines }, preselect: preselectLine(invoice, lines, kind) };
    })
    .filter((x) => x.invoice.lines.length > 0);

  return {
    ok: true,
    data: { jobId, jobNumber, tz: settings.timezone, shopStock: featureOn(settings.features, "shop_stock"), target: t, invoices: offered, drafts, entries },
  };
}

/**
 * THE PAPER CARD'S QUESTION (after a paper is filed on a job): the bill most likely to have charged
 * for it, when the job bills its actual costs and some sent bill has a line that could hold it.
 * Null otherwise, and on any failed read (the card simply doesn't ask; the Costs tab still can).
 */
export async function alreadyBilledOffer(supabase: Db, orgId: string, jobId: string, billId: string): Promise<{ invoiceNumber: string } | null> {
  try {
    const res = await loadAlreadyBilledSheet(supabase, orgId, jobId, { kind: "bill", ids: [billId] });
    if (!res.ok) return null;
    const first = res.data.invoices[0]?.invoice;
    return first ? { invoiceNumber: first.invoice_number ?? "the bill" } : null;
  } catch {
    return null;
  }
}
