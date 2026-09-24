/**
 * PAPER THAT HAS BEEN READ AND NOT YET FILED (0295; Erik, 2026-09-24).
 *
 * "Organize photos wait for File It": a model read is a proposal, never a filing. Every receipt,
 * bill or invoice that comes in through Organize or Drop Paperwork is read, shown as ONE line
 * ("Receipt, Home Depot, $84.12, paid at the counter"), and becomes money only when a person
 * picks where it goes and presses File It. This module is the pure half of that: what a piece of
 * paper IS, what it can become today, what stops it, and whether the same purchase is already on
 * the books. The server's File It and the button on screen ask the same function, so a door that
 * looks open is open and a refusal on the server is the sentence the screen already showed.
 *
 * The app suggests, a person decides. Nothing in here writes, and nothing here picks a job.
 */

import { BUSINESS_COST_BUCKETS, isBusinessCostBucket, type BusinessCostBucket } from "@/lib/business-cost-buckets";
import { accountForSupplier, aliasKey, type SupplierAliasIndex } from "@/lib/supplier-identity";

// ── WHAT THE PAPER IS ───────────────────────────────────────────────────────────────────────

export const PAPER_TYPES = [
  "receipt",
  "bill",
  "not_a_cost",
  "supplier_documents",
  "statement",
  "credit_memo",
  "purchase_order",
  "other",
] as const;
export type PaperType = (typeof PAPER_TYPES)[number];

/** File It writes these as a cost: a paid receipt, or a bill still owed. */
export const COST_PAPER: readonly PaperType[] = ["receipt", "bill"];

/**
 * Recognised, and NOT filed yet. A statement, a credit memo and a purchase order each need a home
 * this update does not build (the statement check, the credit-memo question, POs from paper), and
 * filing one as a bill is exactly how a $3,034.54 statement became one "bill" standing for two
 * invoices. So it is said, plainly, and offered a place to keep it; never a button that pretends.
 */
export const LATER_PAPER: readonly PaperType[] = ["statement", "credit_memo", "purchase_order"];

export const NOT_FILED_YET = "Not filed: this kind of paper goes in a later update.";

export function paperTypeOf(raw: unknown): PaperType | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((PAPER_TYPES as readonly string[]).includes(s)) return s as PaperType;
  // What the older reader and a model's loose spelling say.
  if (s === "invoice" || s === "supplier_invoice" || s === "subcontractor_bill") return "bill";
  if (s === "credit" || s === "credit_note" || s === "return") return "credit_memo";
  if (s === "po") return "purchase_order";
  if (s === "account_statement") return "statement";
  return null;
}

export function paperTypeLabel(t: PaperType | null | undefined): string {
  switch (t) {
    case "receipt":
      return "Receipt";
    case "bill":
      return "Bill";
    case "not_a_cost":
      return "Not A Cost";
    case "supplier_documents":
      return "CED Documents";
    case "statement":
      return "Statement";
    case "credit_memo":
      return "Credit Memo";
    case "purchase_order":
      return "Purchase Order";
    case "other":
      return "Other Paper";
    default:
      return "Paper";
  }
}

/** How the paper says it was paid, in the words a person uses at the counter. */
export function paymentPhrase(payment: string | null | undefined): string {
  switch (payment) {
    case "paid_at_purchase":
      return "paid at the counter";
    case "on_account":
      return "on account";
    default:
      return "not marked paid";
  }
}

/** The category the bill carries: what the paper IS, never a hard-coded "Receipt". */
export function billCategoryFor(item: { doc_type?: string | null; category?: string | null }): "Receipt" | "Bill" | "Invoice" {
  const t = paperTypeOf(item.doc_type);
  if (t === "bill") return "Bill";
  if (t === "receipt") return "Receipt";
  const c = String(item.category ?? "");
  if (c === "Bill" || c === "Invoice" || c === "Receipt") return c;
  return "Receipt";
}

// ── THE ROW ─────────────────────────────────────────────────────────────────────────────────

export type PaperProposal = {
  /** The job the PAPER names (a job number, a customer, an address on it). Never a guess. */
  jobId?: string | null;
  /** Why that job: the words on the paper that point to it. */
  jobHint?: string | null;
  /** A business-cost bucket the reader suggests. Never Fees: a supplier's fee is its own paper. */
  bucket?: string | null;
  po?: string | null;
  /** Over the reader's size limit: a person fills it in. */
  tooBig?: boolean;
  /** The reader failed; the words it failed with. */
  readError?: string | null;
  /** CED documents found in a PDF's text layer: numbers, total, and the text itself. `refused` is
   *  every document in the same PDF that did not add up, said on the row rather than dropped. */
  ced?: {
    numbers: string[];
    total: number;
    kinds: string[];
    text: string;
    name: string;
    refused?: { number: string | null; error: string }[];
  } | null;
  /** What AI Suggest said, kept beside the row it suggested for. */
  why?: string | null;
  /** How the row was last filed, so Undo takes down exactly that and nothing else. */
  filed?: { how: "bill" | "tie" | "supplier_documents" | "kept"; landed?: string[] } | null;
};

export type PaperItem = {
  id: string;
  kind?: string | null;
  status?: string | null;
  title?: string | null;
  vendor?: string | null;
  amount?: number | string | null;
  item_date?: string | null;
  payment?: string | null;
  doc_type?: string | null;
  doc_number?: string | null;
  proposal?: unknown;
  summary?: string | null;
  bill_id?: string | null;
  job_id?: string | null;
  tied_bill_id?: string | null;
  tied_supplier_invoice_id?: string | null;
  pricing_provisional?: boolean | null;
  confidence?: string | null;
};

export function proposalOf(item: { proposal?: unknown }): PaperProposal {
  const p = item.proposal;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as PaperProposal) : {};
}

const money = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function amountOf(item: { amount?: number | string | null }): number | null {
  if (item.amount === null || item.amount === undefined || item.amount === "") return null;
  const n = Number(item.amount);
  return Number.isFinite(n) ? n : null;
}

/** Has anything read this paper yet? A placeholder row is a file name and nothing else. */
export function isRead(item: PaperItem): boolean {
  if (item.doc_type) return true;
  if (proposalOf(item).ced) return true;
  // Rows read before 0295 carry what the old reader wrote, and no doc_type.
  return item.kind === "receipt" || item.kind === "note" || !!item.summary || amountOf(item) !== null;
}

/** The paper type, including rows read before 0295 (an old "receipt" row is a receipt). */
export function paperTypeOfItem(item: PaperItem): PaperType | null {
  const t = paperTypeOf(item.doc_type);
  if (t) return t;
  if (item.kind === "receipt") return /bill|invoice/i.test(String((item as { category?: string }).category ?? "")) ? "bill" : "receipt";
  return null;
}

/**
 * ONE LINE: "Receipt, Home Depot, $84.12, paid at the counter". What was read, in the order a
 * person checks it.
 */
export function describePaper(item: PaperItem): string {
  const p = proposalOf(item);
  if (p.ced) {
    const n = p.ced.numbers.length;
    return `CED ${n === 1 ? "document" : `${n} documents`}, ${p.ced.numbers.slice(0, 3).join(", ")}${n > 3 ? "…" : ""}, ${money(p.ced.total)}`;
  }
  const t = paperTypeOfItem(item);
  const parts: string[] = [paperTypeLabel(t)];
  const vendor = String(item.vendor ?? "").trim();
  if (vendor) parts.push(vendor);
  const amount = amountOf(item);
  parts.push(amount === null ? "no total read" : money(amount));
  if (t === "receipt" || t === "bill") parts.push(paymentPhrase(item.payment));
  return parts.join(", ");
}

export type Readiness =
  | { state: "not_read"; sentence: string }
  | { state: "too_big"; sentence: string }
  | { state: "needs_total"; sentence: string }
  | { state: "ready"; sentence: string }
  | { state: "supplier_documents"; sentence: string }
  | { state: "later"; sentence: string }
  | { state: "keep"; sentence: string }
  | { state: "filed"; sentence: string };

export function readinessOf(item: PaperItem): Readiness {
  if (item.status && item.status !== "needs_review") return { state: "filed", sentence: "Filed." };
  const p = proposalOf(item);
  if (p.ced) return { state: "supplier_documents", sentence: "Ready To File: these go on the CED documents list." };
  if (p.tooBig && !isRead(item)) return { state: "too_big", sentence: "Too big to read: fill it in yourself." };
  if (!isRead(item))
    return {
      state: "not_read",
      sentence: p.readError ? `Not Read Yet: ${p.readError}` : "Not Read Yet.",
    };
  const t = paperTypeOfItem(item);
  if (t && LATER_PAPER.includes(t)) return { state: "later", sentence: NOT_FILED_YET };
  if (t === "receipt" || t === "bill") {
    if (amountOf(item) === null) return { state: "needs_total", sentence: "No total was read. Fix Details and put the total in, then File It." };
    return { state: "ready", sentence: "Ready To File." };
  }
  return { state: "keep", sentence: t === "not_a_cost" ? "Not a cost. Keep it on a job or in files." : "Keep it on a job or in files." };
}

// ── WHERE IT GOES ───────────────────────────────────────────────────────────────────────────

export type PaperDestination =
  | { type: "job"; jobId: string }
  | { type: "overhead"; category: BusinessCostBucket }
  | { type: "keep" };

/** The picker's value: "job:<id>", "cost:<bucket>", "keep". */
export function destinationValue(d: PaperDestination | null): string {
  if (!d) return "";
  if (d.type === "job") return `job:${d.jobId}`;
  if (d.type === "overhead") return `cost:${d.category}`;
  return "keep";
}

export function parseDestination(value: string | null | undefined): PaperDestination | null {
  const v = String(value ?? "");
  if (v === "keep") return { type: "keep" };
  if (v.startsWith("job:") && v.length > 4) return { type: "job", jobId: v.slice(4) };
  if (v.startsWith("cost:")) {
    const bucket = v.slice(5);
    return isBusinessCostBucket(bucket) ? { type: "overhead", category: bucket } : null;
  }
  return null;
}

/**
 * The reader's suggestion, as the picker's starting value, or "" (nothing picked) when the paper
 * does not point anywhere. A suggested job is only kept if it is still on the job list.
 */
export function suggestedDestination(item: PaperItem, jobIds: readonly string[]): string {
  const p = proposalOf(item);
  if (p.jobId && jobIds.includes(p.jobId)) return `job:${p.jobId}`;
  const t = paperTypeOfItem(item);
  if ((t === "receipt" || t === "bill") && p.bucket && isBusinessCostBucket(p.bucket) && p.bucket !== "Fees") return `cost:${p.bucket}`;
  return "";
}

/**
 * THE PICKER FOLLOWS THE SUGGESTION UNTIL A PERSON TOUCHES IT. A row renders before its paper is
 * read (Drop Paperwork adds the row, then reads it), and AI Suggest writes a suggestion after the
 * row is on screen; a picker seeded once at mount would say "It is picked below" over a picker
 * still reading "Where Does It Go?". `picked` is null until a person chooses; after that, theirs
 * wins, including choosing nothing.
 */
export function shownDestination(picked: string | null, item: PaperItem, jobIds: readonly string[]): string {
  return picked ?? suggestedDestination(item, jobIds);
}

/**
 * THE GATE, asked by the File It button AND by the server before it writes a cent. Null means go.
 * A sentence means stop, and it is the sentence the person sees.
 */
export function fileRefusal(item: PaperItem, dest: PaperDestination | null): string | null {
  if (!dest) return "Pick where it goes first: a job, or a business cost bucket.";
  const r = readinessOf(item);
  if (r.state === "filed") return "This is already filed. Undo it first to file it somewhere else.";
  if (r.state === "not_read") return "This hasn't been read yet. Press Read Now, or Fix Details and fill it in.";
  if (r.state === "too_big") return "Too big to read. Fix Details and put the total in, then File It.";
  if (r.state === "later") return NOT_FILED_YET;
  if (r.state === "supplier_documents") return dest.type === "keep" ? null : "These are CED documents. Press Add To CED Documents.";
  const t = paperTypeOfItem(item);
  const isCost = t === "receipt" || t === "bill";
  if (isCost && dest.type === "keep") return "This is a cost. File it on a job or as a business cost, or change its type in Fix Details.";
  if (!isCost && dest.type === "overhead") return "Only a receipt or a bill can be a business cost. Change its type in Fix Details if it is one.";
  if (isCost && r.state === "needs_total") return r.sentence;
  return null;
}

// ── IS THIS PURCHASE ALREADY ON THE BOOKS? ─────────────────────────────────────────────────

/** "#8802-1108330 ", "no. 8802 1108330" and "8802-1108330" are the same printed number. */
export function normalizeDocNumber(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/^\s*(?:NO\.?|NUMBER|INV(?:OICE)?\.?|#)\s*/g, "")
    .replace(/[^A-Z0-9]+/g, "");
}

export type BookedBill = {
  id: string;
  supplier: string | null;
  bill_number: string | null;
  supplier_account_id?: string | null;
  amount: number | string | null;
  bill_date: string | null;
  job_id?: string | null;
  jobs?: { job_number?: string | null; name?: string | null } | null;
};
export type BookedPaper = {
  id: string;
  vendor: string | null;
  doc_number: string | null;
  status: string | null;
  bill_id: string | null;
  title?: string | null;
};
export type BookedSupplierInvoice = {
  id: string;
  invoice_number: string;
  supplier_account_id: string | null;
  total: number | string | null;
  invoice_date?: string | null;
  /** The bill that already covers this document (bill_supplier_invoices, 0273/0277), if any. */
  covered_by?: { id: string; job_id?: string | null; jobs?: { job_number?: string | null; name?: string | null } | null } | null;
};

/**
 * What the number check found.
 *   · "bill": the same purchase is already a cost (a bill with this number, or the bill that
 *     already covers a CED document with this number). File It refuses and offers Tie Them.
 *   · "supplier_invoice": a CED document with this number that NO bill covers yet. It is not a
 *     cost (owner-money counts only bills), so there is nothing to tie to: File It goes ahead and
 *     links the new bill to it, and the button says so.
 *   · "paper": another paper in the tray with the same number. Said, never blocking.
 */
export type NumberMatch =
  | { kind: "bill"; billId: string; jobId?: string | null; sentence: string }
  | { kind: "supplier_invoice"; supplierInvoiceId: string; invoiceNumber: string; sentence: string }
  | { kind: "paper"; itemId: string; sentence: string };

function sameSupplier(
  a: { name: string | null; account: string | null },
  b: { name: string | null; account: string | null },
  aliases: SupplierAliasIndex | null,
): boolean {
  const aAcct = a.account ?? accountForSupplier(a.name, aliases);
  const bAcct = b.account ?? accountForSupplier(b.name, aliases);
  if (aAcct && bAcct) return aAcct === bAcct;
  const ak = aliasKey(a.name);
  return !!ak && ak === aliasKey(b.name);
}

/**
 * Every record already on the books with this paper's printed number AND the same supplier, by
 * exact spelling or exact alias only (supplier-identity.ts: the fuzzy match is for suggestions,
 * and this one decides which button shows). A supplier's own document (supplier_invoices) is
 * keyed on its number alone when it has no account yet, but only for a long number: "1234" from
 * two stores is two purchases, "8802-1108330" is not.
 */
export function findSameNumber(
  item: PaperItem,
  books: { bills?: readonly BookedBill[]; papers?: readonly BookedPaper[]; supplierInvoices?: readonly BookedSupplierInvoice[] },
  aliases: SupplierAliasIndex | null = null,
): NumberMatch[] {
  const number = normalizeDocNumber(item.doc_number);
  if (!number) return [];
  const me = { name: item.vendor ?? null, account: null };
  const out: NumberMatch[] = [];
  for (const b of books.bills ?? []) {
    if (b.id === item.bill_id) continue; // the bill THIS paper made
    if (normalizeDocNumber(b.bill_number) !== number) continue;
    if (!sameSupplier(me, { name: b.supplier, account: b.supplier_account_id ?? null }, aliases)) continue;
    const amount = amountOf(b);
    const job = b.jobs?.job_number ? `${b.jobs.job_number}${b.jobs.name ? ` ${b.jobs.name}` : ""}` : b.job_id ? "a job" : "business costs";
    out.push({
      kind: "bill",
      billId: b.id,
      jobId: b.job_id ?? null,
      sentence: `Already on the books: ${b.supplier ?? "a bill"} #${b.bill_number}${amount !== null ? `, ${money(amount)}` : ""}${b.bill_date ? `, ${b.bill_date}` : ""}, on ${job}.`,
    });
  }
  for (const si of books.supplierInvoices ?? []) {
    if (normalizeDocNumber(si.invoice_number) !== number) continue;
    if (si.supplier_account_id) {
      const mine = accountForSupplier(item.vendor, aliases);
      if (mine && mine !== si.supplier_account_id) continue;
      if (!mine && number.replace(/\D/g, "").length < 7) continue;
    } else if (number.replace(/\D/g, "").length < 7) continue;
    const total = amountOf({ amount: si.total });
    const said = `${si.invoice_number}${total !== null ? `, ${money(total)}` : ""}`;
    const cover = si.covered_by;
    if (cover?.id) {
      // Already a cost: the bill that covers it is the purchase. Found once, whichever way.
      if (cover.id === item.bill_id || out.some((m) => m.kind === "bill" && m.billId === cover.id)) continue;
      const job = cover.jobs?.job_number ? `${cover.jobs.job_number}${cover.jobs.name ? ` ${cover.jobs.name}` : ""}` : cover.job_id ? "a job" : "business costs";
      out.push({
        kind: "bill",
        billId: cover.id,
        jobId: cover.job_id ?? null,
        sentence: `Already on the books: CED document ${said}, covered by a bill on ${job}.`,
      });
      continue;
    }
    out.push({
      kind: "supplier_invoice",
      supplierInvoiceId: si.id,
      invoiceNumber: si.invoice_number,
      sentence: `On the CED documents list with no bill yet: ${said}. File It makes the bill and links it to that document.`,
    });
  }
  for (const p of books.papers ?? []) {
    if (p.id === item.id) continue;
    if (normalizeDocNumber(p.doc_number) !== number) continue;
    if (!sameSupplier(me, { name: p.vendor, account: null }, aliases)) continue;
    // A paper that made a bill is found above as that bill (File It writes bill_number).
    if (p.bill_id) continue;
    out.push({
      kind: "paper",
      itemId: p.id,
      sentence: `Another paper here has the same number (${p.title ?? p.vendor ?? "untitled"}), ${p.status === "needs_review" ? "still waiting to be filed" : "set aside"}.`,
    });
  }
  return out;
}

/** The six buckets, re-exported so a picker never needs a second import to list them. */
export const PAPER_BUCKETS = BUSINESS_COST_BUCKETS;
