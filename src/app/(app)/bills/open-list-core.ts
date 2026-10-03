import "server-only";

import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz } from "@/lib/tz";
import { proposalOf, type PaperProposal } from "@/lib/paperwork";
import { readAllPages } from "@/lib/read-all-pages";
import { isLongNumber } from "@/lib/same-purchase";
import {
  columnsFromRemembered,
  discountLine,
  listDateSaid,
  moneyCents,
  planHeadline,
  readOpenListTable,
  reconcileOpenList,
  referenceKey,
  type OpenList,
  type OpenListApplied,
  type OpenListPaper,
  type OpenListView,
  type PaperFields,
  type RememberedColumns,
  type StoredOpenList,
} from "@/lib/supplier-open-list";
import { insertPaperRow } from "@/app/(app)/organize/paperwork-core";

/**
 * A SUPPLIER'S OPEN LIST, ON THE SERVER (2026-09-26): the reads, the one Apply and its Undo. Not a
 * "use server" module; the doors that can be pressed are in open-list-actions.ts (requireStaff) and
 * in the drop and paste doors that already existed, and each checks who is asking first.
 *
 * ORG_ID ON EVERY READ AND WRITE. The pages read with the signed-in client, whose RLS already
 * holds the company line, and every query here filters org_id anyway (0173: a rule at one read
 * path is a convention, not a boundary). Every write comes back with .select("id"), because a
 * zero-row write is a 204 and a 204 reads exactly like success.
 */

type Db = any;

export type SupplierAccountLite = { id: string; name: string; account_number: string | null; on_account: boolean | null; open_list_columns?: unknown };

const PAPER_COLUMNS = "id, invoice_number, kind, invoice_date, due_date, total, open_balance, closed, discount_amount, discount_by, job_name_raw, supplier_account_id";

type PaperRow = {
  id: string;
  invoice_number: string;
  kind: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | string | null;
  open_balance: number | string | null;
  closed: boolean | null;
  discount_amount: number | string | null;
  discount_by: string | null;
  job_name_raw: string | null;
  supplier_account_id: string | null;
};

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function paperOf(r: PaperRow): OpenListPaper {
  return {
    id: String(r.id),
    invoiceNumber: String(r.invoice_number ?? ""),
    kind: String(r.kind ?? "invoice"),
    invoiceDate: r.invoice_date ?? null,
    dueDate: r.due_date ?? null,
    total: num(r.total) ?? 0,
    openBalance: num(r.open_balance),
    closed: r.closed === true,
    discountAmount: num(r.discount_amount),
    discountBy: r.discount_by ?? null,
    jobNameRaw: r.job_name_raw ?? null,
    supplierAccountId: r.supplier_account_id ?? null,
  };
}

/** The org's own today, in its own timezone (never the server's). */
export async function orgToday(supabase: Db, orgId: string): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  return todayStrInTz(getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone);
}

export async function loadAccounts(supabase: Db, orgId: string): Promise<SupplierAccountLite[]> {
  // `*` so a database before 0351 still answers (open_list_columns is simply not there).
  const { data } = await supabase.from("supplier_accounts").select("*").eq("org_id", orgId).order("name").limit(500);
  return ((data ?? []) as SupplierAccountLite[]).map((a) => ({ ...a, id: String(a.id), name: String(a.name ?? "") }));
}

/**
 * Every supplier paper this org holds, for matching by number and summing by account. PAGED
 * (readAllPages, ordered by id): PostgREST cuts one select at db-max-rows and says nothing, and a
 * paper past the cut would read as new, be inserted again, and fail the whole Apply's inserts.
 */
export async function loadPapers(supabase: Db, orgId: string): Promise<{ papers: OpenListPaper[]; error: string | null }> {
  const { rows, error } = await readAllPages<PaperRow>((from, to) =>
    supabase.from("supplier_invoices").select(PAPER_COLUMNS).eq("org_id", orgId).order("id").range(from, to),
  );
  if (error) return { papers: [], error: dbError(error) };
  return { papers: rows.map(paperOf), error: null };
}

const acctKey = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/\s+/g, "");

/**
 * WHOSE LIST IS THIS. Only by identifiers the supplier printed or a person chose, never by a
 * spelling or a column layout: a person's pick; the account number the list prints, matched
 * exactly; or the papers it lists that are already here, when they are numbers long enough to be
 * one purchase on their own (isLongNumber: "1001" from two stores is two papers), at least two of
 * them, at least half the list, and every one of them on the same account.
 */
export function resolveAccount(
  list: Pick<OpenList, "accountId" | "accountFrom" | "accountNumber" | "rows"> | null,
  needs: { accountId?: string | null; accountFrom?: OpenList["accountFrom"] } | null,
  accounts: readonly SupplierAccountLite[],
  papers: readonly OpenListPaper[],
): { id: string; from: NonNullable<OpenList["accountFrom"]> } | null {
  const chosen = list?.accountId ?? needs?.accountId ?? null;
  if (chosen && accounts.some((a) => a.id === chosen)) return { id: chosen, from: (list?.accountFrom ?? needs?.accountFrom ?? "person") || "person" };
  if (!list) return null;
  const printed = acctKey(list.accountNumber);
  if (printed) {
    const hit = accounts.filter((a) => acctKey(a.account_number) === printed);
    if (hit.length === 1) return { id: hit[0].id, from: "number" };
  }
  const byKey = new Map(papers.map((p) => [referenceKey(p.invoiceNumber), p]));
  const owners = new Set<string>();
  let hits = 0;
  const listed = list.rows.filter((r) => r.kind !== "payment");
  for (const r of listed) {
    const key = referenceKey(r.reference);
    if (!isLongNumber(key)) continue;
    const p = byKey.get(key);
    if (!p?.supplierAccountId) continue;
    owners.add(p.supplierAccountId);
    hits++;
  }
  if (owners.size === 1 && hits >= 2 && hits * 2 >= listed.length) {
    const id = [...owners][0];
    if (accounts.some((a) => a.id === id)) return { id, from: "papers" };
  }
  return null;
}

/**
 * A REMEMBERED COLUMN CHOICE THAT READS THIS TABLE. It reads the columns and nothing more: whose
 * list it is still comes from the account number it prints, its papers, or a person (a column
 * layout is not an identity: two suppliers' lists can have the same width). The account a person
 * already named is tried first; then remembered header words, which may SUGGEST their account in
 * "Whose List Is This?"; then a headerless layout by its width, which suggests nothing.
 */
export function rememberedFor(
  stored: StoredOpenList,
  accounts: readonly SupplierAccountLite[],
): { list: OpenList; suggestId: string | null } | null {
  const needs = stored.needs;
  if (!needs || !Array.isArray(needs.raw)) return null;
  const width = Math.max(0, ...needs.raw.map((r) => r.length));
  const chosen = needs.accountId ?? null;
  const ordered = [...accounts].sort((a, b) => Number(b.id === chosen) - Number(a.id === chosen));
  const tryWith = (a: SupplierAccountLite, rem: RememberedColumns) => {
    const columns = columnsFromRemembered(rem, needs.header ?? [], width);
    if (!columns) return null;
    const read = readOpenListTable({
      table: needs.raw,
      // The block a PDF's crop took off rides along here too, or a remembered column set would re-read
      // the table and lose the paper's own date all over again.
      heading: needs.heading ?? [],
      from: needs.from,
      name: needs.name,
      listDate: needs.listDate,
      listDateFrom: needs.listDateFrom,
      columns,
      headerRow: needs.headerRow,
    });
    if (!read.ok) return null;
    return { ...read.list, accountId: chosen, accountFrom: chosen ? (needs.accountFrom ?? "person") : null };
  };
  for (const pass of ["header", "width"] as const) {
    for (const a of ordered) {
      const rem = a.open_list_columns as RememberedColumns | null | undefined;
      if (!rem || typeof rem !== "object") continue;
      const only: RememberedColumns = pass === "header" ? { byHeader: rem.byHeader } : { byIndex: rem.byIndex, width: rem.width };
      const list = tryWith(a, only);
      if (list) return { list, suggestId: pass === "header" && !chosen ? a.id : null };
    }
  }
  return null;
}

export type ViewContext = { accounts: SupplierAccountLite[]; papers: OpenListPaper[]; today: string; papersError: string | null };

export function viewOf(stored: StoredOpenList, ctx: ViewContext, suggestedAccountId: string | null = null): OpenListView {
  const accounts = ctx.accounts.map((a) => ({ id: a.id, name: a.name }));
  // WHAT AN APPLY ON THIS LIST ALREADY WROTE, for the card's Delete confirm: Delete runs the Undo first,
  // so on a card left on screen from before an Apply in another tab it takes those papers back.
  const appliedPapers = (stored.applied?.added?.length ?? 0) + (stored.applied?.changed?.length ?? 0);
  const base = { accounts, needs: null, plan: null, suggestedAccountId, appliedPapers } as const;
  if (!stored.list && stored.needs) {
    const n = stored.needs;
    const width = Math.max(0, ...n.raw.map((r) => r.length));
    const start = n.headerRow + 1;
    return {
      ...base,
      supplier: null,
      accountId: null,
      accountFrom: null,
      needs: { header: n.header, sample: n.raw.slice(start, start + 4), headerRow: n.headerRow, width, columns: n.columns, missing: n.missing },
      dateSaid: listDateSaid(n, ctx.today),
      problem: null,
    };
  }
  const list = stored.list;
  if (!list) return { ...base, supplier: null, accountId: null, accountFrom: null, dateSaid: "", problem: "Nothing could be read from this list." };
  const dateSaid = listDateSaid(list, ctx.today);
  if (ctx.papersError) return { ...base, supplier: null, accountId: null, accountFrom: null, dateSaid, problem: `The supplier papers couldn't be read, so nothing can be compared yet. ${ctx.papersError}` };
  const who = resolveAccount(list, null, ctx.accounts, ctx.papers);
  if (!who) {
    return {
      ...base,
      supplier: null,
      accountId: null,
      accountFrom: null,
      dateSaid,
      problem: ctx.accounts.length
        ? null
        : "There is no supplier account to check it against yet. Add the supplier under Suppliers on Bills, then come back to this list.",
    };
  }
  const account = ctx.accounts.find((a) => a.id === who.id)!;
  const plan = reconcileOpenList(list, ctx.papers, who.id);
  return {
    ...base,
    supplier: account.name,
    accountId: who.id,
    accountFrom: who.from,
    dateSaid,
    problem: null,
    plan: {
      headline: planHeadline(plan, list, account.name, ctx.today),
      discountLine: discountLine(plan),
      complete: { ok: plan.complete.ok, said: plan.complete.said, overridable: plan.complete.overridable },
      fingerprint: plan.fingerprint,
      nothing: plan.nothing,
      closeBy: plan.closeBy,
      close: plan.close,
      keepNewer: plan.keepNewer,
      keepUndated: plan.keepUndated,
      keepPartial: plan.keepPartial,
      add: plan.add.map((a) => ({ number: a.number, kind: a.row.kind, date: a.row.invoiceDate, po: a.row.po, open: a.row.openBalance })),
      update: plan.update.map((u) => ({ number: u.number, said: u.said })),
      conflicts: plan.conflicts,
      payments: plan.payments.map((p) => ({ reference: p.reference, open: p.openBalance })),
      skipped: list.skipped,
      before: plan.totals.before,
      after: plan.totals.after,
      afterNet: plan.totals.afterNet,
      firstList: !ctx.papers.some((p) => p.supplierAccountId === who.id),
    },
  };
}

/** The card for every waiting list on a page, in one read of accounts and one of papers. */
export async function openListViews(
  supabase: Db,
  orgId: string | null | undefined,
  items: readonly { id: string; status?: string | null; proposal?: unknown }[],
): Promise<Record<string, OpenListView>> {
  const waiting = items.filter((i) => (!i.status || i.status === "needs_review") && proposalOf(i).openList);
  if (!waiting.length || !orgId) return {};
  const [accounts, loaded, today] = await Promise.all([loadAccounts(supabase, orgId), loadPapers(supabase, orgId), orgToday(supabase, orgId)]);
  const ctx: ViewContext = { accounts, papers: loaded.papers, today, papersError: loaded.error };
  const out: Record<string, OpenListView> = {};
  for (const i of waiting) {
    const stored = proposalOf(i).openList as StoredOpenList;
    const remembered = rememberedFor(stored, accounts);
    out[i.id] = viewOf(remembered ? { list: remembered.list, needs: null } : stored, ctx, remembered?.suggestId ?? null);
  }
  return out;
}

// ── THE ROW A LIST BECOMES ─────────────────────────────────────────────────────────────────────

/**
 * One paper in the tray for one list, whichever door it came in by. Nothing is compared or written
 * here: the tray shows what it would change, and Apply is a person's.
 */
export async function createOpenListPaper(
  supabase: Db,
  row: {
    orgId: string;
    userId: string;
    name: string;
    stored: StoredOpenList;
    sha256: string | null;
    fileUrl: string | null;
    source: "bills_drop" | "organize";
  },
): Promise<{ id: string } | { duplicate: true } | { error: string }> {
  const list = row.stored.list;
  const total = list ? Math.round(list.rows.reduce((s, r) => s + r.openBalance, 0) * 100) / 100 : null;
  const placed = await insertPaperRow(supabase, {
    title: row.name.slice(0, 200),
    file_url: row.fileUrl as string,
    created_by: row.userId,
    content_sha256: row.sha256,
    source: row.source,
    doc_type: "statement",
    amount: total,
    item_date: list?.listDate ?? row.stored.needs?.listDate ?? null,
    kind: "job_document",
    proposal: { openList: row.stored } satisfies PaperProposal,
    confidence: "high",
  });
  if ("duplicate" in placed) return { duplicate: true };
  if ("error" in placed) return { error: dbError(placed.error) };
  return placed;
}

/** What the drop line says the moment a list lands. */
export function openListLine(stored: StoredOpenList): string {
  if (stored.list) {
    const n = stored.list.rows.length;
    return `Read as a supplier's list of ${n} open ${n === 1 ? "paper" : "papers"}. Waiting on Reconcile with what it changes; nothing changes until you press Apply.`;
  }
  return "Read as a supplier's list, but its columns need a look. Waiting on Reconcile.";
}

// ── APPLY ──────────────────────────────────────────────────────────────────────────────────────

export type ApplyResult = { ok: boolean; error?: string; message?: string; stale?: boolean };

/**
 * ONE APPLY. The plan is worked out again here from the database as it is now, and it must be the
 * plan the person saw (the fingerprint), or nothing is written and the card shows the new one.
 * The row is claimed first (needs_review → filed, in one guarded write), so two presses, or two
 * tabs, can never apply one list twice; then the papers are written, and what each write actually
 * did is kept on the row for Undo.
 */
export async function applyOpenListCore(
  supabase: Db,
  who: { orgId: string; userId: string },
  itemId: string,
  opts: { fingerprint: string; wholeList?: boolean },
): Promise<ApplyResult> {
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", itemId).eq("org_id", who.orgId).maybeSingle();
  if (!item) return { ok: false, error: "That list isn't here any more." };
  if (item.status !== "needs_review") return { ok: false, error: "This list was already applied. Undo it first to apply it again." };
  const p = proposalOf(item);
  const stored = p.openList as StoredOpenList | undefined;
  const [accounts, loaded, today] = await Promise.all([loadAccounts(supabase, who.orgId), loadPapers(supabase, who.orgId), orgToday(supabase, who.orgId)]);
  if (loaded.error) return { ok: false, error: `The supplier papers couldn't be read, so nothing was changed. ${loaded.error}` };
  let list = stored?.list ?? null;
  if (!list && stored) list = rememberedFor(stored, accounts)?.list ?? null;
  if (!list) return { ok: false, error: "Pick the columns first, so the list can be read." };
  if (opts.wholeList) list = { ...list, wholeList: true };
  const account = resolveAccount(list, null, accounts, loaded.papers);
  if (!account) return { ok: false, error: "Pick whose list this is first." };
  const accountName = accounts.find((a) => a.id === account.id)?.name ?? "The supplier";
  const plan = reconcileOpenList(list, loaded.papers, account.id);
  if (plan.fingerprint !== opts.fingerprint) {
    return { ok: false, stale: true, error: "The books changed since this card was shown, so nothing was changed. Look again: the card has the new figures." };
  }
  // A list with no figures of its own closes nothing without a person's word; one whose own figures
  // call it short writes only what it lists (the plan closes nothing), and only when there is some.
  if (!plan.complete.ok && (plan.complete.overridable || plan.nothing)) return { ok: false, error: plan.complete.said };
  const headline = planHeadline(plan, list, accountName, today);

  // CLAIM THE ROW, with what is about to be written, before anything is written.
  const applied: OpenListApplied = { at: new Date().toISOString(), by: who.userId, fingerprint: plan.fingerprint, headline, added: [], changed: [], pending: true };
  const listKept: OpenList = { ...list, accountId: account.id, accountFrom: account.from };
  const claim = (a: OpenListApplied, status: string, onlyIf?: string) => {
    let q = supabase
      .from("organized_items")
      .update({ status, vendor: accountName, proposal: { ...p, openList: { list: listKept, needs: null, applied: a }, filed: { how: "open_list" } } satisfies PaperProposal })
      .eq("id", itemId)
      .eq("org_id", who.orgId);
    if (onlyIf) q = q.eq("status", onlyIf);
    return q.select("id");
  };
  const claimed = await claim(applied, "filed", "needs_review");
  if (claimed.error) return { ok: false, error: `Nothing was changed. ${dbError(claimed.error)}` };
  if (!claimed.data?.length) return { ok: false, error: "This list was applied from another screen a moment ago. Nothing was changed twice." };

  const problems: string[] = [];

  // ADDED: every listed paper the app lacked, as this supplier's paper.
  if (plan.add.length) {
    const rows = plan.add.map(({ row }) => ({
      org_id: who.orgId,
      supplier_account_id: account.id,
      invoice_number: row.reference.slice(0, 60),
      kind: row.kind === "payment" ? "invoice" : row.kind,
      invoice_date: row.invoiceDate,
      due_date: row.dueDate,
      job_name_raw: row.po,
      total: row.amount ?? row.openBalance,
      open_balance: row.openBalance,
      closed: moneyCents(row.openBalance) === 0,
      discount_amount: row.discountAmount,
      discount_by: row.discountAmount !== null ? row.discountBy : null,
      source_file: `${accountName} list: ${list.name}`.slice(0, 300),
      created_by: who.userId,
    }));
    const { data: inserted, error } = await supabase
      .from("supplier_invoices")
      .insert(rows)
      .select("id, invoice_number, open_balance, closed, discount_amount, discount_by, due_date, supplier_account_id");
    if (error) {
      problems.push(`The ${plan.add.length} new ${plan.add.length === 1 ? "paper wasn't" : "papers weren't"} added. ${dbError(error)}`);
      reportError("bills:applyOpenList.add", error, { itemId });
    } else {
      for (const r of (inserted ?? []) as (PaperFields & { id: string; invoice_number: string })[]) {
        const wrote: PaperFields = {};
        for (const k of ADDED_FIELDS) wrote[k] = (r[k] ?? null) as never;
        applied.added.push({ id: String(r.id), number: String(r.invoice_number), wrote });
      }
      if (applied.added.length !== plan.add.length) problems.push(`Only ${applied.added.length} of the ${plan.add.length} new papers were added.`);
    }
  }

  // CLOSED: gone from the list, dated on or before it. One write; only papers still open.
  if (plan.close.length) {
    const ids = plan.close.map((c) => c.id);
    const { data: closed, error } = await supabase
      .from("supplier_invoices")
      .update({ closed: true, open_balance: 0 })
      .eq("org_id", who.orgId)
      .in("id", ids)
      .eq("closed", false)
      .select("id");
    if (error) {
      problems.push(`The papers it no longer lists weren't marked paid. ${dbError(error)}`);
      reportError("bills:applyOpenList.close", error, { itemId });
    } else {
      const done = new Set(((closed ?? []) as { id: string }[]).map((r) => String(r.id)));
      for (const c of plan.close) {
        if (!done.has(c.id)) continue;
        const was = loaded.papers.find((x) => x.id === c.id);
        applied.changed.push({ id: c.id, number: c.number, prior: { open_balance: was?.openBalance ?? null, closed: false }, wrote: { open_balance: 0, closed: true } });
      }
      if (done.size !== plan.close.length) problems.push(`${plan.close.length - done.size} of the papers to mark paid had changed since, and were left as they are.`);
    }
  }

  // CHANGED: listed papers whose balance, discount or account the list corrects.
  for (const u of plan.update) {
    const { data: wrote, error } = await supabase.from("supplier_invoices").update(u.wrote).eq("org_id", who.orgId).eq("id", u.id).select("id");
    if (error || !wrote?.length) {
      problems.push(`${u.number} wasn't changed.${error ? ` ${dbError(error)}` : ""}`);
      continue;
    }
    applied.changed.push({ id: u.id, number: u.number, prior: u.prior, wrote: u.wrote });
  }

  const done = await claim({ ...applied, pending: false }, "filed");
  if (done.error || !done.data?.length) {
    reportError("bills:applyOpenList.record", done.error ?? new Error("recording what Apply did wrote no rows"), { itemId });
    problems.push("What was changed couldn't be kept on this list, so Undo may not be able to put it back. Tell the office before changing anything else.");
  }
  const said = `Applied. ${headline}`;
  return problems.length ? { ok: true, message: `${said} But: ${problems.join(" ")}` } : { ok: true, message: said };
}

// ── UNDO ───────────────────────────────────────────────────────────────────────────────────────

/** What Apply writes on a paper it adds, and what Undo checks is still there before removing it. */
const ADDED_FIELDS = ["open_balance", "closed", "discount_amount", "discount_by", "due_date", "supplier_account_id"] as const satisfies readonly (keyof PaperFields)[];

const sameField = (key: keyof PaperFields, a: unknown, b: unknown) =>
  key === "open_balance" || key === "discount_amount"
    ? (a === null || a === undefined) === (b === null || b === undefined) && moneyCents(a as number) === moneyCents(b as number)
    : String(a ?? "") === String(b ?? "");

/**
 * PUT BACK EXACTLY WHAT APPLY REPLACED, and nothing a person did since. A changed paper is put back
 * only while it still says what Apply wrote; an added paper is removed only while nothing is tied
 * to it (a bill, a paper in the tray, its lines, a job a person set). Everything left is named.
 */
export async function undoOpenListCore(
  supabase: Db,
  orgId: string,
  applied: OpenListApplied,
): Promise<{ ok: true; left: string[] } | { ok: false; error: string }> {
  const left: string[] = [];
  const changedIds = applied.changed.map((c) => c.id);
  if (changedIds.length) {
    const { data, error } = await supabase.from("supplier_invoices").select(PAPER_COLUMNS).eq("org_id", orgId).in("id", changedIds);
    if (error) return { ok: false, error: `The papers couldn't be read, so nothing was undone. ${dbError(error)}` };
    const now = new Map(((data ?? []) as PaperRow[]).map((r) => [String(r.id), r as unknown as Record<string, unknown>]));
    for (const c of applied.changed) {
      const cur = now.get(c.id);
      if (!cur) {
        left.push(`${c.number} (it isn't here any more)`);
        continue;
      }
      const untouched = (Object.keys(c.wrote) as (keyof PaperFields)[]).every((k) => sameField(k, cur[k], c.wrote[k]));
      if (!untouched) {
        left.push(`${c.number} (it changed since)`);
        continue;
      }
      const { data: back, error: e } = await supabase.from("supplier_invoices").update(c.prior).eq("org_id", orgId).eq("id", c.id).select("id");
      if (e || !back?.length) left.push(`${c.number} (it wouldn't change back${e ? `: ${dbError(e)}` : ""})`);
    }
  }
  const addedIds = applied.added.map((a) => a.id);
  if (addedIds.length) {
    const [links, tied, lines, rows] = await Promise.all([
      supabase.from("bill_supplier_invoices").select("supplier_invoice_id").eq("org_id", orgId).in("supplier_invoice_id", addedIds),
      supabase.from("organized_items").select("tied_supplier_invoice_id").eq("org_id", orgId).in("tied_supplier_invoice_id", addedIds),
      supabase.from("supplier_invoice_lines").select("supplier_invoice_id").eq("org_id", orgId).in("supplier_invoice_id", addedIds),
      supabase.from("supplier_invoices").select(`${PAPER_COLUMNS}, job_id`).eq("org_id", orgId).in("id", addedIds),
    ]);
    const firstError = links.error ?? tied.error ?? lines.error ?? rows.error;
    if (firstError) return { ok: false, error: `The added papers couldn't be checked, so nothing more was undone. ${dbError(firstError)}` };
    const held = new Set<string>();
    for (const r of (links.data ?? []) as { supplier_invoice_id: string }[]) held.add(String(r.supplier_invoice_id));
    for (const r of (tied.data ?? []) as { tied_supplier_invoice_id: string }[]) held.add(String(r.tied_supplier_invoice_id));
    for (const r of (lines.data ?? []) as { supplier_invoice_id: string }[]) held.add(String(r.supplier_invoice_id));
    for (const r of (rows.data ?? []) as { id: string; job_id: string | null }[]) if (r.job_id) held.add(String(r.id));
    for (const a of applied.added) if (held.has(a.id)) left.push(`${a.number} (something is tied to it now)`);
    // A paper a person (or a later list) changed since Apply added it is theirs now: it stays.
    const now = new Map(((rows.data ?? []) as Record<string, unknown>[]).map((r) => [String(r.id), r]));
    for (const a of applied.added) {
      if (held.has(a.id) || !a.wrote) continue;
      const cur = now.get(a.id);
      if (!cur) continue;
      const untouched = (Object.keys(a.wrote) as (keyof PaperFields)[]).every((k) => sameField(k, cur[k], a.wrote![k]));
      if (!untouched) {
        held.add(a.id);
        left.push(`${a.number} (it changed since)`);
      }
    }
    const free = addedIds.filter((id) => !held.has(id));
    if (free.length) {
      const { data: gone, error } = await supabase.from("supplier_invoices").delete().eq("org_id", orgId).in("id", free).select("id");
      if (error) return { ok: false, error: `The added papers weren't removed. ${dbError(error)}` };
      const removed = new Set(((gone ?? []) as { id: string }[]).map((r) => String(r.id)));
      for (const a of applied.added) if (free.includes(a.id) && !removed.has(a.id)) left.push(`${a.number} (it wouldn't come off)`);
    }
  }
  return { ok: true, left };
}
