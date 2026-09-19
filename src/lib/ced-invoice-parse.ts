/**
 * READING CED'S OWN INVOICE, SO NEXT MONTH HE DOES NOT NEED ME (Erik, 2026-09-19; migration 0273).
 *
 * Tonight Erik got into his CED payment portal (Billtrust) and downloaded every document on the
 * account. Forty-seven PDFs. Reconciling them against his books, document by document, is what
 * produced 0273 - and what it found was that the app had been confidently wrong about money:
 *
 *     CED says he owes $3,845.14.   The app said $6,476.93.
 *
 * $5,421.55 of "unpaid" bills had been settled weeks ago. $1,765.72 of purchases were recorded
 * nowhere at all. Two of his "bills" were never bills, they were STATEMENTS covering two invoices
 * each. And $29.62 of prompt-pay discount is still claimable while $60.42 of 1.5%-a-month interest
 * was paid on the same account, because nothing ever told him what was due or when it stopped
 * being cheap.
 *
 * I read those forty-seven by hand. This file is so that nobody has to again: it turns the TEXT of
 * a CED invoice PDF into the rows migration 0273 holds.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * THE SELF-CHECK IS THE ENTIRE POINT.
 *
 * A parser that half-reads an invoice does not produce a small error, it produces a WRONG BALANCE
 * HE TRUSTS - which is the exact failure this whole wave exists to undo. So every document has to
 * survive two sums that CED's own arithmetic guarantees:
 *
 *     1. the line extensions add up to MERCHANDISE
 *     2. MERCHANDISE + SALES TAX + SHIPPING CHARGE equals TOTAL DUE
 *
 * All forty of his itemised invoices pass both, to the cent. A document that fails comes back as a
 * REFUSAL that names which check failed and what it read, never as a half-filled row. Refusing is
 * cheap: he pastes it again, or types that one in. A silently wrong total is not.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO TRAPS IN THE LAYOUT, both of which cost me an hour tonight.
 *
 * FIRST, THE TOTALS BLOCK IS STACKED: LABELS, THEN VALUES. The text of a real invoice reads
 *
 *     MERCHANDISE / SALES TAX 9.00000 / SHIPPING CHARGE / 916.30 / 82.47 / 0.00 / TOTAL DUE 998.77
 *
 * A regex that expects a number after the word MERCHANDISE returns null on every single invoice he
 * owns. The values are collected as a RUN after the labels, and the sales-tax RATE is told apart
 * from money by its five decimal places (9.00000, and once 8.26500) against money's two.
 *
 * SECOND, THE LINE ITEMS ARE COLUMN-WISE, NOT ROW-WISE. Not "qty, code, description, price" per
 * line; a whole run of quantities, then a whole run of product codes, then the part numbers, then
 * the descriptions, then shipped quantities, then prices, then the per-unit letters, then the
 * extensions. They are zipped back together by index.
 *
 * AND `per_unit` IS NOT DECORATION. CED prices in E (each), C (per hundred) and M (per thousand):
 * 55 feet of 6/3 at $4,321.03 per M is $237.66. Read that 4321.03 as a unit price and a four
 * thousand dollar reel of wire lands on a homeowner's bill. The letter is carried, and where the
 * letters do not line up with the rows the divisor is recovered from the arithmetic instead of
 * guessed.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT COUNTS AS "THE TEXT". One printed line per line of text - what a PDF text extractor gives
 * you, and what pasting an invoice out of a PDF viewer gives you. Every label is matched across
 * line breaks and every column is read as TOKENS rather than lines, because the same invoice comes
 * out differently from different extractors: with one line item CED puts the price and its unit
 * letter on one line ("-85.11 E"), with five it puts them in two separate runs. An extractor that
 * explodes every word onto its own line still reads correctly for the money; only the descriptions
 * degrade, and they degrade to null rather than to the wrong part on the wrong line.
 *
 * NOTHING HERE TOUCHES A DATABASE and nothing here decides anything. It reports what the document
 * says. Whether that closes a bill, and which job it belongs to, are decisions with a person on
 * the end of them - see supplier-import-actions.ts, and see the header of 0273 for why the JOB
 * NAME is stored raw: his same road is "5659 RHODESIA", "561 RHODESIA", "5661 RHODESIA" and
 * "5659 RODESSIA", and he has five jobs on it.
 */

/** E = each, C = per hundred, M = per thousand. CED's own pricing unit, printed beside the price. */
export type CedPerUnit = "E" | "C" | "M";

/** What one unit letter divides the printed price by. */
const PER_UNIT_DIVISOR: Record<CedPerUnit, number> = { E: 1, C: 100, M: 1000 };

export interface CedInvoiceLine {
  /** CED's short code: CPL, PVC, LUT. Null when the column did not line up with the rows. */
  productCode: string | null;
  /** The manufacturer's number: RL56LS9FSD2W1EWH. */
  partNumber: string | null;
  description: string | null;
  /** QTY SHIPPED, which is what the extension is actually computed from. See the comment below. */
  quantity: number;
  /** The printed price, PER `perUnit` - not per piece. 4321.03 M is $4.32 a foot. */
  unitPrice: number;
  perUnit: CedPerUnit;
  /** What this row adds to MERCHANDISE. The number every check in this file is anchored on. */
  extension: number;
  sortOrder: number;
}

export interface CedInvoice {
  /** The supplier's own number, branch and all: "8802-1103832". */
  invoiceNumber: string;
  kind: "invoice" | "credit_memo" | "service_charge";
  /** "YYYY-MM-DD", or null when the document did not print one. */
  invoiceDate: string | null;
  /** TR-34426. The number on the statement, which is what a supplier account is really keyed on. */
  accountNumber: string | null;
  accountName: string | null;
  /** CED's JOB NAME, verbatim, before anybody interprets it. */
  jobNameRaw: string | null;
  /** CUSTOMER ORDER NO., which on his invoices is usually the job name again. */
  customerOrderRaw: string | null;
  merchandise: number | null;
  tax: number | null;
  shipping: number | null;
  total: number;
  /** "CASH DISCOUNT 11.87 OFF TOTAL DUE IF PAID BY THE 10TH OF THE MONTH FOLLOWING PURCHASE." */
  discountAmount: number | null;
  /** The day that discount stops being available: the 10th of the month after the invoice date. */
  discountBy: string | null;
  /**
   * The document stamps "***PAID IN FULL***" across its own header. That is the SUPPLIER saying
   * it, which is the only voice that can settle one of these - see 0273's header.
   */
  paidInFull: boolean;
  lines: CedInvoiceLine[];
}

export type CedParseResult =
  | { ok: true; invoice: CedInvoice }
  /** A refusal always names the check that failed, and carries the number when it got that far, so
   *  the import screen can say WHICH document it would not read rather than "some of them". */
  | { ok: false; invoiceNumber: string | null; error: string };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SMALL PARTS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Money, to the cent, as an integer count of cents. Every comparison in this file happens here:
 *  0.1 + 0.2 is not 0.3 in a float, and an invoice that reconciles must not fail on that. */
const cents = (n: number): number => Math.round(n * 100);
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Money as CED prints it. Exactly two decimals, which is also how it is told apart from the
 *  sales-tax RATE (9.00000, once 8.26500) and from the DISC column (1.0, 2.0, 0.0).
 *
 *  THE THOUSANDS SEPARATOR IS OPTIONAL AND THAT IS NOT A DETAIL. CED groups the TOTALS
 *  ("2,558.98") and does not group the line PRICES ("1239.20" for 6/3 wire per thousand feet). A
 *  pattern that required the comma read four of his five lines on invoice 1101363 and refused the
 *  fifth, which is how twenty-two of sixty-four documents came back unreadable on the first pass. */
const MONEY = /^-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}-?$/;
const NUMBER = /^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$/;

function toMoney(token: string): number | null {
  const raw = token.trim();
  if (!MONEY.test(raw)) return null;
  // A trailing minus is how some accounting printers write a credit. Either end means negative.
  const negative = raw.startsWith("-") || raw.endsWith("-");
  const digits = raw.replace(/[-$,]/g, "");
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function toNumber(token: string): number | null {
  const raw = token.trim();
  if (!NUMBER.test(raw)) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** MM/DD/YYYY as CED prints it, to the "YYYY-MM-DD" wall-calendar day the database stores.
 *  Never a timestamp and never a Date: an invoice happened on a DAY, and every date in this app
 *  that went through a Date object at midnight has landed a day early in Pacific at least once. */
function toIsoDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * THE 10TH OF THE MONTH FOLLOWING PURCHASE, worked out from the invoice date rather than trusted
 * from the page, because CED prints the deadline in words and only the amount in figures. This is
 * the date that makes the discount real: $29.62 of his is still claimable by 10 October and
 * $25.99 expired unclaimed, and he paid $60.42 of interest in between.
 */
function tenthOfFollowingMonth(invoiceDate: string | null): string | null {
  if (!invoiceDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(invoiceDate);
  if (!m) return null;
  let year = Number(m[1]);
  let month = Number(m[2]) + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return `${year}-${String(month).padStart(2, "0")}-10`;
}

/** The text as lines, with the blanks dropped and every run of spaces squeezed. Keeping the line
 *  structure is what makes a description readable; squeezing the spaces is what makes a label
 *  matchable whatever the extractor did with the gaps between columns. */
function toLines(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n|\f/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

/**
 * FIND A LABEL THAT MAY BE SPREAD OVER SEVERAL LINES. "QTY ORDERED" is two printed lines. One
 * extractor gives "INVOICE NO." on one line, another gives "INVOICE" and "NO." on two. A window of
 * up to six lines is joined and tested, so the same pattern finds the label either way.
 *
 * THE LABEL MUST BEGIN ON THE WINDOW'S FIRST LINE, and that one rule is the whole reason this
 * function is not three lines long. Every pattern here ends at the label, so without it a window
 * is free to swallow whatever came before: searching for PRODUCT CODE found the window
 * "4 6 PRODUCT CODE" starting at a QUANTITY, which cut the quantity run short, which zipped three
 * rows out of five, which failed the merchandise check on all sixty-four of his documents at once.
 * A parser that reads the invoice off by one row is exactly the confident wrongness this file
 * exists to refuse, so the boundary is enforced here rather than hoped for.
 *
 * Returns where the label starts and the first line AFTER it, or null.
 */
function findLabel(lines: string[], pattern: RegExp, from = 0): { start: number; after: number } | null {
  for (let i = Math.max(0, from); i < lines.length; i++) {
    let joined = "";
    for (let w = 0; w < 6 && i + w < lines.length; w++) {
      joined = w === 0 ? lines[i] : `${joined} ${lines[i + w]}`;
      const hit = pattern.exec(joined);
      if (!hit) continue;
      // The patterns allow one leading space (a label can follow a stamp on its own line, as in
      // "***PAID IN FULL*** INVOICE NO."), so step over it before asking where the label begins.
      const labelStart = hit.index === 0 ? 0 : hit.index + 1;
      if (labelStart < lines[i].length) return { start: i, after: i + w + 1 };
    }
  }
  return null;
}

/**
 * The VALUE that follows a label, gathered until the next label arrives. Gathering rather than
 * taking one line is what lets "235 TIMBER CREEK" survive an extractor that puts each word on its
 * own line, while still stopping dead at "CUSTOMER ORDER NO." on one that does not.
 */
function valueAfter(lines: string[], from: number, stop: RegExp, maxLines = 8): string | null {
  let joined = "";
  for (let i = from; i < lines.length && i < from + maxLines; i++) {
    const next = joined ? `${joined} ${lines[i]}` : lines[i];
    const hit = stop.exec(next);
    if (hit) {
      joined = next.slice(0, hit.index).trim();
      break;
    }
    joined = next;
  }
  joined = joined.trim();
  return joined.length ? joined : null;
}

/** Every whitespace-separated token in a slice of lines, in reading order. Columns are read as
 *  tokens because CED merges them onto one line when an invoice has a single item ("-85.11 E")
 *  and splits them into runs when it has five. */
function tokensOf(lines: string[], start: number, end: number): string[] {
  return lines
    .slice(Math.max(0, start), Math.max(0, end))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SPLITTING A DOWNLOAD INTO DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** 8802-1101363, and the bare form some templates print. */
const INVOICE_NUMBER = /^\d{3,6}-\d{4,9}$|^\d{6,9}$/;

/**
 * The heading, with the number allowed to sit on the same line as well as on the next one. CED's
 * own PDFs put it on the next line, every time, on all sixty-four documents - but which of the two
 * you get is the EXTRACTOR's choice, not the document's, and a heading that failed to match would
 * lose a whole invoice in silence rather than refuse one out loud.
 *
 * "PLEASE SHOW INVOICE NO. AND REMIT TO:" is on every page and is not a document. It survives this
 * pattern (nothing ends there) and would be caught anyway by the rule below: an anchor only counts
 * when a real invoice number follows it.
 */
const DOC_ANCHOR = /(?:^|\s)(?:INVOICE|CREDIT\s+MEMO)\s+NO\.(?:\s+\S+)?$/i;

/**
 * WHERE EACH DOCUMENT STARTS. One downloaded PDF is very often several invoices - his 07-11 file
 * holds four - so the anchor is the header field, not the file.
 *
 * TWO THINGS MAKE A NAIVE SPLIT WRONG, and both are in his own downloads:
 *
 *   * every page also carries "PLEASE SHOW INVOICE NO. AND REMIT TO:", which contains the anchor
 *     phrase. An anchor only counts when an actual invoice NUMBER follows it, which that one has
 *     never got.
 *   * a two-page invoice repeats the whole header on page 2 with the SAME number, puts its line
 *     items across both pages and its totals only on the last. Splitting there would produce one
 *     chunk with no totals block and one with half the items. Consecutive pages carrying the same
 *     invoice number are therefore joined back into one document before anything is read.
 */
function splitDocuments(lines: string[]): { invoiceNumber: string; pages: string[][] }[] {
  const starts: { at: number; number: string }[] = [];
  let cursor = 0;
  for (;;) {
    const hit = findLabel(lines, DOC_ANCHOR, cursor);
    if (!hit) break;
    cursor = hit.after;
    // The number is the last token of the heading's own window when they share a line, and the
    // first token of the line after it when they do not.
    const tail = lines[hit.after - 1]?.split(/\s+/).pop() ?? "";
    const candidate = INVOICE_NUMBER.test(tail) ? tail : lines[hit.after]?.split(/\s+/)[0] ?? "";
    if (!INVOICE_NUMBER.test(candidate)) continue; // "PLEASE SHOW INVOICE NO. AND REMIT TO:"
    starts.push({ at: hit.start, number: candidate });
  }
  if (!starts.length) return [];

  // WHERE EACH PAGE BEGINS, WORKED OUT FOR ALL OF THEM BEFORE ANY SLICING. Taking the next
  // document's raw anchor as this one's end undoes the whole walk-back below: the next page's
  // header - its "(*** CREDIT MEMO ***)" included - stays inside this document's text. That is
  // exactly how his 01-14 download came back with a $217.46 INVOICE called a credit memo.
  const pageStarts: number[] = starts.map((start, i) => {
    if (i === 0) return 0;
    const previousStart = starts[i - 1].at;
    for (let b = start.at - 1; b > previousStart; b--) {
      if (/FOLLOWING\s+PURCHASE/i.test(lines[b]) || /^Page\s+\d+\s+of\s+\d+$/i.test(lines[b])) return b + 1;
    }
    return start.at;
  });

  const docs: { invoiceNumber: string; pages: string[][] }[] = [];
  for (let i = 0; i < starts.length; i++) {
    // A DOCUMENT STARTS AT ITS PAGE, NOT AT ITS INVOICE NUMBER. CED stamps
    // "CED - TRUCKEE (*** CREDIT MEMO ***)" across the top of the page, a dozen lines ABOVE
    // "INVOICE NO." - so a chunk that began at the number left that stamp sitting in the tail of
    // the PREVIOUS document, and his 01-14 download came back with the $217.46 invoice called a
    // credit memo and the -$92.77 credit memo called an invoice. Both wrong, in opposite
    // directions, on the same page.
    //
    // The page boundary is walked back to rather than guessed at, and it stops at the last line of
    // the previous page - its "CASH DISCOUNT ... OF THE MONTH FOLLOWING PURCHASE", or its
    // "Page 1 of 1" when the discount block is absent. Walking back a FIXED number of lines would
    // have dragged the previous invoice's cash discount into this one's, which is a wrong figure
    // about money rather than a wrong word.
    const from = pageStarts[i];
    const to = i + 1 < starts.length ? pageStarts[i + 1] : lines.length;
    const page = lines.slice(from, to);
    const previous = docs[docs.length - 1];
    // Page 2 of the same invoice: another PAGE of the same document, kept as its own page rather
    // than poured into one list. Each page carries its own set of column runs, and reading two
    // pages' runs as one is how his 16-line invoice 1080836 came out $7.94 short of its own
    // merchandise figure.
    if (previous && previous.invoiceNumber === starts[i].number) previous.pages.push(page);
    else docs.push({ invoiceNumber: starts[i].number, pages: [page] });
  }
  return docs;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE LINE ITEMS
// ─────────────────────────────────────────────────────────────────────────────────────────────

const H_QTY_ORDERED = /(?:^|\s)QTY\s+ORDERED$/i;
const H_PRODUCT_CODE = /(?:^|\s)PRODUCT\s+CODE$/i;
const H_DESCRIPTION = /(?:^|\s)DESCRIPTION$/i;
const H_QTY_SHIPPED = /(?:^|\s)QTY\s+SHIPPED$/i;
const H_PRICE = /(?:^|\s)PRICE$/i;
const H_EXTENSION = /(?:^|\s)EXTENSION$/i;

/** Where the totals block begins: a line that is the single word MERCHANDISE. The boilerplate
 *  further down says "MERCHANDISE RETURNED WITHOUT OUR CONSENT..." and "TITLE TO MERCHANDISE...",
 *  which is why this is an exact line and why it is only ever looked for AFTER the items. */
function findTotalsStart(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) if (/^MERCHANDISE$/i.test(lines[i])) return i;
  return -1;
}

/**
 * Where the totals block ENDS. This one is anchored at the START of its window, unlike every other
 * label here, and that difference is a bug I had to find twice: `findLabel` reports where its
 * WINDOW begins, so a pattern matched loosely three lines into a window put "TOTAL DUE" back at
 * "SALES TAX" and left the values block empty. Every invoice refused, all sixty-four of them, with
 * the message about the totals not being readable - which is at least the right kind of failure.
 *
 * The same words appear again further down in "CASH DISCOUNT 1.38 OFF TOTAL DUE IF PAID BY..."
 * That line does not START with them, and this is looked for from MERCHANDISE forward anyway, so
 * the first hit is always the real one.
 */
function findTotalDue(lines: string[], from: number): { start: number } | null {
  for (let i = Math.max(0, from); i < lines.length; i++) {
    for (let w = 0; w < 3 && i + w < lines.length; w++) {
      if (/^TOTAL\s+DUE\b/i.test(lines.slice(i, i + w + 1).join(" "))) return { start: i };
    }
  }
  return null;
}

/**
 * Zip the columns back into rows.
 *
 * `n` - how many rows there are - comes from the QTY ORDERED run, which is the one column that is
 * always present and always one entry per row. Every other run is checked against it, and a run
 * that does not match is DROPPED TO NULL rather than zipped by force: a description one row out of
 * step puts the wrong part on the wrong job, and a quiet wrong answer is worse than a blank.
 */
function readLines(doc: string[], itemsFrom: number, totalsAt: number): CedInvoiceLine[] | { error: string } | null {
  const end = totalsAt >= 0 ? totalsAt : doc.length;
  const qtyOrdered = findLabel(doc, H_QTY_ORDERED, itemsFrom);
  // A PAGE WITH NO ITEM TABLE AT ALL CONTRIBUTES NOTHING, which is different from a page whose
  // table would not read. Null is "there was nothing here"; an error is "there was something here
  // and I could not trust it". The caller refuses on the second and on a document that ends up
  // with no rows anywhere.
  if (!qtyOrdered) return null;
  const productCode = findLabel(doc, H_PRODUCT_CODE, qtyOrdered?.after ?? itemsFrom);
  const description = findLabel(doc, H_DESCRIPTION, productCode?.after ?? itemsFrom);
  const qtyShipped = findLabel(doc, H_QTY_SHIPPED, description?.after ?? itemsFrom);
  const price = findLabel(doc, H_PRICE, qtyShipped?.after ?? itemsFrom);
  const extension = findLabel(doc, H_EXTENSION, price?.after ?? itemsFrom);
  if (!productCode || !qtyShipped || !price || !extension) {
    return { error: "the line item columns are not laid out the way a CED invoice lays them out" };
  }

  const orderedTokens = tokensOf(doc, qtyOrdered.after, productCode.start).filter((t) => NUMBER.test(t));
  const n = orderedTokens.length;
  if (!n) return { error: "no line items were found under QTY ORDERED" };

  // PRODUCT CODES AND PART NUMBERS ARE READ AS LINES, NOT TOKENS, and that is not a style choice:
  // a part number can contain a space. "ELL2 45D" and "ELL2 22-1/2D" are single part numbers on
  // his 235 Timber Creek invoice, and counting tokens made twelve entries out of ten, which lined
  // up with nothing and dropped both columns to null on every invoice carrying an elbow.
  const codeLines = doc.slice(productCode.after, description?.start ?? qtyShipped.start).filter((l) => l.length > 0);
  const descriptionLines = description
    ? doc.slice(description.after, qtyShipped.start).filter((l) => l.length > 0)
    : [];
  const shippedTokens = tokensOf(doc, qtyShipped.after, price.start).filter((t) => NUMBER.test(t));
  const priceTokens = tokensOf(doc, price.after, extension.start);
  const extensionTokens = tokensOf(doc, extension.after, end);

  // PRODUCT CODE and PART NUMBER share one printed column heading: the codes run first, then the
  // part numbers. Two full runs or nothing - half a run means the columns are not what we think.
  const codes = codeLines.length === 2 * n ? codeLines.slice(0, n) : null;
  const parts =
    codeLines.length === 2 * n ? codeLines.slice(n) : codeLines.length === n ? codeLines : null;
  const descriptions = descriptionLines.length === n ? descriptionLines : null;

  // Prices, then the unit letters. Money is told from the letters by shape, so a merged
  // "-85.11 E" and a pair of separate runs both read the same.
  const prices = priceTokens.map(toMoney).filter((v): v is number => v !== null);
  const units = priceTokens
    .map((t) => t.replace(/[^ECM]/gi, ""))
    .filter((t) => /^[ECM]$/i.test(t))
    .map((t) => t.toUpperCase() as CedPerUnit);
  if (prices.length < n) return { error: `only ${prices.length} of ${n} line prices could be read` };

  // The extensions are the FIRST n money-shaped tokens after the heading. What follows them is the
  // DISC column (1.0, 2.0, 0.0 - one decimal, not money) and the tax-code letters, and on a credit
  // memo an "ORIGINAL INVOICE(S): 1092066" as well. None of those can be mistaken for money.
  const extensions: number[] = [];
  for (const token of extensionTokens) {
    const value = toMoney(token);
    if (value !== null) extensions.push(value);
    if (extensions.length === n) break;
  }
  if (extensions.length < n) return { error: `only ${extensions.length} of ${n} line extensions could be read` };

  const rows: CedInvoiceLine[] = [];
  for (let i = 0; i < n; i++) {
    const quantity = shippedTokens.length === n ? toNumber(shippedTokens[i]) : toNumber(orderedTokens[i]);
    const unitPrice = prices[i];
    const extensionValue = extensions[i];
    // THE UNIT LETTER, CHECKED AGAINST THE ARITHMETIC RATHER THAN TRUSTED. Where the letters line
    // up with the rows the printed one is used; where they do not - a blank cell, an extractor
    // that dropped one - the divisor that actually reproduces the extension is recovered instead.
    // Guessing "each" here is what puts a $4,321.03 reel of 6/3 on a customer's bill.
    const printed = units.length === n ? units[i] : null;
    const qty = quantity ?? 0;
    // MAGNITUDES, BECAUSE A CREDIT MEMO IS NEGATIVE TWICE (review, 2026-09-19). CED prints a
    // credit with a negative quantity AND a negative price: 8802-1092311 is -1 at -85.11 giving an
    // extension of -85.11, and 8802-1094004 is -2 at -4321.45 per C giving -86.43. Two negatives
    // multiply back to a positive, so `qty * unitPrice` came out +86.43 against an extension of
    // -86.43 and no divisor could ever match - the guard was structurally dead on every credit
    // memo, and its fallback is "E". A per-M wire credit read as each is the $4,321 reel this
    // whole check exists to keep off a bill, arriving through the one door nobody tested.
    const fits = (u: CedPerUnit) =>
      cents(r2(Math.abs(qty * unitPrice) / PER_UNIT_DIVISOR[u])) === Math.abs(cents(extensionValue));
    const perUnit: CedPerUnit =
      printed && fits(printed)
        ? printed
        : (["E", "C", "M"] as CedPerUnit[]).find(fits) ?? printed ?? "E";
    rows.push({
      productCode: codes ? codes[i] : null,
      partNumber: parts ? parts[i] : null,
      description: descriptions ? descriptions[i] : null,
      // QTY SHIPPED, not QTY ORDERED: a back-ordered row is priced on what actually left the
      // counter, and the extension is computed from shipped. One quantity column, and it has to
      // be the one the money was made of.
      quantity: qty,
      unitPrice,
      perUnit,
      extension: extensionValue,
      sortOrder: i,
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE DOCUMENT
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE SERVICE CHARGE INVOICE IS A DIFFERENT PIECE OF PAPER ENTIRELY. No line items, no
 * merchandise, no tax: a single "INVOICE TOTAL - PAY THIS AMOUNT" and a dollar figure. It is the
 * 1.5%-a-month interest he was paying while $123.46 of prompt-pay discount sat unclaimed, so it
 * has to land in the ledger rather than be skipped - but neither self-check can run on it, because
 * there is nothing on the page to check against. That is stated here rather than hidden: the
 * document's only number is its total.
 */
function readServiceCharge(doc: string[], invoiceNumber: string): CedParseResult {
  const flat = doc.join(" ");
  const hit = /INVOICE\s+TOTAL\s*[-–—]?\s*PAY\s+THIS\s+AMOUNT/i.exec(flat);
  const after = hit ? flat.slice(hit.index + hit[0].length) : "";
  const total = after
    .split(/\s+/)
    .map(toMoney)
    .find((v): v is number => v !== null);
  if (total === undefined) {
    return { ok: false, invoiceNumber, error: `service charge invoice ${invoiceNumber}: could not read the amount after "INVOICE TOTAL - PAY THIS AMOUNT"` };
  }
  const dateLabel = findLabel(doc, /(?:^|\s)INVOICE\s+DATE$/i);
  const invoiceDate = dateLabel ? toIsoDate(valueAfter(doc, dateLabel.after, /PLEASE\s+SHOW|ACCOUNT\s*#/i)) : null;
  const accountLabel = findLabel(doc, /(?:^|\s)ACCOUNT\s*#\s*\/?\s*NAME$/i);
  const account = accountLabel ? valueAfter(doc, accountLabel.after, /JOB\s+NAME|CUSTOMER\s+ORDER/i) : null;
  return {
    ok: true,
    invoice: {
      invoiceNumber,
      kind: "service_charge",
      invoiceDate,
      accountNumber: account?.split(/\s+/)[0] ?? null,
      accountName: account?.split(/\s+/).slice(1).join(" ") || null,
      jobNameRaw: null,
      customerOrderRaw: null,
      merchandise: null,
      tax: null,
      shipping: null,
      total,
      discountAmount: null,
      discountBy: null,
      paidInFull: /\*+\s*PAID\s+IN\s+FULL\s*\*+/i.test(flat),
      lines: [],
    },
  };
}

function readDocument(pages: string[][], invoiceNumber: string): CedParseResult {
  const doc = pages.flat();
  const flat = doc.join(" ");
  if (/SERVICE\s+CHARGE\s+INVOICE/i.test(flat)) return readServiceCharge(doc, invoiceNumber);

  const kind: CedInvoice["kind"] = /CREDIT\s+MEMO/i.test(flat) ? "credit_memo" : "invoice";

  const dateLabel = findLabel(doc, /(?:^|\s)INVOICE\s+DATE$/i);
  const invoiceDate = dateLabel ? toIsoDate(valueAfter(doc, dateLabel.after, /PLEASE\s+SHOW/i)) : null;

  const accountLabel = findLabel(doc, /(?:^|\s)ACCOUNT\s*#\s*\/?\s*NAME$/i);
  const account = accountLabel ? valueAfter(doc, accountLabel.after, /JOB\s+NAME/i) : null;

  const jobLabel = findLabel(doc, /(?:^|\s)JOB\s+NAME$/i);
  const orderLabel = findLabel(doc, /(?:^|\s)CUSTOMER\s+ORDER\s+NO\.$/i);
  const customerOrderRaw = orderLabel ? valueAfter(doc, orderLabel.after, /SALESPERSON|SHIPPING\s+INFORMATION/i) : null;
  /**
   * WHEN THE TWO COLUMNS CARRY THE SAME WORDS, CED PRINTS ONE VALUE UNDER BOTH HEADINGS. The text
   * then reads "JOB NAME CUSTOMER ORDER NO." on one line and "235 TIMBER CREEK" on the next, with
   * nothing else between it and SALESPERSON. Looking only for a heading that ENDS in "JOB NAME"
   * left invoice 1101419 with no job name at all - $1,513.71 of material with nothing on it to
   * say which job it belongs to, which is the single most useful thing on a CED invoice.
   *
   * The fallback is only taken when the two headings genuinely share a line. On every other
   * invoice the two are read separately, even where they say the same thing.
   */
  const jobNameRaw = jobLabel
    ? valueAfter(doc, jobLabel.after, /CUSTOMER\s+ORDER\s+NO\./i)
    : doc.some((l) => /JOB\s+NAME\s+CUSTOMER\s+ORDER\s+NO\./i.test(l))
      ? customerOrderRaw
      : null;

  // ── THE TOTALS, READ AS A RUN OF VALUES UNDER A RUN OF LABELS ──────────────────────────────
  const totalsAt = findTotalsStart(doc, jobLabel?.after ?? 0);
  if (totalsAt < 0) {
    return { ok: false, invoiceNumber, error: `${invoiceNumber}: no MERCHANDISE / TOTAL DUE block was found, so there is no total to trust` };
  }
  const totalDue = findTotalDue(doc, totalsAt);
  if (!totalDue) {
    return { ok: false, invoiceNumber, error: `${invoiceNumber}: the totals block has no TOTAL DUE line` };
  }
  const totalsTokens = tokensOf(doc, totalsAt, totalDue.start);
  // The sales-tax RATE (9.00000, and once 8.26500) has five decimals; money has two. That is the
  // whole reason this filter is on shape rather than on position.
  const amounts = totalsTokens.map(toMoney).filter((v): v is number => v !== null);
  let merchandise: number | null = null;
  let tax: number | null = null;
  let shipping: number | null = null;
  if (amounts.length >= 3) [merchandise, tax, shipping] = amounts;
  else if (amounts.length === 2) [merchandise, tax, shipping] = [amounts[0], amounts[1], 0];
  else {
    return { ok: false, invoiceNumber, error: `${invoiceNumber}: the MERCHANDISE / SALES TAX / SHIPPING CHARGE values could not be read` };
  }

  // TOTAL DUE and its figure share a line on some extractions and not on others, so the words are
  // stepped over by token rather than by line.
  const afterTotalDue = tokensOf(doc, totalDue.start, Math.min(doc.length, totalDue.start + 4));
  const totalIndex = afterTotalDue.findIndex((t) => /^DUE$/i.test(t));
  const total = afterTotalDue
    .slice(totalIndex + 1)
    .map(toMoney)
    .find((v): v is number => v !== null);
  if (total === undefined) {
    return { ok: false, invoiceNumber, error: `${invoiceNumber}: TOTAL DUE has no amount after it` };
  }

  // ── THE CASH DISCOUNT ──────────────────────────────────────────────────────────────────────
  // The sentence wraps in two different places depending on how long the figure is, so it is
  // matched against the flattened text rather than a line.
  const discountHit = /CASH\s+DISCOUNT\s+(-?[\d,]+\.\d{2})\s+OFF\s+TOTAL\s+DUE/i.exec(flat);
  const discountAmount = discountHit ? toMoney(discountHit[1]) : null;

  // EVERY PAGE'S ITEM TABLE, READ ON ITS OWN AND THEN JOINED. A two-page invoice repeats its
  // header, splits its rows across both pages and prints its totals only on the last - so the
  // columns have to be zipped page by page. Doing it once across both put page 2's runs under
  // page 1's row count and left invoice 1080836 $7.94 short of its own merchandise line.
  const lines: CedInvoiceLine[] = [];
  for (const page of pages) {
    const pageTotals = findTotalsStart(page, 0);
    const read = readLines(page, 0, pageTotals);
    if (read === null) continue;
    if ("error" in read) return { ok: false, invoiceNumber, error: `${invoiceNumber}: ${read.error}` };
    for (const row of read) lines.push({ ...row, sortOrder: lines.length });
  }
  if (!lines.length) return { ok: false, invoiceNumber, error: `${invoiceNumber}: no line items were found under QTY ORDERED` };

  // ── THE TWO CHECKS THAT MAKE THIS SAFE TO BELIEVE ──────────────────────────────────────────
  const extensionSum = lines.reduce((sum, l) => sum + cents(l.extension), 0);
  if (extensionSum !== cents(merchandise)) {
    return {
      ok: false,
      invoiceNumber,
      error: `${invoiceNumber}: the ${lines.length} line extensions add up to ${(extensionSum / 100).toFixed(2)}, but MERCHANDISE says ${merchandise.toFixed(2)}`,
    };
  }
  const partsSum = cents(merchandise) + cents(tax) + cents(shipping);
  if (partsSum !== cents(total)) {
    return {
      ok: false,
      invoiceNumber,
      error: `${invoiceNumber}: merchandise ${merchandise.toFixed(2)} plus tax ${tax.toFixed(2)} plus shipping ${shipping.toFixed(2)} is ${(partsSum / 100).toFixed(2)}, but TOTAL DUE says ${total.toFixed(2)}`,
    };
  }

  return {
    ok: true,
    invoice: {
      invoiceNumber,
      kind,
      invoiceDate,
      accountNumber: account?.split(/\s+/)[0] ?? null,
      accountName: account?.split(/\s+/).slice(1).join(" ") || null,
      jobNameRaw,
      customerOrderRaw,
      merchandise,
      tax,
      shipping,
      total,
      discountAmount,
      discountBy: discountAmount === null ? null : tenthOfFollowingMonth(invoiceDate),
      // "***PAID IN FULL*** INVOICE NO." - CED stamps it across its own header, and the supplier
      // is the only voice that can say it. Nine of his bills were settled weeks before the app
      // stopped calling them owed.
      paidInFull: /\*+\s*PAID\s+IN\s+FULL\s*\*+/i.test(flat),
      lines,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DOORS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every CED document in a block of text, in the order they are printed, each one either read in
 * full or refused by name. One downloaded PDF routinely holds four.
 *
 * An empty array means nothing in the text looked like a CED invoice at all - which is a different
 * answer from "it failed the checks", and the caller says so differently.
 */
export function parseCedDocuments(text: string): CedParseResult[] {
  const lines = toLines(text);
  if (!lines.length) return [];
  return splitDocuments(lines).map((doc) => readDocument(doc.pages, doc.invoiceNumber));
}

/**
 * One document, for the caller that has exactly one. A text holding several is a refusal rather
 * than a silent "here is the first one" - picking one of four invoices and saying nothing about
 * the other three is how money goes missing.
 */
export function parseCedInvoice(text: string): CedParseResult {
  const all = parseCedDocuments(text);
  if (!all.length) {
    return { ok: false, invoiceNumber: null, error: "no CED invoice number was found in that text" };
  }
  if (all.length > 1) {
    const numbers = all.map((r) => (r.ok ? r.invoice.invoiceNumber : r.invoiceNumber ?? "?"));
    return { ok: false, invoiceNumber: null, error: `that text holds ${all.length} documents (${numbers.join(", ")}), not one` };
  }
  return all[0];
}

/** What one document's per-unit letter divides its printed price by. Exported because a screen
 *  that shows "$4,321.03 per M" next to "$237.66" has to be able to explain the gap. */
export const perUnitDivisor = (unit: CedPerUnit): number => PER_UNIT_DIVISOR[unit] ?? 1;
