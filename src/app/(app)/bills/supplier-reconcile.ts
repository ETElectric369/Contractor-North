/**
 * WHAT THE SUPPLIER'S OWN BOOKS SAY, AND EVERY DECISION THAT FALLS OUT OF READING THEM
 * (Erik, 2026-09-19; migration 0273).
 *
 * Tonight he got into his CED payment portal and downloaded every document. Forty-seven of them
 * parsed and every one reconciles - the line extensions sum to merchandise, and merchandise plus
 * tax plus shipping equals the total, on all forty invoices. Then the portal said the thing this
 * whole file exists for:
 *
 *     CED says he owes $3,845.14.    The app said $6,476.93.
 *
 * Reconciling the two document by document turned up four separate things, and each one is a
 * function below rather than a paragraph in a card, because a screen that decides things is a
 * screen nobody can test:
 *
 *  · $1,765.72 of invoices he bought SINCE the app started and that were recorded nowhere in it.
 *    $523.47 of that is TTP56, a job about to be invoiced; $186.93 is on Randy's Purple Sage job,
 *    which is already paid and closed, so its profit is overstated by exactly that.
 *  · $29.62 of prompt-pay discount still claimable, and $25.99 already expired unclaimed.
 *  · $60.42 of late-payment interest charged at 1.5% a month, WHILE those discounts sat there.
 *  · CED prints a JOB NAME on every invoice. It is the gift in the whole file - and it is also the
 *    trap, because the same road reads "5659 RHODESIA", "561 RHODESIA", "5661 RHODESIA" and
 *    "5659 RODESSIA", and he has five separate jobs on it.
 *
 * THE MATCHER RANKS AND NEVER PICKS. matchJobName below returns a verdict and an ordered list; it
 * never returns "the answer", and nothing in the card preselects one. That is not caution for its
 * own sake: a wrong pick moves real money onto the wrong job's cost, and the only place the right
 * answer exists is in Erik's head. The app suggests, a person decides.
 *
 * Every number here is rounded to the cent at the point it is summed - the same rule
 * supplier-balance.ts runs on, for the same reason: the card, the section headers and the totals
 * all have to agree to the penny or the screen is arguing with itself.
 */

import {
  r2,
  daysBetweenYmd,
  openBalanceOf,
  type SupplierInvoiceRow as SupplierDocument,
  reversedInvoiceIds,
  reversedPurchaseIds,
} from "./supplier-balance";

// ── WHAT WE HOLD ────────────────────────────────────────────────────────────────────────────────

/** The four kinds migration 0273 allows. A credit memo and a service charge are NOT invoices. */
export type SupplierInvoiceKind = "invoice" | "credit_memo" | "service_charge" | "statement";

/**
 * ONE SUPPLIER DOCUMENT, AS THIS CARD NEEDS IT: exactly the row supplier-balance.ts already
 * defines, with `kind` narrowed to the four migration 0273 allows and two facts added that a
 * balance has no use for and a screen cannot do without.
 *
 * IT EXTENDS RATHER THAN REDECLARES ON PURPOSE. One array of these is handed to both the balance
 * and this card, so there is no second shape to keep in step and no chance of the two screens
 * being fed different rows - the fault that put a $3,034.54 statement on his books as one bill.
 */
export interface SupplierInvoiceRow extends SupplierDocument {
  kind: SupplierInvoiceKind;
  /** The name of the job a PERSON filed it on, resolved by the caller. Null until one does. */
  jobName: string | null;
  /** How many scanned bills are linked to it. Zero means the app has no record of the purchase. */
  billCount: number;
  /**
   * Bills that may be this purchase already (same-purchase.ts, audit v994): the same number, or
   * the same account and job within a few dollars and days. Offered as Same Purchase: Tie Them,
   * never tied by the app. Absent when there are none.
   */
  samePurchase?: { billId: string; exact: boolean; sentence: string }[];
}

/** One of his jobs, with enough on it to tell five Rhodesias apart. */
export interface ReconcileJob {
  id: string;
  jobNumber: string | null;
  name: string;
  status: string | null;
  address: string | null;
}

/** How a job reads in a picker: "J-033 · 5659 Rhodesia · complete · 5659 Rhodesia Rd". Everything
 *  a man needs to tell one 5659 Rhodesia from the next four, in one line. */
export function jobPickerLabel(job: ReconcileJob): string {
  return [job.jobNumber, job.name, sayStatus(job.status), job.address]
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(" · ");
}

/** job.status is a database enum ("to_be_scheduled"); a person reads "to be scheduled". */
function sayStatus(status: string | null | undefined): string {
  return String(status ?? "").replace(/_/g, " ").trim();
}

/**
 * What a document IS, in words, because the difference is money.
 *
 * A SERVICE CHARGE IS INTEREST HE PAID FOR BEING LATE. It arrives in the same list, in the same
 * shape, with a number on it that looks exactly like a purchase - and letting it read as one is
 * how a man pays $60.42 of it in four months without ever noticing. Saying so plainly is the only
 * thing that ever makes it stop.
 */
export function sayKind(kind: SupplierInvoiceKind): string {
  if (kind === "credit_memo") return "Credit memo";
  if (kind === "service_charge") return "Late interest";
  if (kind === "statement") return "Statement";
  return "Invoice";
}

/** A one-line plain-words explanation of the kinds that are not purchases. Null for an invoice,
 *  which needs no explaining. */
export function explainKind(kind: SupplierInvoiceKind): string | null {
  if (kind === "credit_memo") return "Money coming back to you, not money you owe.";
  if (kind === "service_charge") return "Interest for paying late. Not something you bought.";
  if (kind === "statement") return "A month's summary. The invoices on it are listed separately.";
  return null;
}

/** Kinds that can belong to a job. Interest is overhead and a statement is a wrapper around other
 *  documents; filing either onto a job would put a cost there that was never bought there. */
const BELONGS_TO_A_JOB: SupplierInvoiceKind[] = ["invoice", "credit_memo"];

/** Only an invoice is a PURCHASE. A statement double-counts the invoices inside it, and interest
 *  and credits are not things he bought, so none of the three is ever "a bill we are missing". */
const IS_A_PURCHASE: SupplierInvoiceKind[] = ["invoice"];

// ── MODEL B: WHAT THE SUPPLIER SAYS ─────────────────────────────────────────────────────────────
//
// THE FLAW TONIGHT EXPOSED, WRITTEN DOWN SO IT CANNOT COME BACK. The balance shipped as
//
//     Owed = unpaid bills - live payments
//
// which is exactly right while nobody knows which invoices a payment settled. It is WRONG the
// moment the supplier tells you. After the nine fully-settled bills were flipped paid, the app
// read $7,360.93 - $6,000 = $1,360.93 against CED's $3,845.14: his $6,000 of payments is ALREADY
// reflected in what CED calls closed, so subtracting it again counts the same money twice, in the
// other direction.
//
// Two models, never mixed:
//   A. no supplier data  -> unpaid bills minus live payments   (supplier-balance.ts; still right)
//   B. supplier invoices -> the sum of what is still open      (exact, and what CED says)
//
// When B is available it IS the balance, and A is not shown as a second opinion beside it. Two
// numbers for one question is how a man stops trusting both.

export interface SupplierSaysHeadline {
  /** The net of every open document: charges less credits. This is the number CED prints, and it
   *  is `supplierSaysBalance().gross` to the cent - see the test that pins them together. */
  owed: number;
  /** What the open documents add up to before credits come off. */
  charges: number;
  /** Credit memos still open, as a POSITIVE number - what is coming back to him. */
  credits: number;
  /** How many documents are open. Twenty tonight. */
  documents: number;
  /** The newest document date on the account: how fresh this reading is. */
  asOf: string | null;
}

/**
 * WHAT THE SUPPLIER SAYS IS OPEN, SPLIT THE WAY A CARD HAS TO SHOW IT.
 *
 * THE TOTAL IS NOT WORKED OUT AGAIN HERE. Every document is measured with `openBalanceOf` from
 * supplier-balance.ts - the same function `supplierSaysBalance` uses - so `owed` below and the
 * figure on the account card upstairs are one number arrived at one way. Two screens quoting two
 * totals for one question is how a man stops trusting both, and a money screen that argues with
 * the screen above it is the worst thing this app can do.
 *
 * All this adds is the split: charges and the credits coming back to him, named rather than
 * netted out of sight, because a credit memo a man cannot see is a credit memo he never chases.
 */
export function supplierSaysOpen(invoices: SupplierInvoiceRow[]): SupplierSaysHeadline {
  let charges = 0;
  let credits = 0;
  let documents = 0;
  let asOf: string | null = null;
  for (const inv of invoices ?? []) {
    if (inv.closed) continue;
    const amount = openBalanceOf(inv);
    documents += 1;
    if (amount < 0) credits = r2(credits - amount);
    else charges = r2(charges + amount);
    if (inv.invoiceDate && (!asOf || inv.invoiceDate > asOf)) asOf = inv.invoiceDate;
  }
  return { owed: r2(charges - credits), charges, credits, documents, asOf };
}

/** Every open document, newest first, the way the portal lists them. A document with no date
 *  sorts last rather than first: an unknown day is not today. */
export function openDocuments(invoices: SupplierInvoiceRow[]): SupplierInvoiceRow[] {
  return (invoices ?? [])
    .filter((inv) => !inv.closed)
    .sort(
      (a, b) =>
        String(b.invoiceDate ?? "").localeCompare(String(a.invoiceDate ?? "")) ||
        String(b.invoiceNumber).localeCompare(String(a.invoiceNumber)),
    );
}

/**
 * What one open document is holding. `openBalanceOf` and nothing else, so a row in the ledger and
 * the total above it can never be measured two different ways.
 *
 * A STATEMENT IS NOT SPECIAL-CASED HERE. Whether an open statement belongs in a gross is the
 * balance's question, answered once in supplier-balance.ts; every statement on his account came in
 * closed, and a second opinion about it living in this file is exactly how the two cards would
 * come to print two different numbers.
 */
export function documentOpenAmount(inv: SupplierInvoiceRow): number {
  return openBalanceOf(inv);
}

// ── THE PROMPT-PAY DISCOUNT, AND THE INTEREST HE PAID INSTEAD ───────────────────────────────────
//
// "CASH DISCOUNT 11.87 OFF TOTAL DUE IF PAID BY THE 10TH OF THE MONTH FOLLOWING PURCHASE."
//
// It is printed on every CED invoice and nothing in his life has ever read it. $29.62 is still
// claimable by 10 October; $25.99 expired unclaimed; and in the same four months CED charged him
// $60.42 of interest at 1.5% a month. He had the money. Nothing told him what was due.

export type DiscountState = "live" | "expired" | "none";

export interface DiscountReading {
  state: DiscountState;
  amount: number;
  by: string | null;
  /** Days from today until it expires. Negative once it has. Null when there is no date. */
  daysLeft: number | null;
}

/**
 * Where one invoice's discount stands today. A discount on a CLOSED document is over either way -
 * it was taken or it was not, and there is nothing left to decide - so it never reads "live".
 */
export function discountReading(inv: SupplierInvoiceRow, today: string): DiscountReading {
  const amount = r2(Number(inv.discountAmount) || 0);
  if (!(amount > 0.005)) return { state: "none", amount: 0, by: inv.discountBy ?? null, daysLeft: null };
  const by = inv.discountBy ?? null;
  const daysLeft = daysBetweenYmd(today, by);
  // No date on it means nothing can be said about a deadline, and a deadline this app invented
  // would be a figure nobody wrote. It is money, so it is still reported - just never as "live".
  if (inv.closed || !by) return { state: "none", amount, by, daysLeft };
  return { state: daysLeft !== null && daysLeft >= 0 ? "live" : "expired", amount, by, daysLeft };
}

export interface DiscountSlice {
  rows: { invoice: SupplierInvoiceRow; reading: DiscountReading }[];
  total: number;
  /** The soonest deadline in the slice: the day the money starts disappearing. */
  nextDeadline: string | null;
  /** Days until that deadline, against the ORG's today. */
  daysLeft: number | null;
  /**
   * HOW MUCH ACTUALLY RIDES ON THAT DAY, which is not the same as `total` unless every deadline
   * in the slice is the same day. Tonight it happens to be: all seven of his live discounts are
   * due 10 October. Quoting the whole $29.62 against the soonest date would be true tonight and a
   * lie the first time an August invoice sits beside a September one, and a screen that is only
   * accidentally right is a screen that will one day be confidently wrong.
   */
  dueOnNext: number;
}

/**
 * DISCOUNT STILL ON THE TABLE. $25.48 tonight, all of it by 10 October.
 *
 * NOT $29.62, WHICH IS WHAT THE DISCOUNT COLUMN SUMS TO (review, 2026-09-19). The missing $4.14
 * rides on invoice 8802-1107230, which open credit memo 8802-1107337 reverses to the cent - CED
 * does not offer a prompt-pay discount on money it has taken back, and their own headline proves
 * it: $3,845.14 gross less $25.48 is the $3,819.66 the portal prints.
 *
 * `reversedInvoiceIds` is imported from supplier-balance rather than re-derived here, because a
 * second copy of that rule is how this module and the account card came to print two different
 * discounts for one supplier in the first place - which a test caught, and which is the whole
 * reason one reading of a money question lives in one place.
 */
export function claimableDiscounts(invoices: SupplierInvoiceRow[], today: string): DiscountSlice {
  const rows: DiscountSlice["rows"] = [];
  let total = 0;
  let nextDeadline: string | null = null;
  const reversed = reversedInvoiceIds(invoices ?? []);
  for (const invoice of invoices ?? []) {
    if (reversed.has(String((invoice as { id?: unknown })?.id ?? ""))) continue;
    const reading = discountReading(invoice, today);
    if (reading.state !== "live") continue;
    rows.push({ invoice, reading });
    total = r2(total + reading.amount);
    if (reading.by && (!nextDeadline || reading.by < nextDeadline)) nextDeadline = reading.by;
  }
  rows.sort(
    (a, b) =>
      String(a.reading.by ?? "").localeCompare(String(b.reading.by ?? "")) ||
      b.reading.amount - a.reading.amount,
  );
  const dueOnNext = nextDeadline
    ? r2(rows.filter((r) => r.reading.by === nextDeadline).reduce((s, r) => s + r.reading.amount, 0))
    : 0;
  return { rows, total, nextDeadline, daysLeft: daysBetweenYmd(today, nextDeadline), dueOnNext };
}

/**
 * DISCOUNT THAT RAN OUT WHILE THE INVOICE STAYED OPEN. $25.99 across nine documents. Nothing can
 * be done about it and that is exactly why it is on the screen: it is the only honest argument for
 * paying the next seven by the tenth, and a number that never gets shown never changes anything.
 */
export function missedDiscounts(invoices: SupplierInvoiceRow[], today: string): DiscountSlice {
  const rows: DiscountSlice["rows"] = [];
  let total = 0;
  /**
   * AND THE SAME REVERSAL RULE ITS SIBLING RUNS (review, 2026-09-20). `claimableDiscounts` and
   * `supplierSaysBalance` both drop the discount on an invoice a credit memo has cancelled to the
   * cent; this one did not, and it is the function that prints "The Discount You Are Missing".
   *
   * It is dormant only until a deadline passes. The $4.14 on 8802-1107230 is excluded from the
   * money still on the table tonight, and on 11 October - if CED has not yet closed that invoice
   * and its credit memo together, which they only do when he pays the covering statement - it
   * would have walked straight into the missed column instead. A discount on money he was never
   * billed for was never money he could have had, so it is not money he lost, and telling him he
   * lost it is the same invented figure this file was rewritten to stop printing.
   */
  const reversed = reversedInvoiceIds(invoices ?? []);
  for (const invoice of invoices ?? []) {
    if (reversed.has(String((invoice as { id?: unknown })?.id ?? ""))) continue;
    const reading = discountReading(invoice, today);
    if (reading.state !== "expired") continue;
    rows.push({ invoice, reading });
    total = r2(total + reading.amount);
  }
  rows.sort((a, b) => b.reading.amount - a.reading.amount);
  return { rows, total, nextDeadline: null, daysLeft: null, dueOnNext: 0 };
}

export interface InterestReading {
  /** Every late-payment charge CED has raised, settled or not. */
  charged: number;
  /** The slice of it still open, which is the slice he can still be angry about. */
  stillOpen: number;
  documents: number;
}

/** WHAT BEING LATE HAS COST HIM. Named separately from the balance because it is not a purchase,
 *  and because the pair of numbers - interest paid against discount unclaimed - is the whole
 *  argument in one line. */
export function lateInterest(invoices: SupplierInvoiceRow[]): InterestReading {
  let charged = 0;
  let stillOpen = 0;
  let documents = 0;
  for (const inv of invoices ?? []) {
    if (inv.kind !== "service_charge") continue;
    documents += 1;
    charged = r2(charged + (Number(inv.total) || 0));
    if (!inv.closed) stillOpen = r2(stillOpen + documentOpenAmount(inv));
  }
  return { charged, stillOpen, documents };
}

// ── THE JOB NAME, WHICH IS THE GIFT AND THE TRAP ────────────────────────────────────────────────

/**
 * What the matcher concluded, in the only four shapes that are honest:
 *
 *  · "one"   - one job stands clear of the rest. Still a suggestion, still never preselected.
 *  · "ask"   - several are just as close. "235 TIMBER CREEK" is both Tao Zhu jobs; "5659 RODESSIA"
 *              is four separate Rhodesias. A machine picking here is guessing with his job costs.
 *  · "weak"  - nothing looks much like it. "561 RHODESIA" is a house number he has no job at.
 *  · "blank" - there is no job name to go on. CED's copy of invoice 1102291 carries the form's own
 *              header, "CUSTOMER ORDER NO.", where the name should be - $451.75 he cannot place.
 *  · "stock" - CED booked it to STOCK. That is not a job and must never be offered one: it is shop
 *              stock, and putting it on a customer's job would invent a cost that job never had.
 */
export type JobNameVerdict = "one" | "ask" | "weak" | "blank" | "stock";

export interface JobGuess {
  job: ReconcileJob;
  score: number;
}

export interface JobNameMatch {
  verdict: JobNameVerdict;
  /** Every job, best first. ALWAYS every one of them: the ranking is a convenience, never a
   *  filter, because the job he wants may be the one the string does not resemble at all. */
  ranked: JobGuess[];
  /** Why the matcher landed where it did, in plain words, for the line under the picker. */
  because: string;
}

/** Street types carry no information and drift constantly ("85 WHITNEY PLACE" against a job whose
 *  address is 85 Whitney COURT). Dropped from both sides before anything is compared. */
const STREET_TYPES = new Set([
  "RD", "ROAD", "ST", "STREET", "AVE", "AV", "AVENUE", "DR", "DRIVE", "LN", "LANE", "CT", "COURT",
  "PL", "PLACE", "BLVD", "BOULEVARD", "WAY", "TRL", "TRAIL", "CIR", "CIRCLE", "TER", "TERRACE",
  "HWY", "HIGHWAY", "PKWY", "PARKWAY", "LOOP", "RUN",
]);

/** Postal noise on the end of a geocoded address. "USA" and a two-letter state say nothing about
 *  which of five Rhodesias this is. */
const ADDRESS_NOISE = new Set(["USA", "US", "CA", "NV", "N", "S", "E", "W"]);

/** Strings CED prints where a job name should be, that are not job names. The first is the form's
 *  own column header, which their export drops in when the field was left blank. */
const NOT_A_NAME = new Set([
  "CUSTOMER ORDER NO", "CUSTOMER ORDER NUMBER", "CUSTOMER ORDER", "JOB NAME", "JOB",
  "NA", "N A", "NONE", "NO NAME", "MISC",
]);

/** CED's own word for the shelf in his van. Never a job. */
const SHOP_STOCK = new Set(["STOCK", "SHOP", "SHOP STOCK", "TRUCK STOCK", "VAN STOCK", "INVENTORY"]);

/**
 * Split a job-ish string into tokens the way a person reads it, not the way a computer stores it.
 * The letter/digit split is what makes "TTP106" and "TTP 106" and "TTP #106" the same thing.
 */
function tokenize(raw: string): string[] {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/([A-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

interface NameKey {
  /** Letters only, run together: "HERRING BONE" and "HERRINGBONE" both become HERRINGBONE, which
   *  is the entire reason CED's two spellings of one street land on one job. */
  letters: string;
  /** Every number in the string. A zip code is in here too; the leading one is the house. */
  numbers: string[];
  /** The house number - the first number in the string. "TTP 106" makes 106 the house number,
   *  which is right: at Tahoe Tavern the unit number IS which job it is. */
  lead: string | null;
}

function nameKey(raw: string | null | undefined, { address = false } = {}): NameKey {
  const tokens = tokenize(raw ?? "");
  const numbers: string[] = [];
  const words: string[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      // A five-digit zip on a geocoded address is not a house number and must not be compared
      // with one, or every Truckee job would look like every other Truckee job.
      if (address && t.length === 5 && numbers.length > 0) continue;
      numbers.push(t);
      continue;
    }
    if (STREET_TYPES.has(t)) continue;
    if (address && ADDRESS_NOISE.has(t)) continue;
    words.push(t);
  }
  return { letters: words.join(""), numbers, lead: numbers[0] ?? null };
}

/** Levenshtein distance, capped implicitly by the two lengths. Small strings only - a job name is
 *  never long enough for this to matter, and a dependency for twenty lines would be worse. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * How alike two run-together names are, 0 to 1.
 *
 * CONTAINMENT IS WORTH 0.9 AND ONLY ABOVE FOUR LETTERS. "TIMBERCREEK" inside "TIMBERCREEKRENO" is
 * the same place with a city stuck on it. "TTP" inside "TTPGARBAGEDISPOSAL" is three letters
 * inside eighteen, which is how "TTP 106" would have matched a garbage disposal at TTP 11.
 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length >= 4 && long.includes(short)) return 0.9;
  return Math.max(0, 1 - editDistance(a, b) / long.length);
}

/** The house number is worth more than every letter in the street, because a street is shared and
 *  a house is not: "13631 NORTHWOODS" and "13466 Northwoods" are two different jobs on one road,
 *  and the only thing that tells them apart is the number. */
function numberScore(raw: NameKey, cand: NameKey): number {
  if (!raw.lead) return 0;
  if (!cand.numbers.length) return 0;
  if (cand.lead === raw.lead) return 3;
  if (cand.numbers.includes(raw.lead)) return 2;
  // A candidate whose house number is a DIFFERENT number is evidence AGAINST, not the absence of
  // evidence. Without this, every Northwoods job on his book scored the same.
  return -3;
}

/** The gap a front-runner needs before the matcher will call it one. Below this the answer is
 *  "several of these are just as close", which is a true sentence and a useful one. */
const DECISIVE_MARGIN = 0.75;
/** Below this the top of the list is not a guess, it is just the top of the list. */
const WORTH_GUESSING = 3;

/**
 * RANK HIS JOBS AGAINST ONE OF CED'S JOB NAMES. Never picks; never filters.
 *
 * Checked against the real strings off his portal, in supplier-reconcile.test.ts: "13631
 * NORTHWOODS" against a book that also holds 13466 Northwoods, "13897 HARRINGBONE" and "13897
 * HERRING BONE" against 13897 Herringbone, "TTP 106" and "TTP106" against five TTP jobs, "5659
 * RODESSIA" against five Rhodesias (asks), "235 TIMBER CREEK" against both Tao Zhu jobs (asks),
 * and "STOCK", which is offered nothing at all.
 */
/**
 * IS THERE A NAME HERE AT ALL? One rule, used by the matcher and by every screen that shows a raw
 * job name, so a row and the verdict under it can never disagree about whether CED wrote anything.
 *
 * Invoice 1102291 arrived with "CUSTOMER ORDER NO." in the job name field - the form's own column
 * header, which their export drops in when the field was blank. Quoting that back at him as if it
 * meant something is the app handing him its input to decode instead of reading it for him.
 */
export function isUsableJobName(raw: string | null | undefined): boolean {
  const cleaned = tokenize(raw ?? "").join(" ");
  return !!cleaned && !NOT_A_NAME.has(cleaned);
}

export function matchJobName(raw: string | null | undefined, jobs: ReconcileJob[]): JobNameMatch {
  const cleaned = tokenize(raw ?? "").join(" ");
  const all = jobs ?? [];

  if (SHOP_STOCK.has(cleaned)) {
    return {
      verdict: "stock",
      ranked: [],
      because: "CED booked this to shop stock, not to a job.",
    };
  }
  if (!isUsableJobName(raw)) {
    return {
      verdict: "blank",
      // Nothing to rank on, so the order is his jobs as they were handed over. The caller sorts
      // them the way the rest of the app does; inventing an order here would look like a guess.
      ranked: all.map((job) => ({ job, score: 0 })),
      because: "CED's copy has no job name on it, so there is nothing to go on but your own memory.",
    };
  }

  const key = nameKey(raw);
  const ranked = all
    .map((job) => {
      const byName = nameKey(job.name);
      const byAddress = nameKey(job.address, { address: true });
      // The name is his word for the job and the address is a geocoder's, so a name match counts
      // slightly more. Numbers are taken from both together: "Tao Zhu" carries its house number
      // only in its address, and dropping that would lose the one fact that places it.
      const words = Math.max(similarity(key.letters, byName.letters), similarity(key.letters, byAddress.letters) * 0.95);
      const merged: NameKey = {
        letters: byName.letters,
        numbers: [...byName.numbers, ...byAddress.numbers],
        lead: byName.lead ?? byAddress.lead,
      };
      return { job, score: r2(words * 4 + numberScore(key, merged)) };
    })
    .sort((a, b) => b.score - a.score || a.job.name.localeCompare(b.job.name));

  const top = ranked[0]?.score ?? 0;
  const second = ranked[1]?.score ?? -Infinity;

  if (top < WORTH_GUESSING) {
    return {
      verdict: "weak",
      ranked,
      because: `Nothing on your job list looks much like "${cleaned}". The closest are first.`,
    };
  }
  if (top - second < DECISIVE_MARGIN) {
    const close = ranked.filter((g) => top - g.score < DECISIVE_MARGIN).length;
    return {
      verdict: "ask",
      ranked,
      because: `${close} of your jobs match "${cleaned}" just as well. Only you know which one it was.`,
    };
  }
  return {
    verdict: "one",
    ranked,
    because: `"${cleaned}" looks like ${ranked[0].job.name}. Check it before you file it.`,
  };
}

// ── THE THREE THINGS THAT NEED HIM ──────────────────────────────────────────────────────────────

export interface NeedsJobRow {
  invoice: SupplierInvoiceRow;
  match: JobNameMatch;
}

/**
 * INVOICES CED PLACED AND THE APP HAS NOT. Every one of them is a cost sitting on no job.
 *
 * Interest and statements are never in here: neither was bought on a job, so a picker on one could
 * only put a cost somewhere it was never spent. Shop stock is in here, with no picker and a plain
 * sentence, because leaving it off the list entirely would be the app quietly deciding something.
 *
 * Ordered by the money, biggest first. A $1,062.18 invoice on the wrong job moves a margin; a
 * $2.30 one does not, and he is reading this on a phone.
 */
export function invoicesNeedingJob(invoices: SupplierInvoiceRow[], jobs: ReconcileJob[]): NeedsJobRow[] {
  return (invoices ?? [])
    .filter((inv) => !inv.jobId && BELONGS_TO_A_JOB.includes(inv.kind))
    .map((invoice) => ({ invoice, match: matchJobName(invoice.jobNameRaw, jobs) }))
    .sort(
      (a, b) =>
        Math.abs(Number(b.invoice.total) || 0) - Math.abs(Number(a.invoice.total) || 0) ||
        String(b.invoice.invoiceDate ?? "").localeCompare(String(a.invoice.invoiceDate ?? "")),
    );
}

/** What the "needs a job" pile adds up to, and how much of it the matcher will not decide. */
export function needsJobTotals(rows: NeedsJobRow[]): {
  rows: number;
  total: number;
  /** Rows where several jobs are equally close, or none is. These are the ones that cost him time. */
  undecided: number;
  /** Rows CED booked to shop stock, which are never offered a job. */
  stock: number;
  stockTotal: number;
} {
  let total = 0;
  let undecided = 0;
  let stock = 0;
  let stockTotal = 0;
  for (const row of rows ?? []) {
    total = r2(total + (Number(row.invoice.total) || 0));
    if (row.match.verdict === "stock") {
      stock += 1;
      stockTotal = r2(stockTotal + (Number(row.invoice.total) || 0));
      continue;
    }
    if (row.match.verdict !== "one") undecided += 1;
  }
  return { rows: (rows ?? []).length, total, undecided, stock, stockTotal };
}

export interface NeedsBillSlice {
  rows: SupplierInvoiceRow[];
  total: number;
  /** The slice CED has already SETTLED. $1,765.72 tonight - money that left his account, that no
   *  job ever saw, and that nothing anywhere will ever surface again on its own. */
  settledTotal: number;
  settledRows: number;
  /** The slice still open. It is in the balance, so he will see it when he pays - but the job it
   *  was bought for still does not know about it. */
  openTotal: number;
  openRows: number;
  /** Documents older than the day his records start, left off the list on purpose. */
  olderRows: number;
  olderTotal: number;
  /** Purchases a credit memo has already taken straight back off the account: the wrong-colour
   *  return. They are NOT missing from his books, they are cancelled, and a bill for one would put
   *  merchandise he sent back onto a customer's job. Counted so the money does not vanish off the
   *  screen unexplained. */
  reversedRows: number;
  reversedTotal: number;
  /** The day his records start, echoed back so the card can say what it left out. */
  since: string | null;
}

/**
 * PURCHASES THE APP HAS NO RECORD OF. A supplier invoice with no scanned bill against it.
 *
 * $523.47 of this is TTP56, on a job about to be invoiced - bill that job now and it goes out
 * $523.47 light. $186.93 is on Randy's Purple Sage, which is already paid and closed, so its
 * profit has been overstated by exactly that since June.
 *
 * `since` IS NOT A FILTER FOR TIDINESS. The app cannot have recorded a purchase made before its
 * own first bill, so those documents carry no fault and offer nothing to do; they are counted and
 * named as a leftover rather than dropped, because money that disappears off a screen is the thing
 * that makes a man stop trusting it. Pass null to list every one.
 */
export function invoicesNeedingBill(
  invoices: SupplierInvoiceRow[],
  opts: { since?: string | null } = {},
): NeedsBillSlice {
  const since = opts.since ?? null;
  const rows: SupplierInvoiceRow[] = [];
  let total = 0;
  let settledTotal = 0;
  let settledRows = 0;
  let openTotal = 0;
  let openRows = 0;
  let olderRows = 0;
  let olderTotal = 0;
  let reversedRows = 0;
  let reversedTotal = 0;

  /**
   * A RETURN IS NOT A MISSING BILL (2026-09-19, wiring "Record It As A Bill").
   *
   * Erik ordered five light almond USB receptacles on 8802-1107230, sent them back, and CED wrote
   * 8802-1107337 to take the $225.47 straight off again: "skip the returns for the wrong color".
   * Both documents are open, both name TTP 106, and the invoice had no bill against it - so the
   * moment the Record button was wired, this list offered to put $225.47 of merchandise he does
   * not have onto his customer's job, one tap, with a credit memo sitting beside it saying so.
   *
   * It pairs on the TOTAL rather than the open balance (reversedPurchaseIds, exported from
   * supplier-balance so there is ONE rule and not three copies of it), because "did he keep what
   * was on this invoice?" is not a question that expires. The balance's own rule only looks at
   * OPEN documents - correctly, since a settled pair owes nothing - and the day Erik pays the
   * September statement CED closes both of these, that rule stops matching, and the return would
   * walk back onto this list with a live button on it.
   */
  const reversed = reversedPurchaseIds(invoices ?? []);

  for (const inv of invoices ?? []) {
    if (!IS_A_PURCHASE.includes(inv.kind)) continue;
    if ((Number(inv.billCount) || 0) > 0) continue;
    const amount = r2(Number(inv.total) || 0);
    if (reversed.has(String(inv.id))) {
      reversedRows += 1;
      reversedTotal = r2(reversedTotal + amount);
      continue;
    }
    // No date on it cannot be ruled out of a date window - it is kept, because "we do not know
    // when" is not a reason to stop counting money.
    if (since && inv.invoiceDate && inv.invoiceDate < since) {
      olderRows += 1;
      olderTotal = r2(olderTotal + amount);
      continue;
    }
    rows.push(inv);
    total = r2(total + amount);
    if (inv.closed) {
      settledRows += 1;
      settledTotal = r2(settledTotal + amount);
    } else {
      openRows += 1;
      openTotal = r2(openTotal + amount);
    }
  }

  // Settled first: that is the slice nothing else on the screen will ever mention again. Then by
  // money, because the biggest wrong job cost is the one worth his next two minutes.
  rows.sort(
    (a, b) =>
      Number(b.closed) - Number(a.closed) ||
      (Number(b.total) || 0) - (Number(a.total) || 0),
  );
  return { rows, total, settledTotal, settledRows, openTotal, openRows, olderRows, olderTotal, reversedRows, reversedTotal, since };
}

// ── WHAT THE ACCOUNT CARD SAYS, AND WHICH MODEL IT CAME FROM ────────────────────────────────────

export interface ReconcileSummary {
  says: SupplierSaysHeadline;
  needsJob: { rows: number; total: number; undecided: number };
  needsBill: { rows: number; settledTotal: number; total: number };
  claimable: { total: number; by: string | null; daysLeft: number | null; dueOnNext: number };
  missed: number;
  interest: InterestReading;
  /** True when anything at all on this account is waiting on him. */
  anyOpenQuestions: boolean;
}

/**
 * EVERYTHING THE ACCOUNT CARD NEEDS IN ONE READ, so the small card upstairs and the long card
 * downstairs can never disagree about how many things are waiting. One function, one set of
 * numbers - the rule supplierBalance() is built on, one room over.
 */
export function reconcileSummary(
  invoices: SupplierInvoiceRow[],
  jobs: ReconcileJob[],
  today: string,
  opts: { since?: string | null } = {},
): ReconcileSummary {
  const needsJobRows = invoicesNeedingJob(invoices, jobs);
  const jobTotals = needsJobTotals(needsJobRows);
  const bill = invoicesNeedingBill(invoices, opts);
  const claim = claimableDiscounts(invoices, today);
  const miss = missedDiscounts(invoices, today);
  return {
    says: supplierSaysOpen(invoices),
    needsJob: { rows: jobTotals.rows, total: jobTotals.total, undecided: jobTotals.undecided },
    needsBill: { rows: bill.rows.length, settledTotal: bill.settledTotal, total: bill.total },
    claimable: { total: claim.total, by: claim.nextDeadline, daysLeft: claim.daysLeft, dueOnNext: claim.dueOnNext },
    missed: miss.total,
    interest: lateInterest(invoices),
    anyOpenQuestions: jobTotals.rows > 0 || bill.rows.length > 0 || claim.total > 0.005,
  };
}

/**
 * EVERYTHING ONE ACCOUNT'S RECONCILE CARD IS FED, in one prop, so the page hands it over as a
 * single object and the supplier card below never has to assemble anything.
 */
export interface SupplierReconcileFeed {
  /** Every document the supplier issued on this account: open, settled, all four kinds. */
  invoices: SupplierInvoiceRow[];
  /** His jobs, for the picker. Enough on each to tell five Rhodesias apart. */
  jobs: ReconcileJob[];
  /**
   * The day this app's records begin - its earliest scanned bill. Purchases the supplier made
   * before it are counted and named, never nagged about: the app could not have recorded them.
   * Null lists every one of them instead.
   */
  recordsSince: string | null;
}
