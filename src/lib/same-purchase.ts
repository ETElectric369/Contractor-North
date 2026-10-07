/**
 * IS THIS PURCHASE ALREADY ON THE BOOKS? ONE ANSWER FOR EVERY DOOR (audit v994, DB1).
 *
 * One purchase became two bills because the question was asked at one door only. The tray's File
 * It compared the printed number against `bills.bill_number`; the supplier side (Record It As A
 * Bill, the /bills coverage count) compared it against `bills.supplier_invoice_number`; the job
 * page's Record as Cost asked nothing at all. A CED ticket filed from the tray as bill_number
 * 8802-1109000 was invisible to CED's own PDF of 8802-1109000 a week later, and one press wrote a
 * second $400 bill onto the same job, which Import Costs then billed to the customer again.
 *
 * So this module is the one reading, pure, and every door calls it:
 *
 *   · billsCarryingNumber: a LIVE bill (never a set-aside copy, 0271) that carries this printed
 *     number in EITHER column, from the same supplier. Certain: the same number on the same
 *     account is the same purchase.
 *   · samePurchaseCandidates: CED's counter ticket carries a sales-order number (8802-SO-257555)
 *     that never appears on the invoice CED issues for it later (8802-11xxxxx). No number can join
 *     them, so the supplier's document is offered the bills on that account, on that job, that no
 *     supplier document covers yet, within a few dollars and days. A SUGGESTION: the app offers
 *     "Same Purchase: Tie Them", a person decides, and nothing here ties anything.
 */

import { accountForSupplier, aliasKey, readBillInvoice, type SupplierAliasIndex } from "@/lib/supplier-identity";

/** "#8802-1108330 ", "no. 8802 1108330" and "8802-1108330" are the same printed number. */
export function normalizeDocNumber(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/^\s*(?:NO\.?|NUMBER|INV(?:OICE)?\.?|#)\s*/g, "")
    .replace(/[^A-Z0-9]+/g, "");
}

/** A number long enough to be one purchase on its own: "1234" from two stores is two purchases,
 *  "8802-1108330" is not. */
export function isLongNumber(normalized: string): boolean {
  return normalized.replace(/\D/g, "").length >= 7;
}

/**
 * The same supplier, by account first (an exact alias a person made, 0270), else by the exact
 * spelling. Never the fuzzy key: that one is for suggesting accounts, and this one decides which
 * button shows.
 */
export function sameSupplier(
  a: { name: string | null | undefined; account: string | null | undefined },
  b: { name: string | null | undefined; account: string | null | undefined },
  aliases: SupplierAliasIndex | null,
): boolean {
  const aAcct = a.account || accountForSupplier(a.name, aliases);
  const bAcct = b.account || accountForSupplier(b.name, aliases);
  if (aAcct && bAcct) return aAcct === bAcct;
  const ak = aliasKey(a.name);
  return !!ak && ak === aliasKey(b.name);
}

/** A bill, as far as "is this purchase already here?" needs it. */
export type LedgerBill = {
  id: string;
  supplier: string | null;
  supplier_account_id?: string | null;
  bill_number: string | null;
  supplier_invoice_number?: string | null;
  amount: number | string | null;
  bill_date: string | null;
  job_id?: string | null;
  /** 0271: a set-aside copy. Every cost reader ignores it, and so does this. */
  superseded_by_bill_id?: string | null;
  is_statement?: boolean | null;
  jobs?: { job_number?: string | null; name?: string | null } | null;
  /** The supplier invoice numbers the bill's own notes or lines name (readBillInvoice), filled by
   *  the caller that read them. A scanned statement names several. */
  named_numbers?: string[] | null;
  /**
   * 0381: this bill CORRECTS an earlier one (the supplier's later paper for the same purchase, filed
   * as its own bill under it). An original and the corrections under it are ONE PURCHASE here: a
   * number on any member finds them all, a document covering any member covers them all, and they
   * are offered once, as the original, at the together total. Every reader that feeds this type
   * selects the column (same-purchase-readers.test.ts holds them to it).
   */
  corrects_bill_id?: string | null;
};

/**
 * ONE PURCHASE: a bill and the corrections attached under it (0381), original first. A bill that
 * carries no correction is a purchase of one. The J-011 shape: 8802-SO-257899 ($613.19) corrected
 * by 8802-1109100 ($95.99) is one purchase, $709.18, and CED's own copy of 8802-1109100 is that
 * purchase's paper, never "$95.99 on the books" with the $613.19 ticket still uncovered.
 */
export type Purchase = {
  original: LedgerBill;
  corrections: LedgerBill[];
  /** The original and its corrections, original first. */
  members: LedgerBill[];
  /** What the purchase comes to: the original and every correction, summed in cents. */
  amount: number;
};

const cents = (v: unknown): number => Math.round((Number(v) || 0) * 100);

/**
 * THE PURCHASES IN A LIST OF BILLS, and which purchase each bill belongs to. Live bills only (a
 * set-aside copy is in nobody's books). A correction whose original is NOT in the list stands as a
 * purchase of its own rather than vanishing: a list cut short must never hide a cost.
 */
export function purchasesOf(bills: readonly LedgerBill[]): { purchases: Purchase[]; of: Map<string, Purchase> } {
  const live = bills.filter(isLive);
  const byId = new Map(live.map((b) => [b.id, b] as const));
  const under = new Map<string, LedgerBill[]>();
  const originals: LedgerBill[] = [];
  for (const b of live) {
    const of = String(b.corrects_bill_id ?? "");
    if (of && of !== b.id && byId.has(of)) under.set(of, [...(under.get(of) ?? []), b]);
    else originals.push(b);
  }
  const purchases: Purchase[] = [];
  const of = new Map<string, Purchase>();
  for (const original of originals) {
    const corrections = under.get(original.id) ?? [];
    const members = [original, ...corrections];
    const p: Purchase = { original, corrections, members, amount: members.reduce((s, m) => s + cents(m.amount), 0) / 100 };
    purchases.push(p);
    for (const m of members) of.set(m.id, p);
  }
  return { purchases, of };
}

/** The purchase one bill is part of; the bill alone when `bills` does not hold it. */
export function purchaseOf(bill: LedgerBill, bills: readonly LedgerBill[]): Purchase {
  return purchasesOf(bills).of.get(bill.id) ?? { original: bill, corrections: [], members: [bill], amount: Number(bill.amount) || 0 };
}

/** Hits grown to whole purchases: a number on any member finds them all, original first, each once. */
function wholePurchases(hits: readonly LedgerBill[], bills: readonly LedgerBill[], except?: string | null): LedgerBill[] {
  if (!hits.length) return [];
  const { of } = purchasesOf(bills);
  const out: LedgerBill[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    for (const m of of.get(h.id)?.members ?? [h]) {
      if (seen.has(m.id) || m.id === except) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

/** The numbers a bill's own paper names, read the way the /bills page reads them. */
export function namedNumbersOf(b: { notes?: string | null; bill_line_items?: { description?: string | null }[] | null; line_items?: { description?: string | null }[] | null }): {
  numbers: string[];
  isStatement: boolean;
} {
  const lines = (b.bill_line_items ?? b.line_items ?? []) as { description?: string | null }[];
  const reading = readBillInvoice({ notes: b.notes ?? null, lineDescriptions: lines.map((l) => l?.description ?? null) });
  return { numbers: reading.numbers ?? [], isStatement: reading.isStatement };
}

const isLive = (b: LedgerBill) => !b.superseded_by_bill_id;

/**
 * EVERY LIVE BILL THAT ALREADY CARRIES THIS NUMBER, from the same supplier: in bill_number (what
 * the tray and the job page write), in supplier_invoice_number (what Record It As A Bill writes),
 * or named on its own lines or file name (a scanned statement).
 *
 * CERTAIN ONLY: the same account, or the exact same spelling. This answer hides doors (File It
 * refuses, /bills counts the document covered and drops it from Purchases Not In Your Books), so
 * it never leans on a number alone. A long number under ANOTHER spelling is a WARNING, never this
 * (Erik, audit v994 DB5): billsMaybeCarryingNumber for a supplier's document, and
 * billsCarryingLongNumberElsewhere for a paper in the tray.
 */
export function billsCarryingNumber(
  number: string | null | undefined,
  who: { accountId?: string | null; supplier?: string | null },
  bills: readonly LedgerBill[],
  aliases: SupplierAliasIndex | null = null,
  opts: { exceptBillId?: string | null } = {},
): LedgerBill[] {
  const n = normalizeDocNumber(number);
  if (!n) return [];
  const out: LedgerBill[] = [];
  for (const b of bills) {
    if (!isLive(b) || b.id === opts.exceptBillId) continue;
    const carries =
      normalizeDocNumber(b.bill_number) === n ||
      normalizeDocNumber(b.supplier_invoice_number) === n ||
      (b.named_numbers ?? []).some((x) => normalizeDocNumber(x) === n);
    if (!carries) continue;
    // Both on accounts: the accounts decide. Otherwise the exact spelling. "Home Depot" and CED's
    // 8802-1108330 are two purchases.
    if (sameSupplier({ name: who.supplier ?? null, account: who.accountId ?? null }, { name: b.supplier, account: b.supplier_account_id ?? null }, aliases))
      out.push(b);
  }
  // ONE PURCHASE (0381): the number on a correction finds its original too, and the other way round.
  return wholePurchases(out, bills, opts.exceptBillId);
}

/**
 * THE SAME LONG NUMBER UNDER ANOTHER SPELLING: a live bill whose supplier is on no account yet (an
 * unfiled spelling, "CED Truckee counter"), carrying this number of 7+ digits, that
 * billsCarryingNumber did not already find. Maybe the same purchase, never certain (audit v994,
 * DB5 is Erik's call): offered for a person to tie or pass over, never counted as covering
 * anything and never a refusal.
 */
export function billsMaybeCarryingNumber(
  number: string | null | undefined,
  who: { accountId?: string | null; supplier?: string | null },
  bills: readonly LedgerBill[],
  aliases: SupplierAliasIndex | null = null,
): LedgerBill[] {
  const n = normalizeDocNumber(number);
  if (!n || !isLongNumber(n)) return [];
  const certain = new Set(billsCarryingNumber(number, who, bills, aliases).map((b) => b.id));
  const hits = bills.filter(
    (b) =>
      isLive(b) &&
      !certain.has(b.id) &&
      !(b.supplier_account_id || accountForSupplier(b.supplier, aliases)) &&
      (normalizeDocNumber(b.bill_number) === n ||
        normalizeDocNumber(b.supplier_invoice_number) === n ||
        (b.named_numbers ?? []).some((x) => normalizeDocNumber(x) === n)),
  );
  return wholePurchases(hits, bills);
}

/**
 * THE SAME LONG NUMBER, THE SUPPLIER SPELLED ANOTHER WAY (Erik, audit v994 DB5: "a long supplier
 * number matches even when the supplier name is spelled differently, as a WARNING only").
 *
 * The reader wrote "Consolidated Electrical Distributors (CED)" on a rephotographed ticket, a
 * spelling no CED alias holds, and the ticket already on the books under "Consolidated Electrical
 * Dist." on the CED account was never found: File It wrote a second bill with the same number. A
 * number of 7+ digits is one purchase whoever spelled the store, so every live bill carrying it
 * that billsCarryingNumber did not already find is returned here, EXCEPT when both sides sit on
 * supplier accounts and the accounts differ: two accounts a person set up are two suppliers.
 *
 * Only ever a warning: File It is not refused by it, nothing is tied by it, and it never decides
 * which account a bill is written on. A person looks and decides.
 */
export function billsCarryingLongNumberElsewhere(
  number: string | null | undefined,
  who: { accountId?: string | null; supplier?: string | null },
  bills: readonly LedgerBill[],
  aliases: SupplierAliasIndex | null = null,
  opts: { exceptBillId?: string | null } = {},
): LedgerBill[] {
  const n = normalizeDocNumber(number);
  if (!n || !isLongNumber(n)) return [];
  const certain = new Set(billsCarryingNumber(number, who, bills, aliases, opts).map((b) => b.id));
  const mine = who.accountId || accountForSupplier(who.supplier, aliases);
  const hits = bills.filter((b) => {
    if (!isLive(b) || b.id === opts.exceptBillId || certain.has(b.id)) return false;
    const carries =
      normalizeDocNumber(b.bill_number) === n ||
      normalizeDocNumber(b.supplier_invoice_number) === n ||
      (b.named_numbers ?? []).some((x) => normalizeDocNumber(x) === n);
    if (!carries) return false;
    const theirs = b.supplier_account_id || accountForSupplier(b.supplier, aliases);
    return !(mine && theirs && mine !== theirs);
  });
  return wholePurchases(hits, bills, opts.exceptBillId);
}

/** A supplier's own document, as the near-match needs it. */
export type SupplierDoc = {
  id: string;
  invoice_number: string | null;
  supplier_account_id: string | null;
  job_id?: string | null;
  total: number | string | null;
  invoice_date: string | null;
};

/**
 * WHICH BILLS A SUPPLIER DOCUMENT ALREADY COVERS: linked to one (bill_supplier_invoices, 0273), or
 * carrying one of that account's document numbers. The /bills coverage count, the "no supplier
 * document" slice and the server's tie check all read this, so a list and a button can never
 * disagree about which purchase is already in the books.
 */
export function billsCoveredByDocuments(
  bills: readonly LedgerBill[],
  docs: readonly SupplierDoc[],
  links: readonly { bill_id: string | null; supplier_invoice_id: string | null }[],
  aliases: SupplierAliasIndex | null = null,
): Set<string> {
  const covered = new Set<string>();
  // A link to any member of a purchase covers the whole purchase (0381): CED's copy of the
  // correction's paper covers the ticket it corrects.
  const { of } = purchasesOf(bills);
  for (const l of links) {
    if (!l?.bill_id) continue;
    const id = String(l.bill_id);
    for (const m of of.get(id)?.members ?? []) covered.add(m.id);
    covered.add(id);
  }
  for (const d of docs) {
    for (const b of billsCarryingNumber(d.invoice_number, { accountId: d.supplier_account_id }, bills, aliases)) covered.add(b.id);
  }
  return covered;
}

/** One purchase offered as maybe the same as a supplier document: its ORIGINAL bill, whole. */
export type SamePurchaseCandidate = {
  /** The original bill's id (the one a tie links, the one Correct This Bill opens). */
  billId: string;
  /** The purchase carries the document's own number: certain, not a maybe. */
  exact: boolean;
  /** Not exact, but the bill carries this long number under a supplier name on no account yet
   *  (billsMaybeCarryingNumber): a maybe, said as such. */
  otherSpelling?: boolean;
  /**
   * THE SAME PURCHASE AT ANOTHER PRICE (0381): not within tolerance, but on the document's account
   * and job within the days, offered when nothing is within tolerance. The door is Correct This
   * Bill, never a tie: the paper's total becomes the purchase's, as a correction under the bill.
   */
  reprice?: boolean;
  /** What the purchase comes to: the bill and every correction under it (one bill: its amount). */
  amount: number;
  /** What the document says the purchase comes to, on a reprice offer. */
  paperTotal?: number;
  dollarsOff: number;
  daysApart: number | null;
  jobId: string | null;
  /** "Consolidated Electrical Dist. #8802-SO-257555, $323.71, 2026-09-24, on J-011 13897 Honeysuckle";
   *  with a correction: "… #8802-SO-257899 corrected by 8802-1109100, $709.18 together, …". */
  label: string;
};

/** How many purchases at another price are offered at most, closest in money first. */
export const REPRICE_OFFERS = 3;
/**
 * A purchase at another price is the same order of money: the paper within half to twice the
 * purchase (the J-011 shape is $613.19 against $709.18). A $44.44 ticket is never "the same
 * purchase" as a $709.18 paper, whatever the job (skeptic review of cn-v1066).
 */
export const REPRICE_RATIO = 2;

/** "Within a few dollars and days": the counter ticket and CED's invoice for it are the same
 *  total (the tax is on both), a few days apart; a scan that was photographed late, or an invoice
 *  CED issued weeks after the counter, still sits inside this. It only ever suggests. */
export const SAME_PURCHASE_DOLLARS = 5;
export const SAME_PURCHASE_DAYS = 45;

/**
 * HOW FAR APART TWO TOTALS MAY BE AND STILL BE ASKED ABOUT: a few dollars on a real purchase, never
 * more than 3% of a small one (with a dollar's floor for rounding). The replay against ET's books
 * found why: a flat $5 offered a $0.00 placeholder bill as "maybe the same purchase" as three CED
 * invoices of $2.30 to $4.63. A bill with no money on it is never offered at all.
 */
export function samePurchaseTolerance(total: number): number {
  return Math.min(SAME_PURCHASE_DOLLARS, Math.max(1, Math.abs(total) * 0.03));
}

const ymd = (v: string | null | undefined): string | null => {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "Consolidated Electrical Dist. #8802-SO-257555, $323.71, 2026-09-24, on J-011 13897 Honeysuckle".
 * With the corrections under it (0381), the purchase whole: "… #8802-SO-257899 corrected by
 * 8802-1109100, $709.18 together, 2026-09-24, on J-011 13897 Honeysuckle".
 */
export function billLabel(b: LedgerBill, corrections: readonly LedgerBill[] = []): string {
  const amount = corrections.length ? (cents(b.amount) + corrections.reduce((s, c) => s + cents(c.amount), 0)) / 100 : Number(b.amount);
  const job = b.jobs?.job_number ? `${b.jobs.job_number}${b.jobs.name ? ` ${b.jobs.name}` : ""}` : b.jobs?.name ? b.jobs.name : b.job_id ? "a job" : "business costs";
  const number = b.bill_number || b.supplier_invoice_number;
  const by = corrections.map((c) => c.bill_number || c.supplier_invoice_number || "a correction");
  return `${b.supplier ?? "A bill"}${number ? ` #${number}` : ""}${by.length ? ` corrected by ${by.join(", ")}` : ""}${
    Number.isFinite(amount) ? `, ${money(amount)}${by.length ? " together" : ""}` : ""
  }${ymd(b.bill_date) ? `, ${ymd(b.bill_date)}` : ""}, on ${job}`;
}

/**
 * THE BILLS THAT MAY BE THIS SUPPLIER DOCUMENT'S PURCHASE, best first.
 *
 *   · a live bill carrying the document's own number is certain (exact), whatever else it covers;
 *   · a live bill carrying it under a supplier name on no account yet is a maybe (otherSpelling),
 *     never certain (audit v994, DB5), not a statement and covered by no document;
 *   · otherwise a live bill on the SAME account (never another account, never a guessed one), not
 *     a statement, that no supplier document covers yet, on the document's job when the document
 *     has one (a no-job document is offered the account's bills on any job, or none), within
 *     samePurchaseTolerance of its total (never a $0.00 bill) and SAME_PURCHASE_DAYS of its date either side.
 *
 * ONE PURCHASE, WHOLE (0381): a bill and the corrections under it are weighed together, at the
 * together total, and offered once as the original. A correction is never offered on its own.
 *
 * THE SAME PURCHASE AT ANOTHER PRICE (reprice, Erik 2026-10-04): the counter priced a fixture at
 * $0.00 and CED's invoice for the same purchase came to $95.99 more. Nothing within tolerance, so
 * the card offered only Record It As A Bill: a second full bill on the job, billed to the customer
 * twice on T&M. Now, when NO purchase is within tolerance and the document has a job (filed on
 * one, or `namedJobId`, the job its printed label names by the exact rule), the uncovered
 * purchases on that account and job within the days are offered, at most REPRICE_OFFERS, closest
 * in money first, and the door is Correct This Bill. Still a suggestion: a person decides.
 *
 * Ranked: exact first, then the smallest difference in money, then in days. Nothing is picked.
 */
export function samePurchaseCandidates(
  doc: SupplierDoc,
  bills: readonly LedgerBill[],
  covered: ReadonlySet<string>,
  aliases: SupplierAliasIndex | null = null,
  opts: { namedJobId?: string | null } = {},
): SamePurchaseCandidate[] {
  const accountId = doc.supplier_account_id ?? null;
  const total = Number(doc.total);
  const docDate = ymd(doc.invoice_date);
  const out: SamePurchaseCandidate[] = [];
  const reprice: SamePurchaseCandidate[] = [];
  const exactIds = new Set(billsCarryingNumber(doc.invoice_number, { accountId }, bills, aliases).map((b) => b.id));
  const otherSpellingIds = new Set(billsMaybeCarryingNumber(doc.invoice_number, { accountId }, bills, aliases).map((b) => b.id));
  const repriceJob = doc.job_id ?? opts.namedJobId ?? null;
  for (const p of purchasesOf(bills).purchases) {
    const b = p.original;
    const amount = p.amount;
    const dollarsOff = Number.isFinite(total) ? Math.round(Math.abs(amount - total) * 100) / 100 : Infinity;
    const daysApart = daysBetween(ymd(b.bill_date), docDate);
    const any = (set: ReadonlySet<string>) => p.members.some((m) => set.has(m.id));
    const candidate = (exact: boolean, otherSpelling = false): SamePurchaseCandidate => ({
      billId: b.id,
      exact,
      ...(otherSpelling ? { otherSpelling: true } : {}),
      amount,
      dollarsOff: Number.isFinite(dollarsOff) ? dollarsOff : 0,
      daysApart,
      jobId: b.job_id ?? null,
      label: billLabel(b, p.corrections),
    });
    if (any(exactIds)) {
      out.push(candidate(true));
      continue;
    }
    if (any(otherSpellingIds)) {
      if (!b.is_statement && !any(covered)) out.push(candidate(false, true));
      continue;
    }
    if (!accountId) continue;
    const billAccount = b.supplier_account_id || accountForSupplier(b.supplier, aliases);
    if (billAccount !== accountId) continue;
    if (b.is_statement || any(covered)) continue;
    if (doc.job_id && b.job_id !== doc.job_id) continue;
    if (!(Math.abs(amount) > 0.005)) continue;
    if (daysApart !== null && daysApart > SAME_PURCHASE_DAYS) continue;
    if (dollarsOff <= samePurchaseTolerance(total)) {
      out.push(candidate(false));
      continue;
    }
    // Only a real purchase (above zero), a dated paper (an undated one is not "within the days"),
    // and the same order of money (REPRICE_RATIO either way).
    if (
      repriceJob &&
      b.job_id === repriceJob &&
      daysApart !== null &&
      amount > 0.005 &&
      Number.isFinite(total) &&
      total > 0.005 &&
      total <= amount * REPRICE_RATIO &&
      amount <= total * REPRICE_RATIO
    ) {
      reprice.push({ ...candidate(false), reprice: true, paperTotal: total });
    }
  }
  const byMoneyThenDays = (a: SamePurchaseCandidate, b: SamePurchaseCandidate) =>
    a.dollarsOff - b.dollarsOff || (a.daysApart ?? SAME_PURCHASE_DAYS + 1) - (b.daysApart ?? SAME_PURCHASE_DAYS + 1);
  if (!out.length) return reprice.sort(byMoneyThenDays).slice(0, REPRICE_OFFERS);
  return out.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(!!b.otherSpelling) - Number(!!a.otherSpelling) || byMoneyThenDays(a, b));
}

/** The sentence a candidate is offered with, the same on the card and in a refusal. */
export function samePurchaseSentence(c: SamePurchaseCandidate): string {
  if (c.exact) return `Already on the books with this number: ${c.label}.`;
  if (c.reprice) {
    const gap = cents(c.paperTotal) - cents(c.amount);
    return `Maybe the same purchase at another price: ${c.label}. This paper says ${money(Number(c.paperTotal) || 0)} (${gap < 0 ? "−" : "+"}${money(Math.abs(gap) / 100)}). Correct This Bill puts the difference under it as its own bill.`;
  }
  if (c.otherSpelling)
    return `Maybe already on the books: ${c.label}. It carries this number, under a supplier name that is on no supplier account yet.`;
  const days = c.daysApart === null ? "" : c.daysApart === 0 ? ", the same day" : `, ${c.daysApart} day${c.daysApart === 1 ? "" : "s"} apart`;
  const off = c.dollarsOff < 0.005 ? "the same total" : `${money(c.dollarsOff)} apart`;
  return `Maybe already on the books: ${c.label} (${off}${days}). A counter ticket carries its own number, never the one on the supplier's invoice.`;
}
