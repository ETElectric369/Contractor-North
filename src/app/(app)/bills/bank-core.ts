import "server-only";

import { createHash } from "node:crypto";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, tzDayStartUtc, tzLocalHourUtc } from "@/lib/tz";
import { proposalOf, type PaperProposal } from "@/lib/paperwork";
import { readAllPages } from "@/lib/read-all-pages";
import { invoiceBalance } from "@/lib/invoice-math";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { paymentMethodKey } from "@/lib/payment-method";
import {
  bankViewOf,
  centsOf,
  choiceId,
  groupTitle,
  inPayWindow,
  PAY_WINDOW,
  dayDiff,
  planBankDownload,
  readBankTable,
  sayRange,
  validPicks,
  type BankAppliedPass,
  type BankBooks,
  type BankChoice,
  type BankDownload,
  type BankLine,
  type BankView,
  type MatchTable,
  type StoredBank,
} from "@/lib/bank-download";
import { insertPaperRow } from "@/app/(app)/organize/paperwork-core";

/**
 * A BANK DOWNLOAD, ON THE SERVER (2026-09-27): the reads, the one Apply and its Undo. Not a
 * "use server" module: the doors are addOpenList (the drop doors already call it) and
 * bank-actions.ts, and each checks requireStaff first.
 *
 * ORG_ID ON EVERY READ AND WRITE (0173: a rule at one read path is a convention, not a boundary),
 * on top of RLS, which holds bank_lines and bank_rules to the company's staff (0363). Every write
 * comes back with .select("id"): a zero-row write is a 204, and a 204 reads exactly like success.
 *
 * BEFORE 0363 IS APPLIED nothing crashes: the download still lands in Sort These, and its card
 * says it needs one database update.
 */

type Db = any;

export const BANK_NEEDS_UPDATE = "Sorting a bank download needs one database update first. It is waiting here and nothing was changed.";

/** bank_lines / bank_rules / a bank_line_id or cost_kind column not on this database yet. */
export function isMissingBank(err: unknown): boolean {
  const code = String((err as { code?: string } | null)?.code ?? "");
  const msg = String((err as { message?: string } | null)?.message ?? "");
  if (code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204") return true;
  return /bank_lines|bank_rules|bank_line_id|cost_kind/i.test(msg) && /does not exist|could not find|schema cache/i.test(msg);
}

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** The most rows a bank download may carry (the old .xls reader's own limit, xls-read.ts). */
export const BANK_MAX_ROWS = 5000;

/** The table as the server keeps looking at it: capped, so a stray export can't bloat a request. */
export function capBankTable(table: readonly (readonly unknown[])[]): string[][] {
  return table.slice(0, BANK_MAX_ROWS).map((r) => (Array.isArray(r) ? r : []).slice(0, 30).map((c) => String(c ?? "").slice(0, 300)));
}

/** A download longer than the cap is refused whole, never cut: a bank that lists newest first
 *  would lose its oldest lines without a word. Null when it fits. */
export function bankTableTooLong(table: readonly (readonly unknown[])[], name: string): string | null {
  const rows = table.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== "")).length;
  return rows > BANK_MAX_ROWS ? `${name} has more than ${BANK_MAX_ROWS.toLocaleString("en-US")} rows. Download a shorter date range and drop that.` : null;
}

/** A table into a bank download (redacted), or null when it isn't one. */
export function readBankDownload(table: readonly (readonly unknown[])[], name: string): BankDownload | null {
  return readBankTable(capBankTable(table), name, sha256Hex);
}

async function orgTz(supabase: Db, orgId: string): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  return getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone || "America/Los_Angeles";
}

const shiftDay = (ymd: string, days: number) => {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

const chunks = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// ── THE BOOKS ──────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the plan compares a download with, for this company, around the download's own dates.
 * A failed read is a problem said on the card, never an empty table (a missing payment would read
 * as a deposit nobody recorded).
 */
export async function loadBankBooks(supabase: Db, orgId: string, dl: BankDownload, tz: string): Promise<{ books: BankBooks | null; problem: string | null }> {
  if (!dl.from || !dl.to) return { books: null, problem: "This download has no dated lines to sort." };
  const from = shiftDay(dl.from, -14);
  const to = shiftDay(dl.to, 10);
  // Crew and supplier payments reach back further: a check can be cashed weeks after it was written.
  const payFrom = shiftDay(dl.from, -PAY_WINDOW.before);
  const startIso = tzDayStartUtc(from, tz).toISOString();
  const endIso = tzDayStartUtc(shiftDay(to, 1), tz).toISOString();
  const keys = dl.lines.map((l) => l.key);

  const already = Promise.all(
    chunks(keys, 150).map((ks) => supabase.from("bank_lines").select("line_key, choice, bucket, cost_kind, amount").eq("org_id", orgId).in("line_key", ks)),
  );
  const paged = <T,>(q: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: unknown }>) => readAllPages<T>(q, 20);
  const [alreadyR, payR, crewR, supR, billR, pettyR, acctR, aliasR, invR, peopleR, ruleR, paidR] = await Promise.all([
    already,
    paged<any>((f, t) =>
      supabase
        .from("payments")
        .select("id, invoice_id, amount, paid_at, method, processor_fee, stripe_payment_intent, invoices(invoice_number, status)")
        .eq("org_id", orgId)
        .is("bank_line_id", null)
        .gte("paid_at", startIso)
        .lt("paid_at", endIso)
        .order("id")
        .range(f, t),
    ),
    paged<any>((f, t) =>
      supabase
        .from("pay_payments")
        .select("id, profile_id, amount, paid_on, reference")
        .eq("org_id", orgId)
        .is("voided_at", null)
        .is("bank_line_id", null)
        .gte("paid_on", payFrom)
        .lte("paid_on", to)
        .order("id")
        .range(f, t),
    ),
    paged<any>((f, t) =>
      supabase
        .from("supplier_payments")
        .select("id, supplier_account_id, amount, paid_on, reference")
        .eq("org_id", orgId)
        .is("voided_at", null)
        .is("bank_line_id", null)
        .gte("paid_on", payFrom)
        .lte("paid_on", to)
        .order("id")
        .range(f, t),
    ),
    paged<any>((f, t) =>
      supabase
        .from("bills")
        .select("id, amount, bill_date, supplier, job_id, category, supplier_account_id")
        .eq("org_id", orgId)
        .is("superseded_by_bill_id", null)
        .is("bank_line_id", null)
        .gte("bill_date", from)
        .lte("bill_date", to)
        .order("id")
        .range(f, t),
    ),
    paged<any>((f, t) =>
      supabase.from("petty_cash").select("id, amount, tx_date, kind").eq("org_id", orgId).is("bank_line_id", null).gte("tx_date", from).lte("tx_date", to).order("id").range(f, t),
    ),
    supabase.from("supplier_accounts").select("id, name, account_number, branch_code, on_account").eq("org_id", orgId).order("name").limit(500),
    supabase.from("supplier_aliases").select("supplier_account_id, alias").eq("org_id", orgId).limit(5000),
    supabase.from("invoices").select("id, invoice_number, total, amount_paid, status").eq("org_id", orgId).in("status", ["sent", "partial", "overdue"]).order("created_at", { ascending: false }).limit(500),
    supabase.from("profiles").select("id, full_name, role, active").eq("org_id", orgId).eq("active", true).neq("role", "owner").limit(200),
    supabase.from("bank_rules").select("id, direction, merchant_key, choice, bucket, cost_kind, supplier_account_id, profile_id").eq("org_id", orgId).limit(5000),
    supabase.from("pay_payments").select("profile_id, amount").eq("org_id", orgId).is("voided_at", null).order("paid_on", { ascending: false }).limit(2000),
  ]);

  const errors = [
    ...(alreadyR as { error: unknown }[]).map((r) => r.error),
    payR.error, crewR.error, supR.error, billR.error, pettyR.error, acctR.error, aliasR.error, invR.error, peopleR.error, ruleR.error, paidR.error,
  ].filter(Boolean);
  if (errors.length) {
    if (errors.some(isMissingBank)) return { books: null, problem: BANK_NEEDS_UPDATE };
    reportError("bills:bank.loadBooks", errors[0], { orgId });
    return { books: null, problem: `The books couldn't be read, so nothing can be sorted yet. ${dbError(errors[0] as never)}` };
  }

  const alreadyMap: BankBooks["already"] = new Map();
  for (const r of alreadyR as { data: any[] | null }[]) {
    for (const row of r.data ?? []) {
      alreadyMap.set(String(row.line_key), { choice: String(row.choice), bucket: row.bucket ?? null, costKind: row.cost_kind ?? null, amountCents: centsOf(row.amount) });
    }
  }
  const aliases = new Map<string, string[]>();
  for (const a of (aliasR.data ?? []) as { supplier_account_id: string; alias: string }[]) {
    const list = aliases.get(String(a.supplier_account_id)) ?? [];
    list.push(String(a.alias ?? ""));
    aliases.set(String(a.supplier_account_id), list);
  }
  const accounts = ((acctR.data ?? []) as any[]).map((a) => ({
    id: String(a.id),
    name: String(a.name ?? ""),
    number: a.account_number ?? null,
    branch: a.branch_code ?? null,
    onAccount: a.on_account !== false,
    aliases: aliases.get(String(a.id)) ?? [],
  }));
  const onAccount = new Set(accounts.filter((a) => a.onAccount).map((a) => a.id));
  const dayOf = (iso: string) => todayStrInTz(tz, new Date(iso));

  const books: BankBooks = {
    already: alreadyMap,
    payments: (payR.rows as any[])
      .filter((p) => p.invoices?.status !== "void")
      .map((p) => ({
        id: String(p.id),
        invoiceId: String(p.invoice_id),
        invoiceNumber: String(p.invoices?.invoice_number ?? "an invoice"),
        cents: centsOf(p.amount),
        day: dayOf(String(p.paid_at)),
        method: String(p.method ?? ""),
        feeCents: p.processor_fee === null || p.processor_fee === undefined ? null : centsOf(p.processor_fee),
        stripe: !!p.stripe_payment_intent,
      })),
    payPayments: (crewR.rows as any[]).map((p) => ({ id: String(p.id), profileId: String(p.profile_id), cents: centsOf(p.amount), day: String(p.paid_on), reference: p.reference ?? null })),
    supplierPayments: (supR.rows as any[]).map((p) => ({ id: String(p.id), accountId: String(p.supplier_account_id), cents: centsOf(p.amount), day: String(p.paid_on), reference: p.reference ?? null })),
    bills: (billR.rows as any[]).map((b) => ({
      id: String(b.id),
      cents: centsOf(b.amount),
      day: b.bill_date ?? null,
      supplier: String(b.supplier ?? ""),
      jobId: b.job_id ?? null,
      category: b.category ?? null,
      onAccount: !!b.supplier_account_id && onAccount.has(String(b.supplier_account_id)),
    })),
    pettyCash: (pettyR.rows as any[]).map((p) => ({ id: String(p.id), cents: centsOf(p.amount), day: String(p.tx_date), kind: String(p.kind ?? "") })),
    accounts,
    invoices: ((invR.data ?? []) as any[])
      .map((i) => ({ id: String(i.id), number: String(i.invoice_number ?? "Invoice"), balanceCents: centsOf(invoiceBalance(i.total, i.amount_paid)) }))
      .filter((i) => i.balanceCents > 0),
    crew: ((peopleR.data ?? []) as any[]).map((p) => ({ id: String(p.id), name: String(p.full_name ?? "").trim() || "Crew" })),
    rules: ((ruleR.data ?? []) as any[]).map((r) => ({
      id: String(r.id),
      direction: r.direction === "in" ? "in" : "out",
      key: String(r.merchant_key ?? ""),
      choice: r.choice,
      bucket: r.bucket ?? null,
      costKind: r.cost_kind ?? null,
      supplierAccountId: r.supplier_account_id ?? null,
      profileId: r.profile_id ?? null,
    })),
    crewPaid: ((paidR.data ?? []) as any[]).map((p) => ({ profileId: String(p.profile_id), cents: centsOf(p.amount) })),
  };
  return { books, problem: null };
}

/** The empty card a problem gives: the headline still reads, nothing can be pressed but Not Now. */
function problemView(dl: BankDownload, problem: string): BankView {
  const empty: BankBooks = {
    already: new Map(),
    payments: [],
    payPayments: [],
    supplierPayments: [],
    bills: [],
    pettyCash: [],
    accounts: [],
    invoices: [],
    crew: [],
    rules: [],
    crewPaid: [],
  };
  const plan = planBankDownload({ ...dl, lines: [] }, empty);
  return { ...bankViewOf({ ...dl, lines: [] }, plan, empty), problem };
}

/** The card for every waiting bank download on a page. */
export async function bankViews(
  supabase: Db,
  orgId: string | null | undefined,
  items: readonly { id: string; status?: string | null; proposal?: unknown }[],
): Promise<Record<string, BankView>> {
  const waiting = items.filter((i) => (!i.status || i.status === "needs_review") && proposalOf(i).bankImport?.download);
  if (!waiting.length || !orgId) return {};
  const tz = await orgTz(supabase, orgId);
  const today = todayStrInTz(tz);
  const out: Record<string, BankView> = {};
  for (const i of waiting) {
    const stored = proposalOf(i).bankImport as StoredBank;
    const dl = stored.download;
    const { books, problem } = await loadBankBooks(supabase, orgId, dl, tz);
    if (!books) {
      out[i.id] = problemView(dl, problem ?? "The books couldn't be read.");
      continue;
    }
    out[i.id] = bankViewOf(dl, planBankDownload(dl, books), books, { today, applied: stored.applied ?? null });
  }
  return out;
}

// ── THE ROW A DOWNLOAD BECOMES ─────────────────────────────────────────────────────────────────

export async function createBankPaper(
  supabase: Db,
  row: { userId: string; name: string; download: BankDownload; sha256: string | null; source: "bills_drop" | "organize" },
): Promise<{ id: string } | { duplicate: true } | { error: string }> {
  const dl = row.download;
  const placed = await insertPaperRow(supabase, {
    title: row.name.slice(0, 200),
    file_url: null as unknown as string,
    created_by: row.userId,
    content_sha256: row.sha256,
    source: row.source,
    doc_type: "statement",
    vendor: dl.last4 ? `Bank ••${dl.last4}` : "Bank",
    amount: null,
    item_date: dl.to,
    kind: "job_document",
    category: "Bank Download",
    proposal: { bankImport: { download: dl, applied: null } } satisfies PaperProposal,
    confidence: "high",
  });
  if ("duplicate" in placed) return { duplicate: true };
  if ("error" in placed) return { error: dbError(placed.error as never) };
  return placed;
}

/** What the drop line says the moment a download lands. */
export function bankLine(dl: BankDownload): string {
  const n = dl.lines.length;
  return `Read as a bank download: ${n} ${n === 1 ? "line" : "lines"}. Waiting below with how it sorts; nothing is written until you press Apply.`;
}

// ── APPLY ──────────────────────────────────────────────────────────────────────────────────────

export type BankApplyResult = { ok: boolean; error?: string; message?: string; stale?: boolean };

type Work = { line: BankLine; sortedBy: "match" | "rule" | "person"; choice: BankChoice | null; match?: { table: MatchTable; ids: string[] }; ruleId?: string; group?: string };

const MATCH_TABLES: MatchTable[] = ["payments", "bills", "supplier_payments", "pay_payments", "petty_cash"];

/** How a deposit put on an invoice was paid, from what the bank calls it. */
export function depositMethod(description: string): string {
  const d = description.toLowerCase();
  if (/venmo/.test(d)) return "venmo";
  if (/zelle/.test(d)) return "zelle";
  if (/stripe|square|card/.test(d)) return "card";
  if (/\bach\b|transfer|wire/.test(d)) return "transfer";
  return "check";
}

/**
 * ONE APPLY, of the card the person saw. The plan is worked out again from the books as they are
 * now and must carry the same fingerprint, or nothing is written and the card shows the new one.
 * The row is claimed first (needs_review → filed, one guarded write), so two presses or two tabs
 * never apply one download twice; each line is then written once by its key (bank_lines' UNIQUE
 * (org_id, line_key)), and each money row marked once (its UNIQUE bank_line_id).
 *
 * Rows the person left for later write nothing and stay on the card, named as not counted: the row
 * goes back to Sort These with only them.
 */
export async function applyBankCore(
  supabase: Db,
  who: { orgId: string; userId: string },
  itemId: string,
  opts: { fingerprint: string; picks: Record<string, unknown> | null | undefined },
): Promise<BankApplyResult> {
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", itemId).eq("org_id", who.orgId).maybeSingle();
  if (!item) return { ok: false, error: "That bank download isn't here any more." };
  if (item.status !== "needs_review") return { ok: false, error: "This download was already applied. Undo it first to apply it again." };
  const p = proposalOf(item);
  const stored = p.bankImport as StoredBank | undefined;
  if (!stored?.download) return { ok: false, error: "This paper isn't a bank download." };
  const dl = stored.download;
  const tz = await orgTz(supabase, who.orgId);
  const { books, problem } = await loadBankBooks(supabase, who.orgId, dl, tz);
  if (!books) return { ok: false, error: problem ?? BANK_NEEDS_UPDATE };
  const plan = planBankDownload(dl, books);
  if (plan.fingerprint !== opts.fingerprint) {
    return { ok: false, stale: true, error: "The books changed since this card was shown, so nothing was written. Look again: the card has the new sort." };
  }
  const picks = validPicks(opts.picks, plan, books);
  if (picks.refused.length) return { ok: false, error: `Nothing was written. ${picks.refused.join("; ")}.` };

  const work: Work[] = [];
  for (const line of dl.lines) {
    const d = plan.dispositions.get(line.key);
    if (!d || d.how === "already") continue;
    if (d.how === "match") work.push({ line, sortedBy: "match", choice: null, match: { table: d.table, ids: d.ids } });
    else if (d.how === "rule") work.push({ line, sortedBy: "rule", choice: d.choice, ruleId: d.ruleId });
    else {
      const c = picks.ok.get(d.group);
      if (c) work.push({ line, sortedBy: "person", choice: c, group: d.group });
    }
  }
  if (!work.length) return { ok: false, error: "Nothing to apply yet: answer a row first, or press Not Now." };

  // CREW PAY ALREADY RECORDED: a person's "Pay Pat" on a line whose \$800 to Pat is already in North
  // (recorded after the bank posted it, or a check cashed late, and no bank line on it yet) MARKS
  // that payment. Writing another would pay Pat twice.
  const taken = new Set<string>();
  let crewMarked = 0;
  for (const d of plan.dispositions.values()) if (d.how === "match") for (const id of d.ids) taken.add(id);
  for (const w of work) {
    if (w.sortedBy !== "person" || w.choice?.choice !== "crew") continue;
    const who = w.choice.profileId;
    const recorded = books.payPayments
      .filter((pp) => !taken.has(pp.id) && pp.profileId === who && pp.cents === -w.line.cents && inPayWindow(w.line.postedOn, pp.day))
      .sort((a, b) => Math.abs(dayDiff(w.line.postedOn, a.day)) - Math.abs(dayDiff(w.line.postedOn, b.day)) || a.id.localeCompare(b.id))[0];
    if (!recorded) continue;
    taken.add(recorded.id);
    w.match = { table: "pay_payments", ids: [recorded.id] };
    w.choice = null;
    crewMarked++;
  }

  // CLAIM THE ROW before anything is written.
  const claimed = await supabase
    .from("organized_items")
    .update({ status: "filed", proposal: { ...p, bankImport: { ...stored, pending: new Date().toISOString() }, filed: { how: "bank_download" } } satisfies PaperProposal })
    .eq("id", itemId)
    .eq("org_id", who.orgId)
    .eq("status", "needs_review")
    .select("id");
  if (claimed.error) return { ok: false, error: `Nothing was written. ${dbError(claimed.error)}` };
  if (!claimed.data?.length) return { ok: false, error: "This download was applied from another screen a moment ago. Nothing was written twice." };

  const problems: string[] = [];

  // 1. THE LINES, each once for this company. A key already there was written a moment ago by
  //    another download or tab: it is skipped, never written twice.
  const lineRows = work.map((w) => {
    const c = w.choice;
    return {
      org_id: who.orgId,
      import_id: itemId,
      line_key: w.line.key,
      account_last4: w.line.last4,
      posted_on: w.line.postedOn,
      amount: w.line.cents / 100,
      description: w.line.description,
      check_number: w.line.check,
      merchant_key: w.line.merchantKey,
      choice: c ? c.choice : "matched",
      bucket: c?.choice === "cost" ? c.bucket : null,
      cost_kind: c?.choice === "cost" ? c.costKind : null,
      supplier_account_id: c?.choice === "supplier" ? c.supplierAccountId : null,
      profile_id: c?.choice === "crew" ? c.profileId : null,
      invoice_id: c?.choice === "invoice" ? c.invoiceId : null,
      sorted_by: w.sortedBy,
      created_by: who.userId,
    };
  });
  const lineId = new Map<string, string>();
  for (const part of chunks(lineRows, 200)) {
    const { data, error } = await supabase.from("bank_lines").upsert(part, { onConflict: "org_id,line_key", ignoreDuplicates: true }).select("id, line_key");
    if (error) {
      problems.push(isMissingBank(error) ? BANK_NEEDS_UPDATE : `${part.length} lines weren't written. ${dbError(error)}`);
      if (!isMissingBank(error)) reportError("bills:bank.apply.lines", error, { itemId });
      continue;
    }
    for (const r of (data ?? []) as { id: string; line_key: string }[]) lineId.set(String(r.line_key), String(r.id));
  }
  const skippedTwice = work.filter((w) => !lineId.has(w.line.key)).length;
  if (skippedTwice && !problems.length) problems.push(`${skippedTwice} ${skippedTwice === 1 ? "line was" : "lines were"} already counted by another download a moment ago, and ${skippedTwice === 1 ? "was" : "were"} left alone.`);

  /** A line whose money row didn't land comes off again, so the next look asks about it. */
  const unwrite = async (keys: string[], why: string) => {
    const ids = keys.map((k) => lineId.get(k)).filter((x): x is string => !!x);
    for (const k of keys) lineId.delete(k);
    if (!ids.length) return;
    const { error } = await supabase.from("bank_lines").delete().eq("org_id", who.orgId).in("id", ids).select("id");
    if (error) reportError("bills:bank.apply.unwrite", error, { itemId });
    problems.push(why);
  };

  // 2. MATCHES: the row already there gets the line's mark, once.
  for (const table of MATCH_TABLES) {
    for (const w of work.filter((x) => x.match?.table === table && lineId.has(x.line.key))) {
      const id = lineId.get(w.line.key)!;
      const { data, error } = await supabase.from(table).update({ bank_line_id: id }).eq("org_id", who.orgId).in("id", w.match!.ids).is("bank_line_id", null).select("id");
      const got = ((data ?? []) as { id: string }[]).map((r) => String(r.id));
      if (error || got.length !== w.match!.ids.length) {
        if (got.length) await supabase.from(table).update({ bank_line_id: null }).eq("org_id", who.orgId).in("id", got).eq("bank_line_id", id).select("id");
        await unwrite([w.line.key], `${w.line.description} (${w.line.postedOn}) wasn't matched: what it matched changed a moment ago.${error ? ` ${dbError(error)}` : ""}`);
      }
    }
  }

  // 3. WHAT THE ANSWERS WRITE.
  const today = todayStrInTz(tz);
  // The file's name never rides on a money row: only which account and which days.
  const note = `From the bank download${dl.last4 ? ` (••${dl.last4})` : ""} of ${sayRange(dl.from, dl.to)}.`;
  const written = (w: Work) => lineId.has(w.line.key);
  const costs = work.filter((w) => written(w) && w.choice?.choice === "cost");
  if (costs.length) {
    const rows = costs.map((w) => {
      const c = w.choice as Extract<BankChoice, { choice: "cost" }>;
      return {
        org_id: who.orgId,
        job_id: null,
        supplier: w.line.description.slice(0, 120),
        bill_number: w.line.check ? `Check ${w.line.check}` : null,
        amount: -w.line.cents / 100,
        status: "paid",
        bill_date: w.line.postedOn,
        notes: note,
        category: c.bucket,
        cost_kind: c.costKind,
        bank_line_id: lineId.get(w.line.key),
        created_by: who.userId,
      };
    });
    for (const part of chunks(rows, 200)) {
      const { data, error } = await supabase.from("bills").insert(part).select("id, bank_line_id");
      const got = new Set(((data ?? []) as { bank_line_id: string }[]).map((r) => String(r.bank_line_id)));
      const missed = costs.filter((w) => part.some((r) => r.bank_line_id === lineId.get(w.line.key)) && !got.has(String(lineId.get(w.line.key))));
      if (error || missed.length) {
        if (error) reportError("bills:bank.apply.bills", error, { itemId });
        await unwrite(missed.map((w) => w.line.key), `${missed.length} business ${missed.length === 1 ? "cost wasn't" : "costs weren't"} written${error ? `: ${dbError(error)}` : "."}`);
      }
    }
  }

  for (const w of work.filter((x) => written(x) && x.choice?.choice === "petty_cash")) {
    const { data, error } = await supabase
      .from("petty_cash")
      .insert({ org_id: who.orgId, tx_date: w.line.postedOn, kind: "replenish", amount: -w.line.cents / 100, description: `ATM withdrawal. ${note}`.slice(0, 300), job_id: null, created_by: who.userId, bank_line_id: lineId.get(w.line.key) })
      .select("id");
    if (error || !data?.length) await unwrite([w.line.key], `The petty cash top-up of ${w.line.postedOn} wasn't written.${error ? ` ${dbError(error)}` : ""}`);
  }

  for (const w of work.filter((x) => written(x) && x.choice?.choice === "supplier")) {
    const c = w.choice as Extract<BankChoice, { choice: "supplier" }>;
    const { data, error } = await supabase
      .from("supplier_payments")
      .insert({
        org_id: who.orgId,
        supplier_account_id: c.supplierAccountId,
        amount: -w.line.cents / 100,
        paid_on: w.line.postedOn,
        method: w.line.check ? "check" : "transfer",
        reference: w.line.check,
        note,
        created_by: who.userId,
        bank_line_id: lineId.get(w.line.key),
      })
      .select("id");
    if (error || !data?.length) await unwrite([w.line.key], `The supplier payment of ${w.line.postedOn} wasn't written.${error ? ` ${dbError(error)}` : ""}`);
  }

  for (const w of work.filter((x) => written(x) && x.choice?.choice === "crew")) {
    const c = w.choice as Extract<BankChoice, { choice: "crew" }>;
    const { data, error } = await supabase
      .from("pay_payments")
      .insert({
        org_id: who.orgId,
        profile_id: c.profileId,
        amount: -w.line.cents / 100,
        paid_on: w.line.postedOn,
        method: w.line.check ? "check" : "transfer",
        reference: w.line.check,
        note,
        created_by: who.userId,
        bank_line_id: lineId.get(w.line.key),
      })
      .select("id");
    // 0286 refuses a crew payment to an owner, in its own words.
    if (error || !data?.length) await unwrite([w.line.key], `The crew payment of ${w.line.postedOn} wasn't written.${error ? ` ${dbError(error)}` : ""}`);
  }

  const touchedInvoices = new Set<string>();
  for (const w of work.filter((x) => written(x) && x.choice?.choice === "invoice")) {
    const c = w.choice as Extract<BankChoice, { choice: "invoice" }>;
    // THE recordPayment GUARDS: this company's invoice, open, and never more than its balance.
    const { data: inv } = await supabase.from("invoices").select("id, invoice_number, total, amount_paid, status").eq("id", c.invoiceId).eq("org_id", who.orgId).maybeSingle();
    const cap = inv ? invoiceBalance(inv.total, inv.amount_paid) : 0;
    const amount = w.line.cents / 100;
    if (!inv || inv.status === "void" || inv.status === "draft" || amount > cap + 0.005) {
      await unwrite([w.line.key], `The deposit of ${w.line.postedOn} wasn't put on ${inv?.invoice_number ?? "that invoice"}: it is more than what is open on it.`);
      continue;
    }
    const paidAt = w.line.postedOn <= today ? tzLocalHourUtc(w.line.postedOn, 12, tz).toISOString() : undefined;
    const { data, error } = await supabase
      .from("payments")
      .insert({
        org_id: who.orgId,
        invoice_id: c.invoiceId,
        amount,
        method: paymentMethodKey(depositMethod(w.line.description)),
        note: `Deposit of ${w.line.postedOn}. ${note}`.slice(0, 300),
        recorded_by: who.userId,
        bank_line_id: lineId.get(w.line.key),
        ...(paidAt ? { paid_at: paidAt } : {}),
      })
      .select("id");
    if (error || !data?.length) {
      await unwrite([w.line.key], `The deposit of ${w.line.postedOn} wasn't put on ${inv.invoice_number}.${error ? ` ${dbError(error)}` : ""}`);
      continue;
    }
    touchedInvoices.add(c.invoiceId);
  }
  for (const id of touchedInvoices) {
    const ok = await recalcInvoice(supabase, id);
    if (!ok) problems.push("An invoice's balance didn't recompute; open it once to refresh it.");
  }

  // 4. THE COMPANY'S OWN RULES, from what a person tapped (one per merchant; an answer already
  //    remembered for that merchant stays as it was).
  const learned = new Map<string, { direction: "in" | "out"; key: string; c: BankChoice }>();
  const groupsById = new Map(plan.groups.map((g) => [g.id, g]));
  for (const w of work) {
    // Never an invoice (one deposit, one invoice) and never Other Income (0363: money in is a
    // customer's until a person says otherwise, every time).
    if (w.sortedBy !== "person" || !w.group || !written(w) || !w.choice || w.choice.choice === "invoice" || w.choice.choice === "other_income") continue;
    const g = groupsById.get(w.group);
    if (!g?.learnable || g.merchantKey.length < 2) continue;
    learned.set(`${g.direction}:${g.merchantKey}`, { direction: g.direction, key: g.merchantKey, c: w.choice });
  }
  if (learned.size) {
    const rows = [...learned.values()].map(({ direction, key, c }) => ({
      org_id: who.orgId,
      direction,
      merchant_key: key,
      choice: c.choice,
      bucket: c.choice === "cost" ? c.bucket : null,
      cost_kind: c.choice === "cost" ? c.costKind : null,
      supplier_account_id: c.choice === "supplier" ? c.supplierAccountId : null,
      profile_id: c.choice === "crew" ? c.profileId : null,
      learned_import_id: itemId,
      created_by: who.userId,
    }));
    const { error } = await supabase.from("bank_rules").upsert(rows, { onConflict: "org_id,direction,merchant_key", ignoreDuplicates: true }).select("id");
    if (error) {
      reportError("bills:bank.apply.rules", error, { itemId });
      problems.push("Your answers weren't remembered for next time, so the next download may ask again.");
    }
  }
  // Each rule that sorted a line counts the use (best effort: a count, not money).
  const uses = new Map<string, number>();
  for (const w of work) if (w.ruleId && written(w)) uses.set(w.ruleId, (uses.get(w.ruleId) ?? 0) + 1);
  if (uses.size) {
    const { data: now } = await supabase.from("bank_rules").select("id, uses").eq("org_id", who.orgId).in("id", [...uses.keys()]);
    for (const r of (now ?? []) as { id: string; uses: number }[]) {
      await supabase.from("bank_rules").update({ uses: (Number(r.uses) || 0) + (uses.get(String(r.id)) ?? 0), updated_at: new Date().toISOString() }).eq("id", r.id).eq("org_id", who.orgId).select("id");
    }
  }

  // 5. RELEASE THE CLAIM: rows left for later wait on the card again.
  const wrote = work.filter(written);
  const pickedGroups = new Set(work.filter((w) => w.sortedBy === "person" && written(w)).map((w) => w.group));
  const leftLines = plan.groups.filter((g) => !pickedGroups.has(g.id)).reduce((n, g) => n + g.keys.length, 0);
  const pass: BankAppliedPass = {
    at: new Date().toISOString(),
    by: who.userId,
    fingerprint: plan.fingerprint,
    lines: wrote.length,
    matched: wrote.filter((w) => w.sortedBy === "match").length,
    ruled: wrote.filter((w) => w.sortedBy === "rule").length,
    picked: wrote.filter((w) => w.sortedBy === "person").length,
    left: leftLines,
  };
  // A line that didn't land (a problem above) is asked again too: it is not in bank_lines.
  const notLanded = work.length - wrote.length;
  const status = leftLines + notLanded > 0 ? "needs_review" : "filed";
  const done = await supabase
    .from("organized_items")
    .update({
      status,
      proposal: {
        ...p,
        bankImport: { download: dl, applied: [...(stored.applied ?? []), pass], pending: null },
        filed: { how: "bank_download" },
      } satisfies PaperProposal,
    })
    .eq("id", itemId)
    .eq("org_id", who.orgId)
    .select("id");
  if (done.error || !done.data?.length) {
    reportError("bills:bank.apply.record", done.error ?? new Error("recording what Apply did wrote no rows"), { itemId });
    problems.push("What was written couldn't be kept on this card. Its lines are counted; Undo still finds them by this download.");
  }

  const said =
    `Applied: ${wrote.length} ${wrote.length === 1 ? "line" : "lines"} counted` +
    (pass.matched ? `, ${pass.matched} matched to what was already here` : "") +
    (pass.ruled ? `, ${pass.ruled} by your rules` : "") +
    (pass.picked ? `, ${pass.picked} you answered` : "") +
    "." +
    (crewMarked ? ` ${crewMarked === 1 ? "1 crew payment was" : `${crewMarked} crew payments were`} already recorded, so ${crewMarked === 1 ? "it was" : "they were"} marked, never written twice.` : "") +
    (leftLines ? ` ${leftLines} left for later ${leftLines === 1 ? "is" : "are"} not counted yet and wait${leftLines === 1 ? "s" : ""} on the card.` : "");
  return problems.length ? { ok: true, message: `${said} But: ${problems.join(" ")}` } : { ok: true, message: said };
}

// ── UNDO ───────────────────────────────────────────────────────────────────────────────────────

type LineRow = { id: string; choice: string; amount: number | string; bucket: string | null; invoice_id: string | null; posted_on: string; description: string };

/**
 * TAKE A WHOLE DOWNLOAD BACK: only what it wrote, and only what nobody has changed since.
 *   · a bill it wrote is deleted while it is still that business cost (0278 still refuses one an
 *     invoice bills); a payment it put on an invoice is deleted and the invoice recomputed;
 *   · a supplier or crew payment it wrote is voided (never deleted: the undo-trail law);
 *   · a petty cash top-up it wrote is deleted;
 *   · a row it only MATCHED keeps everything and loses the mark;
 *   · the rules it learned come off, and its lines are deleted (every mark with them, ON DELETE SET
 *     NULL). A line whose row stays (changed since, or refused) stays counted, and is named.
 */
export async function undoBankCore(supabase: Db, orgId: string, userId: string, importId: string): Promise<{ ok: true; left: string[]; undone: number } | { ok: false; error: string }> {
  const read = await readAllPages<LineRow>(
    (f, t) => supabase.from("bank_lines").select("id, choice, amount, bucket, invoice_id, posted_on, description").eq("org_id", orgId).eq("import_id", importId).order("id").range(f, t),
    20,
  );
  if (read.error) return { ok: false, error: isMissingBank(read.error) ? BANK_NEEDS_UPDATE : `The download's lines couldn't be read, so nothing was undone. ${dbError(read.error as never)}` };
  const lines = read.rows;
  const byId = new Map(lines.map((l) => [String(l.id), l]));
  const keep = new Set<string>();
  const left: string[] = [];
  const say = (l: LineRow, why: string) => left.push(`${l.description} ${l.posted_on} (${why})`);
  const ids = lines.map((l) => String(l.id));
  const recalc = new Set<string>();

  for (const table of MATCH_TABLES) {
    const cols =
      table === "bills" ? "id, bank_line_id, amount, job_id, category" : table === "payments" ? "id, bank_line_id, amount, invoice_id" : table === "petty_cash" ? "id, bank_line_id, amount, kind" : "id, bank_line_id, amount, voided_at";
    for (const part of chunks(ids, 150)) {
      const { data, error } = await supabase.from(table).select(cols).eq("org_id", orgId).in("bank_line_id", part);
      if (error) return { ok: false, error: `${table.replace(/_/g, " ")} couldn't be read, so the rest wasn't undone. ${dbError(error)}` };
      for (const row of (data ?? []) as any[]) {
        const l = byId.get(String(row.bank_line_id));
        if (!l) continue;
        const cents = Math.abs(centsOf(l.amount));
        if (l.choice === "matched") {
          const { error: e } = await supabase.from(table).update({ bank_line_id: null }).eq("org_id", orgId).eq("id", row.id).select("id");
          if (e) {
            keep.add(l.id);
            say(l, `its mark wouldn't come off: ${dbError(e)}`);
          }
          continue;
        }
        if (table === "bills") {
          const untouched = !row.job_id && centsOf(row.amount) === cents && String(row.category ?? "") === String(l.bucket ?? "");
          if (!untouched) {
            keep.add(l.id);
            say(l, "its bill was changed since, so it stays");
            continue;
          }
          const { data: gone, error: e } = await supabase.from("bills").delete().eq("org_id", orgId).eq("id", row.id).select("id");
          if (e || !gone?.length) {
            keep.add(l.id);
            say(l, e ? dbError(e) : "its bill wouldn't come off");
          }
        } else if (table === "payments") {
          if (centsOf(row.amount) !== cents || String(row.invoice_id) !== String(l.invoice_id)) {
            keep.add(l.id);
            say(l, "its payment was changed since, so it stays");
            continue;
          }
          const { data: gone, error: e } = await supabase.from("payments").delete().eq("org_id", orgId).eq("id", row.id).select("id");
          if (e || !gone?.length) {
            keep.add(l.id);
            say(l, e ? dbError(e) : "its payment wouldn't come off");
          } else recalc.add(String(row.invoice_id));
        } else if (table === "petty_cash") {
          const { data: gone, error: e } = await supabase.from("petty_cash").delete().eq("org_id", orgId).eq("id", row.id).select("id");
          if (e || !gone?.length) {
            keep.add(l.id);
            say(l, e ? dbError(e) : "its petty cash row wouldn't come off");
          }
        } else {
          if (row.voided_at) continue;
          const patch = table === "pay_payments" ? { voided_at: new Date().toISOString(), voided_by: userId } : { voided_at: new Date().toISOString() };
          const { data: v, error: e } = await supabase.from(table).update(patch).eq("org_id", orgId).eq("id", row.id).is("voided_at", null).select("id");
          if (e || !v?.length) {
            keep.add(l.id);
            say(l, e ? dbError(e) : "its payment wouldn't void");
          }
        }
      }
    }
  }
  for (const id of recalc) await recalcInvoice(supabase, id);

  const { error: ruleErr } = await supabase.from("bank_rules").delete().eq("org_id", orgId).eq("learned_import_id", importId).select("id");
  if (ruleErr) left.push(`the answers it remembered (${dbError(ruleErr)})`);

  const drop = ids.filter((id) => !keep.has(id));
  let undone = 0;
  for (const part of chunks(drop, 150)) {
    const { data, error } = await supabase.from("bank_lines").delete().eq("org_id", orgId).in("id", part).select("id");
    if (error) return { ok: false, error: `Some of the download's lines couldn't come off. ${dbError(error)}` };
    undone += (data ?? []).length;
  }
  return { ok: true, left, undone };
}

/** The tray row after an Undo: waiting again, with no passes. */
export function proposalAfterUndo(p: PaperProposal): PaperProposal {
  const stored = p.bankImport as StoredBank | undefined;
  return { ...p, filed: null, ...(stored ? { bankImport: { download: stored.download, applied: null, pending: null } } : {}) };
}

export { choiceId, groupTitle };
