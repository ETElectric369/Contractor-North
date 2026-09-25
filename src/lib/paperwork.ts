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
 * The app suggests, a person decides. Nothing in here writes. A job is pre-picked only when the
 * PAPER names it (a printed job number, PO, address, job name or customer matching exactly one
 * open job, jobFromPaperMarks); a model's guess is offered as a guess and never picked, and a
 * picture is asked what it is before it is asked where it goes (Erik, 2026-09-24).
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
  /**
   * The job the PAPER names, found by exact matching in code (jobFromPaperMarks): a job number, a
   * PO number, a job address, a job name or a customer printed on it that points to exactly one
   * open job. Only a row that also carries `jobFrom` is pre-picked; a `jobId` with no `jobFrom` is
   * what a model said before 2026-09-24 and is offered as a guess, never picked.
   */
  jobId?: string | null;
  /** WHICH printed mark found that job. Its presence is what makes `jobId` a pick, not a guess. */
  jobFrom?: JobMarkKind | null;
  /** Why that job: the words on the paper that point to it. */
  jobHint?: string | null;
  /** The paper names more than one job (two marks disagree). Said on the row; nothing is picked. */
  jobConflict?: string | null;
  /** A model's guess at the job (the reader's job_id, or AI Suggest). Offered as a chip, never picked. */
  guessJobId?: string | null;
  /**
   * What the reader copied off the paper that names a job, kept on the row (2026-09-24). Before
   * this only the PO and the hint survived the read, so a paper already in the tray could never be
   * matched again once the rules learned something. The tray re-runs the exact match from these
   * (rematchPaper) without asking a model again.
   */
  marks?: PaperMarks | null;
  /** A business-cost bucket a model guesses. Offered as a chip, never picked. Never Fees. */
  bucket?: string | null;
  /** The reader says this is a plain picture (a job site, a panel, a label), not paperwork. */
  picture?: boolean;
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
  filed?: { how: "bill" | "tie" | "supplier_documents" | "kept" | "photo"; landed?: string[] } | null;
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
  /** What the reader or a person called it ("Receipt", "Bill", "Invoice", "Photo", …). */
  category?: string | null;
  proposal?: unknown;
  summary?: string | null;
  bill_id?: string | null;
  job_id?: string | null;
  tied_bill_id?: string | null;
  tied_supplier_invoice_id?: string | null;
  pricing_provisional?: boolean | null;
  confidence?: string | null;
  /** What the reader transcribed, line by line (jsonb; File It writes these as the bill's lines). */
  line_items?: unknown;
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

/**
 * A RETURN WITH NO LINES CANNOT GO ON A JOB (audit v994, DB4).
 *
 * A negative bill on a job is a supplier return, and the importer credits it to the customer. What
 * holds that credit to what the customer was actually billed is its LINES: each returned part is
 * matched to the purchase it reverses and credits at most what that purchase billed
 * (returnLinesAgainstPurchases), and a line can be switched off like any other. With no lines
 * there is nothing to match and nothing to switch off, so the whole return is credited at markup -
 * the INV-078 housings, credited to Andrew when he was never charged for them. So File It asks for
 * the lines first. A business cost is the company's own book and never reaches a customer, so it
 * is not held to this.
 */
export function isReturnWithoutLines(item: PaperItem): boolean {
  const t = paperTypeOfItem(item);
  if (t !== "receipt" && t !== "bill") return false;
  const total = amountOf(item);
  if (total === null || !(Math.round(total * 100) < 0)) return false;
  const lines = Array.isArray(item.line_items) ? item.line_items : [];
  return !lines.some((l) => l && typeof l === "object" && String((l as { description?: unknown }).description ?? "").trim());
}

export const RETURN_NEEDS_LINES =
  "This is a return with no lines on it, so on a job it would credit the customer the whole amount, even for parts they were never charged for. Press Read Again so its lines come with it, or file it as a business cost.";

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
  if (item.kind === "receipt") return /bill|invoice/i.test(String(item.category ?? "")) ? "bill" : "receipt";
  return null;
}

/**
 * A PLAIN PICTURE, NOT PAPER (Erik, 2026-09-24: "if it's a picture not a bill ... it should ask
 * where to file it"). A photo of a job site, a panel or a label was read as "not a cost" and
 * offered Keep It In Files, as if it were a permit. It is asked "What is this?" first. The reader
 * says so on the proposal; a row read before that says it with the category "Photo".
 */
export function isPicture(item: PaperItem): boolean {
  const t = paperTypeOfItem(item);
  if (t !== "not_a_cost" && t !== "other") return false;
  const p = proposalOf(item);
  if (p.ced) return false;
  return p.picture === true || String(item.category ?? "") === "Photo";
}

/**
 * ONE LINE: "Receipt, Home Depot, $84.12, paid at the counter". What was read, in the order a
 * person checks it.
 */
export function describePaper(item: PaperItem): string {
  const p = proposalOf(item);
  if (isPicture(item)) {
    const title = String(item.title ?? "").trim();
    return title ? `Picture, ${title}` : "Picture";
  }
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
  | { state: "picture"; sentence: string }
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
  if (isPicture(item)) return { state: "picture", sentence: "What is this?" };
  return { state: "keep", sentence: t === "not_a_cost" ? "Not a cost. Keep it on a job or in files." : "Keep it on a job or in files." };
}

// ── WHERE IT GOES ───────────────────────────────────────────────────────────────────────────

export type PaperDestination =
  | { type: "job"; jobId: string }
  | { type: "overhead"; category: BusinessCostBucket }
  /** A picture filed on a job as a job photo (the job page's Photos), never as a cost. */
  | { type: "photo"; jobId: string }
  | { type: "keep" };

/** The picker's value: "job:<id>", "cost:<bucket>", "photo:<id>", "keep". */
export function destinationValue(d: PaperDestination | null): string {
  if (!d) return "";
  if (d.type === "job") return `job:${d.jobId}`;
  if (d.type === "overhead") return `cost:${d.category}`;
  if (d.type === "photo") return `photo:${d.jobId}`;
  return "keep";
}

export function parseDestination(value: string | null | undefined): PaperDestination | null {
  const v = String(value ?? "");
  if (v === "keep") return { type: "keep" };
  if (v.startsWith("job:") && v.length > 4) return { type: "job", jobId: v.slice(4) };
  if (v.startsWith("photo:") && v.length > 6) return { type: "photo", jobId: v.slice(6) };
  if (v.startsWith("cost:")) {
    const bucket = v.slice(5);
    return isBusinessCostBucket(bucket) ? { type: "overhead", category: bucket } : null;
  }
  return null;
}

/** Was this job found on the PAPER (a printed mark matched exactly), rather than guessed? */
function markedJob(p: PaperProposal): string | null {
  return p.jobId && p.jobFrom && (JOB_MARK_KINDS as readonly string[]).includes(p.jobFrom) && !p.jobConflict ? p.jobId : null;
}

/**
 * WHAT THE PICKER STARTS ON (Erik, 2026-09-24: "if it's ... a bill with no address or job
 * markings then it should ask where to file it").
 *
 * Only the job the PAPER names: a printed mark that code matched to exactly one open job. Nothing
 * else is ever picked for a person: not a model's guess at the job, not a model's bucket. A paper
 * with no marks starts on nothing, and the row asks "Where does this go?". A guess is offered
 * beside the question as a chip (guessOf), labelled a guess, and a person taps it or doesn't.
 */
export function suggestedDestination(item: PaperItem, jobIds: readonly string[]): string {
  const job = markedJob(proposalOf(item));
  return job && jobIds.includes(job) ? `job:${job}` : "";
}

/**
 * THE ONE-TAP GUESS: a model's idea of where this goes, never picked. A job a model guessed (the
 * reader's job_id, AI Suggest, or a job a model wrote before marks existed), else a bucket for a
 * cost. Null when there is no guess, or it is what the paper already picked.
 */
export function guessOf(item: PaperItem, jobIds: readonly string[]): string | null {
  const p = proposalOf(item);
  const picked = suggestedDestination(item, jobIds);
  const marked = markedJob(p);
  const jobGuess = p.guessJobId ?? (p.jobId && p.jobId !== marked ? p.jobId : null);
  if (jobGuess && jobIds.includes(jobGuess) && `job:${jobGuess}` !== picked) return `job:${jobGuess}`;
  const t = paperTypeOfItem(item);
  if ((t === "receipt" || t === "bill") && p.bucket && isBusinessCostBucket(p.bucket) && p.bucket !== "Fees") return `cost:${p.bucket}`;
  return null;
}

/** The word for the paper in a sentence: the receipt, the bill, the invoice, the photo. */
function paperWord(item: PaperItem): string {
  if (isPicture(item)) return "photo";
  const t = paperTypeOfItem(item);
  if (t === "bill") return String(item.category ?? "") === "Invoice" ? "invoice" : "bill";
  if (t === "receipt") return "receipt";
  return "paper";
}

/**
 * WHY THE JOB IS ALREADY PICKED, in a few words, with the words on the paper that picked it: "Job
 * picked from the PO on the bill: 13897 HERRINGBONE". Null when the paper picked nothing.
 */
export function pickedBecause(item: PaperItem): string | null {
  const p = proposalOf(item);
  if (!markedJob(p) || !p.jobFrom) return null;
  const words = String(p.jobHint ?? "").trim();
  return `Job picked from the ${JOB_MARK_WORDS[p.jobFrom]} on the ${paperWord(item)}${words ? `: ${words}` : ""}`;
}

// ── WHICH JOB THE PAPER NAMES (exact, never fuzzy) ─────────────────────────────────────────

/** The printed marks, in the order they are trusted: a number, then a street, then a name. */
export const JOB_MARK_KINDS = ["job_number", "po", "address", "job_name", "customer"] as const;
export type JobMarkKind = (typeof JOB_MARK_KINDS)[number];

const JOB_MARK_WORDS: Record<JobMarkKind, string> = {
  job_number: "job number",
  po: "PO",
  address: "address",
  job_name: "job name",
  customer: "customer name",
};

/** What the reader transcribed off the paper. The words only: code decides what they point to. */
export type PaperMarks = {
  address?: string | null;
  jobName?: string | null;
  jobNumber?: string | null;
  po?: string | null;
  customer?: string | null;
  /**
   * The reader's job_hint: the words on the paper that point to a job, often a label, a name and
   * a street run together ("JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE"). Only the street
   * in it is used (addressInHint), and only when the reader gave no address of its own.
   */
  hint?: string | null;
};

/** An open job, as the matcher sees it. */
export type MarkJob = {
  id: string;
  job_number?: string | null;
  name?: string | null;
  address?: string | null;
  /** The customer's name and company name. */
  customerNames?: (string | null | undefined)[];
};

/** A purchase order this org wrote (purchase_orders), which names its job. */
export type MarkPo = { po_number: string | null; job_id: string | null };

export type JobFromMarks =
  | { kind: "one"; jobId: string; from: JobMarkKind; words: string }
  | { kind: "conflict"; sentence: string }
  | { kind: "none" };

/** "J-046", "j 046" and "J046" are one printed number. */
function compactKey(raw: string | null | undefined): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** "Jason  Waldow", "JASON WALDOW" and "Jason Waldow." are one name. */
function wordsKey(raw: string | null | undefined): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/** Every spelling of a street type, and the one spelling the key keeps: "Road" and "Rd" are one
 *  street type, "Rd" and "Dr" are two streets. */
const STREET_TYPE: Record<string, string> = {
  STREET: "ST", ST: "ST", ROAD: "RD", RD: "RD", AVENUE: "AVE", AVE: "AVE", AV: "AVE", DRIVE: "DR", DR: "DR",
  LANE: "LN", LN: "LN", COURT: "CT", CT: "CT", PLACE: "PL", PL: "PL", BOULEVARD: "BLVD", BLVD: "BLVD", WAY: "WAY",
  TRAIL: "TRL", TRL: "TRL", CIRCLE: "CIR", CIR: "CIR", TERRACE: "TER", TER: "TER", HIGHWAY: "HWY", HWY: "HWY",
  PARKWAY: "PKWY", PKWY: "PKWY", LOOP: "LOOP",
};
const DIRECTION: Record<string, string> = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" };

/** A street as printed: its house number, its own words, and its street type when one is written. */
export type StreetParts = { number: string; words: string[]; type: string | null };

/**
 * THE STREET, TAKEN APART ONE WAY: the house number, the street's own words and its street type,
 * each in one spelling. "518 Crater Lake Rd, Chilcoot CA" and "518 CRATER LAKE ROAD" are both 518 /
 * CRATER LAKE / RD. A unit on a shared street (300 W Lake Blvd #11) is cut off after the street
 * type. No house number, or no word after it: no street, and a street alone places nothing.
 */
export function streetParts(raw: string | null | undefined): StreetParts | null {
  const first = String(raw ?? "").split(",")[0];
  const tokens = first
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => DIRECTION[t] ?? t);
  if (tokens.length < 2 || !/^\d+[A-Z]?$/.test(tokens[0])) return null;
  const words: string[] = [];
  let type: string | null = null;
  for (let i = 1; i < tokens.length; i += 1) {
    // A street type after at least one word of the street's own name ends the street, and is kept
    // in its one spelling.
    const t = STREET_TYPE[tokens[i]];
    if (t && words.length >= 1) {
      type = t;
      break;
    }
    words.push(tokens[i]);
  }
  return words.length ? { number: tokens[0], words, type } : null;
}

/**
 * THE STREET, SPELLED ONE WAY: "518 CRATER LAKE RD". The same house number, the same words in the
 * same order and the same street type are one key; "13631 Northwoods" is never "13466 Northwoods"
 * and "518 Crater Lake Dr" is never "518 Crater Lake Rd".
 */
export function streetKey(raw: string | null | undefined): string | null {
  const s = streetParts(raw);
  return s ? [s.number, ...s.words, ...(s.type ? [s.type] : [])].join(" ") : null;
}

/**
 * THE SAME STREET? The same house number and exactly the same street words, and the same street
 * type when BOTH are written. A paper that leaves the type off ("13897 HERRINGBONE", in a
 * supplier's PO box) does not disagree with a job at "13897 Herringbone Way": it just didn't
 * write it (Erik, 2026-09-24). Two written types that differ are two streets: Dr is never Rd.
 * This is still spelling, not likeness; a street with no type on a road that has two (a Way and a
 * Court at the same number) matches both jobs, and two matches pick nothing.
 */
export function sameStreet(a: StreetParts | null, b: StreetParts | null): boolean {
  if (!a || !b) return false;
  if (a.number !== b.number || a.words.length !== b.words.length) return false;
  if (a.words.some((w, i) => w !== b.words[i])) return false;
  return !a.type || !b.type || a.type === b.type;
}

/**
 * THE STREET IN THE READER'S HINT. The hint is the reader's own run-together of what points to a
 * job: "JOB NAME AND ADDRESS ERIK TAYLOR 13897 HERRINGBONE" (a label, the name on the account, the
 * street). The street starts at the first house number followed by a word, and runs to a comma or
 * the end. Only that is taken; the words before it (a label, a person's name) are never read as a
 * customer. Null when there is no house number followed by a word.
 */
export function addressInHint(hint: string | null | undefined): string | null {
  // The leftmost house number that a word follows: a number followed by another number (a PO
  // written before the street) is passed over.
  for (const part of String(hint ?? "").split(",")) {
    const m = /(?:^|[^A-Za-z0-9#])(\d{1,6}[A-Za-z]?\s+[A-Za-z].*)$/.exec(part);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/**
 * WHICH OPEN JOB DOES THE PAPER NAME? Exact matching only, the way the app already resolves a job
 * by its number or its name (resolveJobId: exactly one match decides, several ask). No likeness,
 * no nearest, no score.
 *
 *   · each mark finds the open jobs it names exactly: a job number; a PO against job numbers,
 *     this org's own purchase orders, AND the jobs' names and streets (a contractor writes the
 *     JOB in a supplier's PO box: "13897 HERRINGBONE", "561 RHODESIA", Erik on every CED ticket);
 *     an address by its street (sameStreet: a type left off is not a different street); a job
 *     name, by name or by street; a customer;
 *   · the company's own name and its people's names (selfNames) are never a customer or a job
 *     name: they are on every paper as who it was sold to;
 *   · a mark that names exactly one job is decisive, and every mark that names anything must
 *     include that job. Otherwise the paper names two jobs, and NOTHING is picked (said, not
 *     hidden);
 *   · no decisive mark, nothing picked, and the row asks.
 */
export function jobFromPaperMarks(
  marks: PaperMarks | null | undefined,
  jobs: readonly MarkJob[],
  pos: readonly MarkPo[] = [],
  selfNames: readonly (string | null | undefined)[] = [],
): JobFromMarks {
  if (!marks) return { kind: "none" };
  const openIds = new Set(jobs.map((j) => j.id));
  const self = new Set(selfNames.map((n) => wordsKey(n)).filter((n) => n.length >= 3));
  const found: { kind: JobMarkKind; words: string; ids: Set<string> }[] = [];
  const add = (kind: JobMarkKind, words: string | null | undefined, ids: string[]) => {
    const set = new Set(ids.filter((id) => openIds.has(id)));
    if (set.size) found.push({ kind, words: String(words ?? "").trim(), ids: set });
  };
  const jobStreets = new Map(jobs.map((j) => [j.id, streetParts(j.address)] as const));
  const onStreet = (raw: string | null | undefined): string[] => {
    const s = streetParts(raw);
    return s ? jobs.filter((j) => sameStreet(s, jobStreets.get(j.id) ?? null)).map((j) => j.id) : [];
  };
  /**
   * A job's name, exactly, never the company's own name or one of its people. A job named after
   * its customer ("Jackie Burks") is also that customer's name, so the same words name every open
   * job of that customer too: with more than one, the name is not decisive and nothing is picked
   * (the customer mark reads those words the same way).
   */
  const byName = (raw: string | null | undefined): string[] => {
    const k = wordsKey(raw);
    if (k.length < 3 || self.has(k)) return [];
    const named = jobs.filter((j) => wordsKey(j.name) === k).map((j) => j.id);
    if (!named.length) return [];
    return [...named, ...jobs.filter((j) => (j.customerNames ?? []).some((c) => wordsKey(c) === k)).map((j) => j.id)];
  };

  const jobNumber = compactKey(marks.jobNumber);
  if (jobNumber.length >= 2 && /\d/.test(jobNumber))
    add("job_number", marks.jobNumber, jobs.filter((j) => compactKey(j.job_number) === jobNumber).map((j) => j.id));

  const po = compactKey(marks.po);
  const poIds: string[] = [];
  if (po.length >= 3 && /\d/.test(po))
    poIds.push(
      ...jobs.filter((j) => compactKey(j.job_number) === po).map((j) => j.id),
      ...pos.filter((x) => x.job_id && compactKey(x.po_number) === po).map((x) => String(x.job_id)),
    );
  poIds.push(...byName(marks.po), ...onStreet(marks.po));
  add("po", marks.po, poIds);

  // The reader's own address, else the street inside its hint.
  const address = marks.address ?? addressInHint(marks.hint);
  add("address", address, onStreet(address));

  add("job_name", marks.jobName, [...byName(marks.jobName), ...onStreet(marks.jobName)]);

  const customer = wordsKey(marks.customer);
  if (customer.length >= 3 && !self.has(customer))
    add(
      "customer",
      marks.customer,
      jobs.filter((j) => (j.customerNames ?? []).some((c) => wordsKey(c) === customer)).map((j) => j.id),
    );

  const decisive = found.filter((f) => f.ids.size === 1);
  if (!decisive.length) return { kind: "none" };
  const pick = [...decisive[0].ids][0];
  const disagree = found.find((f) => !f.ids.has(pick));
  if (disagree) {
    const said = (f: (typeof found)[number]) => `the ${JOB_MARK_WORDS[f.kind]}${f.words ? ` "${f.words}"` : ""}`;
    return {
      kind: "conflict",
      sentence: `The paper points to more than one job (${said(decisive[0])} and ${said(disagree)}), so no job was picked.`,
    };
  }
  return { kind: "one", jobId: pick, from: decisive[0].kind, words: decisive[0].words };
}

/** What a stored row says the paper named: the reader's marks, else (a row read before marks were
 *  kept) the PO and the hint that were. */
export function storedMarks(p: PaperProposal): PaperMarks {
  const m = p.marks && typeof p.marks === "object" ? p.marks : {};
  return { ...m, po: m.po ?? p.po ?? null, hint: m.hint ?? p.jobHint ?? null };
}

/**
 * THE TRAY MATCHES AGAIN, IN MEMORY (2026-09-24). A paper read before the rules learned that a PO
 * box holds the job, or that a street's type can be left off, sat in the tray asking "Where does
 * this go?" with "13897 HERRINGBONE" printed on it. On every load, each waiting paper the paper
 * itself has not already settled (no pick, no conflict said) is matched again from what was
 * stored: the same exact rules, no model call, and NOTHING WRITTEN. The row shows the pick and why,
 * and a person still presses File It. A paper a person has filed, set aside, or that already
 * carries a pick or a conflict is returned as it is.
 */
export function rematchPaper<T extends PaperItem>(
  item: T,
  jobs: readonly MarkJob[],
  pos: readonly MarkPo[] = [],
  selfNames: readonly (string | null | undefined)[] = [],
): T {
  if (item.status && item.status !== "needs_review") return item;
  const p = proposalOf(item);
  if (markedJob(p) || p.jobConflict || p.ced) return item;
  if (!isRead(item)) return item;
  const r = jobFromPaperMarks(storedMarks(p), jobs, pos, selfNames);
  if (r.kind === "none") return item;
  // A job a model wrote before marks existed stays offered, as the guess it always was.
  const guessJobId = p.guessJobId ?? (p.jobId && !p.jobFrom ? p.jobId : null);
  if (r.kind === "conflict") return { ...item, proposal: { ...p, jobId: null, jobFrom: null, guessJobId, jobConflict: r.sentence } };
  return { ...item, proposal: { ...p, jobId: r.jobId, jobFrom: r.from, jobHint: r.words || p.jobHint || null, guessJobId } };
}

/**
 * THE PICKER FOLLOWS THE SUGGESTION UNTIL A PERSON TOUCHES IT. A row renders before its paper is
 * read (Drop Paperwork adds the row, then reads it); a picker seeded once at mount would miss the
 * job the paper names when the read lands. `picked` is null until a person chooses; after that,
 * theirs wins, including choosing nothing.
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
  if (dest.type === "photo") {
    // A JOB PHOTO IS NEVER A COST: only paper that is not one can go on a job's Photos.
    if (r.state === "filed") return "This is already filed. Undo it first to file it somewhere else.";
    if (r.state === "not_read") return "This hasn't been read yet. Press Read Now first.";
    if (r.state === "picture" || r.state === "keep") return null;
    return "This was read as paper, not a picture. File it as it is, or change its type in Fix Details.";
  }
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
  if (dest.type === "job" && isReturnWithoutLines(item)) return RETURN_NEEDS_LINES;
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
