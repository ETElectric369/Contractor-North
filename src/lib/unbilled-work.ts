/**
 * WHAT A JOB HAS WORKED THAT NO INVOICE HOLDS YET — the running total behind "bill what's new".
 *
 * Erik, 2026-09-11, on 85 Whitney: "i couldnt even make an invoice… kept referring to the old
 * invoice even though i have new time and new bills… we should have a running total of open time
 * and materials on the overview". Both sentences are this module. "Unbilled" means: closed time
 * entries / allocations NOT claimed by a labor line on any non-void invoice (invoice_items.
 * source_ids, 0255), plus bills and live purchase orders NOT claimed by any non-void invoice —
 * priced EXACTLY the way the importers and Nort's job numbers price them (computeJobLaborBilling
 * at the person's bill rate under the customer's level ceiling; materials per row at the
 * customer's level markup, else the org default). Nothing here is a second arithmetic: if this
 * figure and the invoice that gets drafted from it ever differ, one of them is a defect.
 *
 * Two layers, on purpose (the test-harness pattern — extract the math, then test the math):
 *   computeUnbilledWork / fixedBillingsToNet   pure, fed rows, unit-tested
 *   unbilledWorkForJob / fixedBillingsNotYetNetted  the fetchers the actions and pages call
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeJobLaborBilling, customerLaborRateForJob, customerMaterialMarkupForJob, fetchJobLaborRows, withoutClaimedLabor } from "@/lib/labor-billing";
import { livePurchaseOrders, type MaterialBill, type MaterialPo } from "@/lib/job-progress-math";
import { getOrgSettings } from "@/lib/org-settings";

/** The contract every consumer reads (job overview, Nort, the progress-draw builder). */
export type UnbilledWork = {
  /** Unclaimed labor hours, quarter-hour rounded per person — the quantity the lines would bill. */
  hours: number;
  laborAmount: number;
  laborByPerson: { name: string; hours: number; amount: number }[];
  /** Unclaimed supplier bills + live purchase orders, AT COST (before markup). */
  billsAmount: number;
  /** How many of them — bills and live POs together (a PO is a materials cost the importer bills the same way). */
  billsCount: number;
  markupPct: number;
  /** bills $ with markup — what the customer would be charged for them. */
  billsBilled: number;
  /** laborAmount + billsBilled. */
  total: number;
  /** The job's most recent non-void invoice (any status, drafts included), or null when there is none. */
  lastInvoiceNumber: string | null;
  lastInvoiceAt: string | null;
  /** Extras beyond the contract — safe to ignore, useful for a precise sentence. */
  lastInvoiceStatus: string | null;
  /** Bills skipped because the PO they name is already billed — the delivery was charged via the
   *  PO, so billing the bill too would charge it twice; a difference is the office's call. */
  poCoveredBills: number;
  /** Source rows (entries/allocations/bills/POs) another invoice already holds, and which ones. */
  claimedCount: number;
  claimedOn: string[];
  /** false until migration 0255 has landed — labor claims are unknowable before it. */
  schemaReady: boolean;
};

export type ClaimantInvoice = {
  id: string;
  invoice_number: string | null;
  status: string;
  created_at: string;
  /** The job the claimant sits on. Set by the org-wide read, so a claim held by an invoice on
   *  ANOTHER job (the entry was billed there, then moved here) can be named with its job. */
  job_id?: string | null;
  job_number?: string | null;
};

/** Every source row the job's non-void invoices claim, and who claims it. */
export type ClaimedSources = {
  /** source row id → the invoice holding the claim (the EARLIEST claimant when two hold it). */
  owner: Map<string, ClaimantInvoice>;
  /** The job's non-void invoices, newest first (the candidates that were read). Claimants found
   *  on OTHER jobs by id are in `owner` but never here — "last invoice" is this job's. */
  invoices: ClaimantInvoice[];
  /** false = invoice_items.source_ids does not exist yet (0255 not applied): labor claims unknown. */
  schemaReady: boolean;
  /** The job the read was for (null when it was by candidate ids alone), so claimantNumbers can
   *  say "INV-058 (J-021)" for a claimant that sits on a different job. */
  jobId?: string | null;
};

/** import_keys that name their source row directly. `bli:<id>` is deliberately NOT here — a bill
 *  line item's key names the line, not the bill; the bill id lives in source_ids (0255/0256). */
const KEYED_SOURCE = /^(?:po|bill|co|quote):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

type ClaimLine = { import_key?: string | null; source_ids?: string[] | null };
type ClaimRow = {
  id: string;
  invoice_number: string | null;
  status: string;
  created_at: string;
  job_id?: string | null;
  jobs?: { job_number?: string | null } | null;
  invoice_items?: ClaimLine[] | null;
};

/** The ids a set of lines holds — their source_ids plus the row a cost key names. What the
 *  un-void guard asks of the invoice coming back, and what foldClaims reads per line. */
export function claimedIdsOfLines(items: ClaimLine[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const it of items ?? []) {
    for (const sid of it.source_ids ?? []) if (sid) out.add(String(sid));
    const m = KEYED_SOURCE.exec(String(it.import_key ?? ""));
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** Every entry / allocation id in a fetchJobLaborRows result — the candidates a claim read looks
 *  up BY ID (an entry billed on one job and moved to another is claimed wherever it now sits). */
export function laborRowIds(labor: { jobEntries: any[]; jobAllocs: any[] }): string[] {
  const ids = new Set<string>();
  for (const e of labor.jobEntries ?? []) {
    if (e?.id) ids.add(String(e.id));
    for (const a of e?.time_allocations ?? []) if (a?.id) ids.add(String(a.id));
  }
  for (const a of labor.jobAllocs ?? []) if (a?.id) ids.add(String(a.id));
  return [...ids];
}

/**
 * Fold fetched invoices (+ their lines) into the claim map. Earliest invoice wins a contested id
 * so the map is stable no matter the fetch order. Pure — the DB twin lives in the integration test.
 *
 * `rows` are the job's own non-void invoices; `elsewhere` are invoices found BY ID on any job
 * (see claimedSourcesOnJob) — they enter `owner` so a moved entry is still seen as claimed, but
 * never `invoices`, which is this job's list. An invoice in both keeps its fuller job-side lines.
 */
export function foldClaims(rows: ClaimRow[], schemaReady: boolean, elsewhere: ClaimRow[] = [], jobId: string | null = null): ClaimedSources {
  const owner = new Map<string, ClaimantInvoice>();
  const claimant = (r: ClaimRow): ClaimantInvoice => ({
    id: r.id,
    invoice_number: r.invoice_number ?? null,
    status: r.status,
    created_at: r.created_at,
    job_id: r.job_id ?? jobId,
    job_number: r.jobs?.job_number ?? null,
  });
  const invoices: ClaimantInvoice[] = rows.map(claimant);
  const every = new Map<string, ClaimRow>(rows.map((r) => [r.id, r] as const));
  for (const r of elsewhere) if (!every.has(r.id)) every.set(r.id, { ...r, job_id: r.job_id ?? null });
  const oldestFirst = [...every.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const r of oldestFirst) {
    const inv = claimant(r);
    for (const sid of claimedIdsOfLines(r.invoice_items)) if (!owner.has(sid)) owner.set(sid, inv);
  }
  invoices.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { owner, invoices, schemaReady, jobId };
}

/** Ids per org-wide request: 100 uuids is ~3.7 KB of query string, well inside every proxy's limit. */
const OVERLAP_CHUNK = 100;

/** The one error shape a missing 0255 column produces — Postgres 42703, or PostgREST naming it. */
function isMissingSourceIds(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42703" || /source_ids/i.test(msg) || /does not exist/i.test(msg);
}

/**
 * Read the claims that matter to a job. `exceptInvoiceId` is the invoice being built — its own
 * lines never block its own refresh (re-importing into the same draft still works, exactly as
 * 0175 promised).
 *
 * TWO READS, folded together:
 *   per job    every non-void invoice on the job with its lines — the cost KEYS (po:/bill:/co:)
 *              live only here, and this is the list "last invoice" comes from;
 *   by id      `candidateIds` (the entries, allocations, bills and orders the caller is about to
 *              bill) looked up ORG-WIDE in invoice_items.source_ids. A claim is per row, not per
 *              job: an entry billed on J1 and moved to J2 afterwards is still billed, and a J2
 *              invoice that only asked "what does J2 hold" would bill it again. Chunked so a
 *              long job never builds a request too big to send.
 * `jobId` may be null (an invoice with no job): then only the by-id read runs.
 *
 * TOLERATES 0255 NOT BEING APPLIED YET: a push deploys before its migration runs, and a select
 * naming a missing column fails the whole query. On that one error shape it re-reads the job
 * without source_ids and reports schemaReady:false so the importers can fall back to refusing
 * rather than double-billing (keys still give the materials claims; nothing can be found by id).
 */
export async function claimedSourcesOnJob(
  supabase: SupabaseClient,
  jobId: string | null,
  exceptInvoiceId?: string | null,
  candidateIds?: Iterable<string>,
): Promise<ClaimedSources> {
  type Read = { data: ClaimRow[]; error: unknown | null };
  const readJob = async (withSourceIds: boolean): Promise<Read> => {
    if (!jobId) return { data: [], error: null };
    let q = supabase
      .from("invoices")
      .select(`id, invoice_number, status, created_at, job_id, invoice_items(import_key${withSourceIds ? ", source_ids" : ""})`)
      .eq("job_id", jobId)
      .neq("status", "void");
    if (exceptInvoiceId) q = q.neq("id", exceptInvoiceId);
    const { data, error } = await q;
    return { data: (data ?? []) as ClaimRow[], error };
  };
  const ids = [...new Set([...(candidateIds ?? [])].map((x) => String(x ?? "")).filter(Boolean))];
  const readById = async (): Promise<Read> => {
    const byInvoice = new Map<string, ClaimRow>();
    for (let i = 0; i < ids.length; i += OVERLAP_CHUNK) {
      let q = supabase
        .from("invoice_items")
        .select("import_key, source_ids, invoices!inner(id, invoice_number, status, created_at, job_id, jobs(job_number))")
        .overlaps("source_ids", ids.slice(i, i + OVERLAP_CHUNK))
        .neq("invoices.status", "void");
      if (exceptInvoiceId) q = q.neq("invoice_id", exceptInvoiceId);
      const { data, error } = await q;
      if (error) return { data: [], error };
      for (const it of (data ?? []) as any[]) {
        const inv = it.invoices;
        if (!inv?.id) continue;
        const row: ClaimRow = byInvoice.get(inv.id) ?? {
          id: inv.id,
          invoice_number: inv.invoice_number ?? null,
          status: inv.status,
          created_at: inv.created_at,
          job_id: inv.job_id ?? null,
          jobs: inv.jobs ?? null,
          invoice_items: [] as ClaimLine[],
        };
        row.invoice_items!.push({ import_key: it.import_key ?? null, source_ids: it.source_ids ?? null });
        byInvoice.set(inv.id, row);
      }
    }
    return { data: [...byInvoice.values()], error: null };
  };
  const [job, elsewhere] = await Promise.all([readJob(true), ids.length ? readById() : Promise.resolve<Read>({ data: [], error: null })]);
  if (!job.error && !elsewhere.error) return foldClaims(job.data, true, elsewhere.data, jobId);
  const err = job.error ?? elsewhere.error;
  if (isMissingSourceIds(err)) {
    const again = await readJob(false);
    if (again.error) throw again.error;
    return foldClaims(again.data, false, [], jobId);
  }
  throw err;
}

/** The invoice numbers (oldest first, deduped) that own the given source ids — for "already on
 *  INV-061". A claimant sitting on ANOTHER job is named with it — "INV-058 (J-021)" — because the
 *  office will look for it in this job's invoice list and not find it there. */
export function claimantNumbers(claims: ClaimedSources, ids: Iterable<string>): string[] {
  const seen = new Map<string, ClaimantInvoice>();
  for (const id of ids) {
    const inv = claims.owner.get(id);
    if (inv && !seen.has(inv.id)) seen.set(inv.id, inv);
  }
  return [...seen.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((inv) => {
      const num = inv.invoice_number ?? "an unnumbered invoice";
      const offJob = !!claims.jobId && !!inv.job_id && inv.job_id !== claims.jobId;
      return offJob ? `${num} (${inv.job_number ?? "another job"})` : num;
    });
}

/** "INV-061" / "INV-061 and INV-063" / "INV-061, INV-062 and INV-063" — the office's phrasing. */
export function joinNumbers(numbers: string[]): string {
  if (numbers.length <= 1) return numbers[0] ?? "";
  return `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export type UnbilledInput = {
  claims: ClaimedSources;
  jobEntries: any[];
  jobAllocs: any[];
  nonBillableCodes: ReadonlySet<string>;
  defaultRate: number;
  levelRate: number | null;
  pos: (MaterialPo & { id: string })[];
  bills: (MaterialBill & { id: string })[];
  markupPct: number;
};

/**
 * THE ARITHMETIC, on rows already fetched. Labor = computeJobLaborBilling over the rows that
 * survive the claim filter (the importer's exact pipeline). Materials = livePurchaseOrders over
 * ALL POs and bills (a bill supersedes its PO whoever billed it), then only the unclaimed ones,
 * marked up per row like importCostsIntoInvoice and computeJobProgress.
 */
export function computeUnbilledWork(input: UnbilledInput): UnbilledWork {
  const claimed = new Set(input.claims.owner.keys());
  const free = withoutClaimedLabor(input.jobEntries, input.jobAllocs, claimed);
  const { lines, total: laborAmount } = computeJobLaborBilling(free.jobEntries, free.jobAllocs, input.defaultRate, input.levelRate, input.nonBillableCodes);
  const laborByPerson = lines.map((l) => ({ name: l.name, hours: l.quantity, amount: l.amount }));
  const hours = cents(lines.reduce((s, l) => s + l.quantity, 0));

  const markupPct = Number.isFinite(Number(input.markupPct)) && Number(input.markupPct) >= 0 ? Number(input.markupPct) : 0;
  const mk = (cost: number) => cents(cost * (1 + markupPct / 100));
  const skippedIds: string[] = [...free.skippedIds];
  let billsAmount = 0;
  let billsBilled = 0;
  let billsCount = 0;
  let poCoveredBills = 0;
  for (const p of livePurchaseOrders(input.pos ?? [], input.bills ?? [])) {
    const cost = Number(p.total) || 0;
    if (!(cost > 0)) continue;
    if (claimed.has(p.id)) {
      skippedIds.push(p.id);
      continue;
    }
    billsAmount = cents(billsAmount + cost);
    billsBilled = cents(billsBilled + mk(cost));
    billsCount += 1;
  }
  for (const b of input.bills ?? []) {
    const cost = Number(b.amount) || 0;
    if (!(cost > 0)) continue;
    if (claimed.has(b.id)) {
      skippedIds.push(b.id);
      continue;
    }
    // The delivery was already billed through its PO on another invoice — see UnbilledWork.poCoveredBills.
    if (typeof b.po_id === "string" && b.po_id && claimed.has(b.po_id)) {
      poCoveredBills += 1;
      continue;
    }
    billsAmount = cents(billsAmount + cost);
    billsBilled = cents(billsBilled + mk(cost));
    billsCount += 1;
  }

  const last = input.claims.invoices[0] ?? null;
  return {
    hours,
    laborAmount,
    laborByPerson,
    billsAmount,
    billsCount,
    markupPct,
    billsBilled,
    total: cents(laborAmount + billsBilled),
    lastInvoiceNumber: last?.invoice_number ?? null,
    lastInvoiceAt: last?.created_at ?? null,
    lastInvoiceStatus: last?.status ?? null,
    poCoveredBills,
    claimedCount: skippedIds.length,
    claimedOn: claimantNumbers(input.claims, skippedIds),
    schemaReady: input.claims.schemaReady,
  };
}

/** The fetcher — the ONE call a page, an action or Nort makes. Same resolvers as the importers
 *  (fetchJobLaborRows, customerLaborRateForJob, customerMaterialMarkupForJob), so the figure it
 *  returns is the figure a draft built from it will carry. */
export async function unbilledWorkForJob(supabase: SupabaseClient, jobId: string): Promise<UnbilledWork> {
  const [labor, { data: org }, levelRate, { data: pos }, { data: bills }] = await Promise.all([
    fetchJobLaborRows(supabase, jobId),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    customerLaborRateForJob(supabase, jobId),
    // id + status + po_id feed the shared live-PO rule (see livePurchaseOrders) — and id is the claim key.
    supabase.from("purchase_orders").select("id, total, status").eq("job_id", jobId),
    supabase.from("bills").select("id, amount, po_id").eq("job_id", jobId),
  ]);
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  // Claims AFTER the rows, never beside them: the read wants every candidate id so a row billed on
  // another job (moved since) is still seen as claimed. The markup resolver rides along.
  const candidates = [...laborRowIds(labor), ...((pos ?? []) as { id: string }[]).map((p) => String(p.id)), ...((bills ?? []) as { id: string }[]).map((b) => String(b.id))];
  const [claims, markupPct] = await Promise.all([
    claimedSourcesOnJob(supabase, jobId, null, candidates),
    customerMaterialMarkupForJob(supabase, jobId, settings.material_markup_percent),
  ]);
  return computeUnbilledWork({
    claims,
    jobEntries: labor.jobEntries,
    jobAllocs: labor.jobAllocs,
    nonBillableCodes: labor.nonBillableCodes,
    defaultRate: settings.default_labor_rate,
    levelRate,
    pos: (pos ?? []) as (MaterialPo & { id: string })[],
    bills: (bills ?? []) as (MaterialBill & { id: string })[],
    markupPct,
  });
}

// ── The prior-billings credit on a delta draw ──────────────────────────────────────────────────

/** Line sources that ARE the rows — a line carrying one of these is work itemized from the job,
 *  never a lump the customer paid up front. */
const ROW_SOURCES = new Set(["labor", "costs", "change_orders", "quote"]);

export type PriorInvoiceRow = {
  id: string;
  status: string;
  invoice_kind: string | null;
  invoice_items?: { import_source?: string | null; line_total?: number | string | null }[] | null;
};

/**
 * WHAT A NEW DRAW STILL HAS TO NET — the "Less previous billings" figure, re-derived for delta draws.
 *
 * The old cumulative draw itemized ALL the job's work every time and credited EVERY prior
 * invoice's subtotal. A delta draw itemizes only unclaimed rows, so nothing already itemized is
 * on it and nothing already itemized may be credited. What still has to be netted is money the
 * customer paid AGAINST work rather than FOR itemized work — a LUMP draw: a deposit, a milestone
 * draw, a fixed-$ or %-of-estimate draw — minus whatever earlier draws already credited.
 *
 * WHICH LINES ARE THE LUMP. A fixed/percent draw's own amount line carries no import_source (it
 * is typed by createProgressInvoice, not imported), so by source alone it looks exactly like a
 * hand-typed extra on a delta draw. The tell is the DOCUMENT: a draw that itemizes nothing from
 * the job's rows is a payment request, and its lines are the amount asked for; a draw that does
 * itemize (labor/costs/change orders/estimate lines) is a delta, and a hand line on it — "Lift
 * rental 4 hr" typed under the hours — is an extra the customer bought, never a prepayment. A
 * milestone line and the credit line are lump money wherever they sit. Hand lines on a STANDARD
 * invoice are never netted either (the $400 referral on INV-061 is exactly the $400 the old
 * modal read low).
 *
 * Drafts and void invoices don't count (a draft isn't a bill yet); the invoice being built is
 * excluded by the caller. Floored at $0 — a job that over-credited can't grow money here.
 */
export function fixedBillingsToNet(invoices: PriorInvoiceRow[]): number {
  let fixed = 0;
  let credited = 0;
  for (const inv of invoices ?? []) {
    if (inv.status === "void" || inv.status === "draft") continue;
    const kind = inv.invoice_kind ?? "standard";
    const isDraw = kind !== "standard";
    const items = inv.invoice_items ?? [];
    const itemized = items.some((it) => ROW_SOURCES.has(it.import_source ?? ""));
    const lump = isDraw && (kind === "deposit" || !itemized);
    for (const it of items) {
      const amt = Number(it.line_total);
      if (!Number.isFinite(amt)) continue;
      const src = it.import_source ?? null;
      if (src === "draw_credit") credited += Math.abs(amt);
      else if (isDraw && src === "milestone") fixed += amt;
      else if (lump && !ROW_SOURCES.has(src ?? "")) fixed += amt;
    }
  }
  return Math.max(0, cents(fixed - credited));
}

export async function fixedBillingsNotYetNetted(supabase: SupabaseClient, jobId: string, exceptInvoiceId?: string | null): Promise<number> {
  let q = supabase
    .from("invoices")
    .select("id, status, invoice_kind, invoice_items(import_source, line_total)")
    .eq("job_id", jobId)
    .neq("status", "void");
  if (exceptInvoiceId) q = q.neq("id", exceptInvoiceId);
  const { data, error } = await q;
  if (error) throw error;
  return fixedBillingsToNet((data ?? []) as PriorInvoiceRow[]);
}
