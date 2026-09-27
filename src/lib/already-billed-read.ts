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
 *   readAlreadyBilledReach where the sheet can work, for many jobs at once (the paper cards' door,
 *                          the bills ledger's rows, the Costs tab), and what the jobs' bills hold
 *   loadNoJobHoursSheet    the sheet for hours on NO job: the org's sent invoices with no job and
 *                          their lines of work, and every closed shift on no job nobody has billed
 *   readNoJobHoursReach    for the Needs You row of a shift on no job: can any invoice with no job
 *                          hold it, and which of those shifts some invoice already holds
 *   readNoJobHandHours     an invoice with no job's hours marked by hand, for Not Billed After All
 *
 * EVERY READ SAYS WHEN IT FAILED, and a database without 0357 (no hand_claims) answers "needs an
 * update", never a crash and never an empty list that reads as "nothing billed".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { openDraftOnJob, type OpenDraft } from "@/lib/actuals-draw";
import { billableBillCost } from "@/lib/bill-itemisation";
import { isDrawKind } from "@/lib/invoice-math";
import { featureOn } from "@/lib/features";
import { isLiveQuote, nextInvoiceImportsActuals } from "@/lib/invoice-import-rule";
import { fetchJobLaborRows, laborPersonKey, withoutClaimedLabor } from "@/lib/labor-billing";
import { getOrgSettings } from "@/lib/org-settings";
import { readJobStock, stockCostLabel } from "@/lib/stock-billing";
import { claimedIdsOfLines, claimedSourcesOnJob, laborRowIds } from "@/lib/unbilled-work";
import {
  NEEDS_UPDATE,
  abLineOf,
  eligibleInvoice,
  eligibleLines,
  jobReach,
  noJobCanHoldHours,
  noJobPreticked,
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
  /** HOURS ON NO JOB (loadNoJobHoursSheet): the lines are on invoices with no job, the shifts are on
   *  no job, and `preticked` are the ones the door was pressed on. Absent: a job's sheet. */
  noJob?: boolean;
  preticked?: string[];
  /** Said above the list when a shift the door named isn't open to mark any more. */
  note?: string | null;
};

/** A closed shift's hours less lunch, to the hundredth (never below zero). */
function entryHours(e: { clock_in: string; clock_out: string; lunch_minutes?: number | null }): number {
  return Math.max(0, Math.round(((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 3_600_000 - Math.max(0, Number(e.lunch_minutes) || 0) / 60) * 100) / 100);
}

const LINE_COLUMNS = "id, description, quantity, unit, unit_price, line_total, import_source, import_key, edited, line_kind, sort_order, hand_claims, source_ids";

type Loaded = { ok: true; data: AlreadyBilledSheetData } | { ok: false; error: string; needsUpdate?: boolean };

/**
 * What the Already Billed sheet offers for one cost on one job. Staff only (the caller checks, and
 * RLS reads nothing money-shaped for a tech anyway). Only on a job whose next New Invoice pulls its
 * actual costs (nextInvoiceImportsActuals, createInvoiceForJob's own rule): every T&M job with no
 * schedule, and a fixed-price one with no live estimate (J-010 Purple Sage), where a charge made by
 * hand that can't be recorded is billed again.
 */
export async function loadAlreadyBilledSheet(supabase: Db, orgId: string, jobId: string, target: AlreadyBilledTarget): Promise<Loaded> {
  const kind = target?.kind;
  const ids = [...new Set((target?.ids ?? []).map((x) => String(x ?? "")).filter(Boolean))];
  if (!["bill", "po", "stock", "time"].includes(String(kind))) return { ok: false, error: "Couldn't tell what you meant to mark. Nothing was changed." };
  if (kind !== "time" && !ids.length) return { ok: false, error: "Couldn't tell what you meant to mark. Nothing was changed." };

  const [jobRead, msRead, orgRead, quoteRead] = await Promise.all([
    supabase.from("jobs").select("id, job_number, name, customer_id, billing_type").eq("id", jobId).eq("org_id", orgId).maybeSingle(),
    supabase.from("payment_milestones").select("id").eq("job_id", jobId).eq("org_id", orgId),
    supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    supabase.from("quotes").select("id, status").eq("job_id", jobId).eq("org_id", orgId),
  ]);
  if (jobRead.error || msRead.error || orgRead.error || quoteRead.error)
    return { ok: false, error: "Couldn't read this job just now. Nothing was changed - try again in a moment." };
  const job = jobRead.data as { id: string; job_number?: string | null; name?: string | null; customer_id?: string | null; billing_type?: string | null } | null;
  if (!job) return { ok: false, error: "That job isn't here anymore. Reload the page." };
  const jobNumber = String(job.job_number ?? "").trim() || "This job";
  const hasLiveQuote = ((quoteRead.data ?? []) as { status?: string | null }[]).some((q) => isLiveQuote(q.status));
  if (!nextInvoiceImportsActuals(job.billing_type, (msRead.data ?? []).length, hasLiveQuote))
    return { ok: false, error: `${jobNumber} is billed by its contract, not by its time and materials, so nothing on it is marked billed line by line.` };
  const settings = getOrgSettings((orgRead.data as { settings?: unknown } | null)?.settings);

  // The bills: the job's, and its customer's with no job. With hand_claims, which is how 0357 is known.
  // Never a no-job bill for a Time & Material job: its work to date counts only its own invoices
  // (tmWorkToDate), so a row held on one would drop out of it (mark_already_billed refuses it too).
  const invRead = await supabase
    .from("invoices")
    .select(`id, invoice_number, status, invoice_kind, job_id, created_at, invoice_items(${LINE_COLUMNS})`)
    .eq("org_id", orgId)
    .neq("status", "void")
    .or(jobOrCustomersJobless(job.id, job.billing_type === "tm" ? null : job.customer_id));
  if (invRead.error) {
    if (isMissingHandClaims(invRead.error)) return { ok: false, error: NEEDS_UPDATE, needsUpdate: true };
    return { ok: false, error: "Couldn't read this job's bills just now. Nothing was changed - try again in a moment." };
  }
  // What each line already claims, for the hours it already holds (hours only, below).
  const claimsOf = new Map<string, string[]>();
  const all: AbInvoice[] = ((invRead.data ?? []) as any[]).map((r) => ({
    id: String(r.id),
    invoice_number: r.invoice_number ?? null,
    status: String(r.status ?? ""),
    invoice_kind: r.invoice_kind ?? null,
    job_id: r.job_id ?? null,
    created_at: String(r.created_at ?? ""),
    lines: ((r.invoice_items ?? []) as any[]).map((l): AbLine => {
      claimsOf.set(String(l.id), ((l.source_ids ?? []) as unknown[]).map(String));
      return abLineOf(l);
    }),
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
      // THE HOURS EACH LINE ALREADY HOLDS: every closed shift on the job, claimed or not, by id. The
      // tick to start fills only what a line has room for beside them (precheckHours).
      const shiftHours = new Map<string, number>();
      for (const e of labor.jobEntries as any[]) if (e?.id && e?.clock_out) shiftHours.set(String(e.id), entryHours(e));
      for (const inv of all)
        for (const l of inv.lines) {
          const held = (claimsOf.get(l.id) ?? []).reduce((s, id) => s + (shiftHours.get(id) ?? 0), 0);
          l.heldHours = Math.round(held * 100) / 100;
        }
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
            family: String(e.split_from ?? e.id),
            hours: entryHours(e),
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

  // THE DRAFTS, SAID INSTEAD OF OFFERED, naming only a door that is there. "Add To INV-x" is the
  // Overview card's door, and it lands only on the draft New Invoice would bring up to date
  // (openDraftOnJob: a standard draft with no estimate copied on and no live draw beside it, or a
  // draw built from the actuals). A deposit or set-amount draw bills a slice, never this; any other
  // draft is opened and added to by hand. A lost read names no button.
  const jobDrafts = all.filter((i) => i.status === "draft" && i.job_id === jobId);
  let door: OpenDraft | null | undefined;
  if (jobDrafts.length) {
    try {
      door = await openDraftOnJob(supabase as SupabaseClient, jobId);
    } catch {
      door = undefined;
    }
  }
  const drafts = jobDrafts.map((i) => {
    const n = i.invoice_number ?? "A draft";
    if (door && door.id === i.id && door.refreshable) return `${n} is still a draft: Add To ${n} puts it there.`;
    if (door && door.id === i.id && isDrawKind(i.invoice_kind)) return `${n} is a set amount, so this goes on the next bill.`;
    return `${n} is still a draft: open it to add this there.`;
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

// ── Where the sheet can work, for many jobs at once ─────────────────────────────────────────────

/** How many ids go in one `in (...)` filter: a PostgREST filter rides in the URL. */
const IN_CHUNK = 100;
function chunks<T>(xs: readonly T[], n = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

type InvoiceRow = {
  id: string;
  invoice_number?: string | null;
  status?: string | null;
  invoice_kind?: string | null;
  job_id?: string | null;
  customer_id?: string | null;
  created_at?: string | null;
  invoice_items?: any[] | null;
};

const INVOICE_WITH_LINES = `id, invoice_number, status, invoice_kind, job_id, customer_id, created_at, invoice_items(${LINE_COLUMNS})`;

function abInvoiceOf(r: InvoiceRow): AbInvoice {
  return {
    id: String(r.id),
    invoice_number: r.invoice_number ?? null,
    status: String(r.status ?? ""),
    invoice_kind: r.invoice_kind ?? null,
    job_id: r.job_id ?? null,
    created_at: String(r.created_at ?? ""),
    lines: ((r.invoice_items ?? []) as any[]).map(abLineOf),
  };
}

/** Every id a person marked on these invoices (hand_claims), by the id: the line that holds it. */
function handsOf(rows: readonly InvoiceRow[]): Map<string, HandClaim> {
  const out = new Map<string, HandClaim>();
  for (const r of rows)
    for (const l of (r.invoice_items ?? []) as any[])
      for (const id of (l?.hand_claims ?? []) as unknown[])
        if (!out.has(String(id)))
          out.set(String(id), { lineId: String(l.id), invoiceId: String(r.id), invoiceNumber: r.invoice_number ?? null, status: String(r.status ?? "") });
  return out;
}

type Rows = { data: any[] | null; error: unknown };

/** One read's rows; a lost read throws. */
async function rowsOf(q: PromiseLike<Rows>): Promise<any[]> {
  const r = await q;
  if (r.error) throw r.error;
  return r.data ?? [];
}

/** One read, `in` chunk by chunk; a lost chunk throws. */
async function readIn(ids: readonly string[], q: (part: string[]) => PromiseLike<Rows>): Promise<any[]> {
  const out: any[] = [];
  for (const part of chunks(ids)) {
    const r = await q(part);
    if (r.error) throw r.error;
    out.push(...(r.data ?? []));
  }
  return out;
}

export type AlreadyBilledReach = {
  /** false: 0357 isn't on this database, so no door is drawn (the mark would only say so). */
  ready: boolean;
  /** Per job: can the sheet hold a charge, or a supplier return, there (lib/already-billed jobReach). */
  jobs: Map<string, { charge: boolean; ret: boolean }>;
  /** Ids a person marked, on the live invoices read (the jobs' own, and every invoice with no job). */
  hands: Map<string, HandClaim>;
  /** Every id any live invoice read holds (an import's key or claim, or a mark), plus any of
   *  `candidateIds` a live invoice anywhere in the company holds. */
  claimed: Set<string>;
};

/**
 * WHERE THE SHEET CAN WORK, FOR MANY JOBS AT ONCE: the paper cards' Already Billed door, the bills
 * ledger's rows and the Costs tab all ask this, so a door shows exactly where the sheet it opens has
 * a line to pick (loadAlreadyBilledSheet's own rules: nextInvoiceImportsActuals, the job's live
 * invoices and, for a job that isn't Time & Material, its customer's invoices with no job).
 * Org-filtered on every read. A lost read throws: the caller draws no door and logs it (the sheet's
 * other doors still say what they find). `candidateIds`: ids to look up in every live invoice of the
 * company (a bill claimed on some other job's invoice is still claimed).
 */
export async function readAlreadyBilledReach(
  supabase: Db,
  orgId: string,
  jobIds: Iterable<string>,
  candidateIds: Iterable<string> = [],
): Promise<AlreadyBilledReach> {
  const ids = [...new Set([...jobIds].map((x) => String(x ?? "")).filter((x) => UUID_RE.test(x)))];
  const candidates = [...new Set([...candidateIds].map((x) => String(x ?? "")).filter(Boolean))];
  const empty: AlreadyBilledReach = { ready: true, jobs: new Map(), hands: new Map(), claimed: new Set() };
  if (!ids.length) return empty;
  const invoicesRead = async (): Promise<{ ready: boolean; own: InvoiceRow[]; jobless: InvoiceRow[] }> => {
    try {
      const [own, jobless] = await Promise.all([
        readIn(ids, (part) => supabase.from("invoices").select(INVOICE_WITH_LINES).eq("org_id", orgId).neq("status", "void").in("job_id", part) as any),
        rowsOf(supabase.from("invoices").select(INVOICE_WITH_LINES).eq("org_id", orgId).neq("status", "void").is("job_id", null).limit(2000) as any),
      ]);
      return { ready: true, own: own as InvoiceRow[], jobless: jobless as InvoiceRow[] };
    } catch (e) {
      if (isMissingHandClaims(e)) return { ready: false, own: [], jobless: [] };
      throw e;
    }
  };
  const [jobs, milestones, quotes, inv, elsewhere] = await Promise.all([
    readIn(ids, (part) => supabase.from("jobs").select("id, billing_type, customer_id").eq("org_id", orgId).in("id", part) as any),
    readIn(ids, (part) => supabase.from("payment_milestones").select("job_id").eq("org_id", orgId).in("job_id", part) as any),
    readIn(ids, (part) => supabase.from("quotes").select("job_id, status").eq("org_id", orgId).in("job_id", part) as any),
    invoicesRead(),
    candidates.length ? claimedSourcesOnJob(supabase as SupabaseClient, null, null, candidates, { orgId }) : Promise.resolve(null),
  ]);
  if (!inv.ready) return { ...empty, ready: false };
  const msCount = new Map<string, number>();
  for (const m of milestones) msCount.set(String(m.job_id), (msCount.get(String(m.job_id)) ?? 0) + 1);
  const liveQuote = new Set<string>();
  for (const q of quotes) if (isLiveQuote(q.status)) liveQuote.add(String(q.job_id));
  const ownBy = new Map<string, AbInvoice[]>();
  for (const r of inv.own) {
    const key = String(r.job_id ?? "");
    ownBy.set(key, [...(ownBy.get(key) ?? []), abInvoiceOf(r)]);
  }
  const joblessBy = new Map<string, AbInvoice[]>();
  for (const r of inv.jobless) {
    if (!r.customer_id) continue;
    const key = String(r.customer_id);
    joblessBy.set(key, [...(joblessBy.get(key) ?? []), abInvoiceOf(r)]);
  }
  const reach = new Map<string, { charge: boolean; ret: boolean }>();
  for (const j of jobs as { id: string; billing_type?: string | null; customer_id?: string | null }[]) {
    const id = String(j.id);
    const imports = nextInvoiceImportsActuals(j.billing_type, msCount.get(id) ?? 0, liveQuote.has(id));
    // Never an invoice with no job for a Time & Material job: its work to date counts only its own
    // invoices (the sheet and mark_already_billed refuse it too).
    const offered = [...(ownBy.get(id) ?? []), ...(j.billing_type !== "tm" && j.customer_id ? (joblessBy.get(String(j.customer_id)) ?? []) : [])];
    reach.set(id, jobReach(imports, offered));
  }
  const rows = [...inv.own, ...inv.jobless];
  const claimed = new Set<string>();
  for (const r of rows) for (const id of claimedIdsOfLines((r.invoice_items ?? []) as any[])) claimed.add(id);
  for (const id of elsewhere?.owner.keys() ?? []) claimed.add(String(id));
  return { ready: true, jobs: reach, hands: handsOf(rows), claimed };
}

// ── Hours on NO job ──────────────────────────────────────────────────────────────────────────────

/** The most shifts on no job the sheet lists, newest first (the ones the door names always ride). */
export const NO_JOB_SHEET_CAP = 150;

const NO_JOB_ENTRY_COLUMNS = "id, clock_in, clock_out, lunch_minutes, job_code, split_from, profiles(id, full_name)";

/**
 * THE SHEET FOR HOURS ON NO JOB (the TTUSD days on INV-055, Ben Ebenezer's on INV-058): a shift
 * nobody put on a job was billed by typing a line on an invoice with no job. Offered: the company's
 * invoices with no job that went out, with only their lines of work (lib/already-billed eligibleLines,
 * labor first). Listed: every closed shift on no job that no live invoice holds (never a running one,
 * never the company's own time code, never an empty one), and `pressed` ticked to start (a split
 * shift whole). No line is picked to start: he picks it. mark_already_billed accepts a shift on no
 * job only there, so nothing else is offered.
 */
export async function loadNoJobHoursSheet(supabase: Db, orgId: string, pressed: string[]): Promise<Loaded> {
  const want = [...new Set((pressed ?? []).map((x) => String(x ?? "")).filter(Boolean))].slice(0, IN_CHUNK);
  const entries = () =>
    supabase
      .from("time_entries")
      .select(NO_JOB_ENTRY_COLUMNS)
      .eq("org_id", orgId)
      .is("job_id", null)
      .eq("status", "closed")
      .not("clock_out", "is", null);
  const [orgRead, invRead, newest, named, codesRead] = await Promise.all([
    supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle(),
    supabase.from("invoices").select(INVOICE_WITH_LINES).eq("org_id", orgId).neq("status", "void").is("job_id", null).limit(2000),
    entries().order("clock_in", { ascending: false }).limit(NO_JOB_SHEET_CAP),
    want.length ? entries().in("id", want) : Promise.resolve({ data: [] as any[], error: null }),
    supabase.from("job_codes").select("code").eq("org_id", orgId).eq("billable", false),
  ]);
  if (invRead.error) {
    if (isMissingHandClaims(invRead.error)) return { ok: false, error: NEEDS_UPDATE, needsUpdate: true };
    return { ok: false, error: "Couldn't read your invoices with no job just now. Nothing was changed - try again in a moment." };
  }
  if (orgRead.error || newest.error || named.error || codesRead.error)
    return { ok: false, error: "Couldn't read the hours on no job just now. Nothing was changed - try again in a moment." };
  const settings = getOrgSettings((orgRead.data as { settings?: unknown } | null)?.settings);
  const nonBillable = new Set(((codesRead.data ?? []) as { code?: string | null }[]).map((c) => String(c.code ?? "").trim()).filter(Boolean));
  const byId = new Map<string, any>();
  for (const e of [...((named.data ?? []) as any[]), ...((newest.data ?? []) as any[])]) if (e?.id) byId.set(String(e.id), e);
  const rows = [...byId.values()];

  const invoiceRows = (invRead.data ?? []) as InvoiceRow[];
  const all: AbInvoice[] = invoiceRows.map(abInvoiceOf);
  // What each line already holds, for the hours it already charges beside these (hours only).
  const claimsOfLine = new Map<string, string[]>();
  for (const r of invoiceRows)
    for (const l of (r.invoice_items ?? []) as any[]) claimsOfLine.set(String(l?.id), ((l?.source_ids ?? []) as unknown[]).map(String));
  const heldIds = [...new Set([...claimsOfLine.values()].flat())];
  let claimed: Set<string>;
  let heldHours: Map<string, number>;
  try {
    const [c, held] = await Promise.all([
      rows.length ? claimedSourcesOnJob(supabase as SupabaseClient, null, null, rows.map((e) => String(e.id)), { orgId }) : Promise.resolve(null),
      readIn(heldIds, (part) => supabase.from("time_entries").select("id, clock_in, clock_out, lunch_minutes").eq("org_id", orgId).in("id", part) as any),
    ]);
    claimed = new Set([...(c?.owner.keys() ?? [])].map(String));
    heldHours = new Map(held.filter((e) => e?.clock_out).map((e) => [String(e.id), entryHours(e)] as const));
  } catch {
    return { ok: false, error: "Couldn't tell which hours on no job are already billed just now. Nothing was changed - try again in a moment." };
  }
  for (const inv of all)
    for (const l of inv.lines) {
      const held = (claimsOfLine.get(l.id) ?? []).reduce((s, id) => s + (heldHours.get(id) ?? 0), 0);
      l.heldHours = Math.round(held * 100) / 100;
    }

  const open: AbEntry[] = rows
    .filter((e) => !claimed.has(String(e.id)))
    .filter((e) => !(e.job_code && nonBillable.has(String(e.job_code).trim())))
    .map(
      (e): AbEntry => ({
        id: String(e.id),
        person: laborPersonKey(e.profiles),
        name: String(e.profiles?.full_name ?? "Crew"),
        clockIn: String(e.clock_in),
        family: String(e.split_from ?? e.id),
        hours: entryHours(e),
      }),
    )
    .filter((e) => e.hours > 0)
    .sort((a, b) => a.clockIn.localeCompare(b.clockIn));
  const preticked = noJobPreticked(open, want);
  const gone = want.filter((id) => !open.some((e) => e.id === id));
  const note = gone.length
    ? gone.length === want.length
      ? "That shift isn't open to mark any more: an invoice already holds it, or it is on a job now. Reload the page."
      : "Some of those shifts aren't open to mark any more: an invoice already holds them, or they are on a job now."
    : null;

  const firstDay = open.find((e) => preticked.includes(e.id))?.clockIn ?? null;
  const drafts = all.filter((i) => i.status === "draft").map((i) => `${i.invoice_number ?? "A draft"} is still a draft: open it to add these there.`);
  // NOTHING IS PICKED FOR HIM HERE. These are every invoice with no job the company sent, to any
  // customer or none (INV-073's $1.11 "Test 5" sorts first at ET): an invoice's only line is no clue
  // that it charged for these hours, and one tap would claim them there.
  const offered = sortInvoicesFor(all.filter(eligibleInvoice), firstDay)
    .map((invoice) => ({ invoice: { ...invoice, lines: eligibleLines(invoice, { kind: "time" }) }, preselect: null }))
    .filter((x) => x.invoice.lines.length > 0);
  return {
    ok: true,
    data: {
      jobId: "",
      jobNumber: "No Job",
      tz: settings.timezone,
      shopStock: featureOn(settings.features, "shop_stock"),
      target: { kind: "time", ids: open.map((e) => e.id), words: "", cost: null, date: firstDay, negative: false, billHasLines: false, billId: null },
      invoices: offered,
      drafts,
      entries: open,
      noJob: true,
      preticked,
      note,
    },
  };
}

/**
 * FOR THE NEEDS YOU ROW OF A SHIFT ON NO JOB: can any sent invoice with no job hold hours (the door
 * shows only then: a door onto a sheet with no line to pick is a dead end), and which of `entryIds`
 * a live invoice already holds (those are billed, so their row stops saying nobody can bill them).
 * Throws on a lost read; the caller keeps the rows and shows the door (the sheet says what it finds).
 */
export async function readNoJobHoursReach(supabase: Db, orgId: string, entryIds: string[]): Promise<{ canHold: boolean; claimed: Set<string> }> {
  const ids = [...new Set((entryIds ?? []).map(String).filter(Boolean))];
  const [invRead, claims] = await Promise.all([
    supabase.from("invoices").select(INVOICE_WITH_LINES).eq("org_id", orgId).neq("status", "void").is("job_id", null).limit(2000),
    ids.length ? claimedSourcesOnJob(supabase as SupabaseClient, null, null, ids, { orgId }) : Promise.resolve(null),
  ]);
  const claimed = new Set([...(claims?.owner.keys() ?? [])].map(String));
  if (invRead.error) {
    if (isMissingHandClaims(invRead.error)) return { canHold: false, claimed };
    throw invRead.error;
  }
  return { canHold: noJobCanHoldHours(((invRead.data ?? []) as InvoiceRow[]).map(abInvoiceOf)), claimed };
}

/**
 * AN INVOICE WITH NO JOB'S HOURS MARKED BY HAND (the way back for hours on no job: they have no job
 * page, so Not Billed After All lives on the invoice that holds them). Per line: the shifts on no job
 * it holds by hand, in words. `ready` false: 0357 isn't on this database. A lost read throws.
 */
export async function readNoJobHandHours(
  supabase: Db,
  orgId: string,
  invoiceId: string,
): Promise<{ ready: boolean; lines: { lineId: string; description: string; ids: string[]; hours: number; what: string }[] }> {
  const { data, error } = await supabase
    .from("invoice_items")
    .select("id, description, hand_claims")
    .eq("org_id", orgId)
    .eq("invoice_id", invoiceId)
    .neq("hand_claims", "{}");
  if (error) {
    if (isMissingHandClaims(error)) return { ready: false, lines: [] };
    throw error;
  }
  const lines = (data ?? []) as { id: string; description?: string | null; hand_claims?: string[] | null }[];
  const ids = [...new Set(lines.flatMap((l) => (l.hand_claims ?? []).map(String)))];
  if (!ids.length) return { ready: true, lines: [] };
  const shifts = await readIn(
    ids,
    (part) =>
      supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, lunch_minutes, profiles(full_name)")
        .eq("org_id", orgId)
        .is("job_id", null)
        .in("id", part) as any,
  );
  const out: { lineId: string; description: string; ids: string[]; hours: number; what: string }[] = [];
  for (const l of lines) {
    const held = new Set((l.hand_claims ?? []).map(String));
    const mine = shifts.filter((e) => held.has(String(e.id)) && e.clock_out);
    if (!mine.length) continue;
    const hours = Math.round(mine.reduce((s, e) => s + entryHours(e), 0) * 100) / 100;
    const names = [...new Set(mine.map((e) => String(e.profiles?.full_name ?? "")).filter(Boolean))];
    out.push({
      lineId: String(l.id),
      description: String(l.description ?? "").trim() || "A line",
      ids: mine.map((e) => String(e.id)),
      hours,
      what: names.length === 1 ? `${hours} h of ${names[0]}'s time` : `${hours} h of time`,
    });
  }
  return { ready: true, lines: out };
}
