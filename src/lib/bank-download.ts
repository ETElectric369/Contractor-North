import { BUCKET_SECTION, BUSINESS_COST_BUCKETS, bucketOf, isBusinessCostBucket, type BusinessCostBucket } from "@/lib/business-cost-buckets";
import { PNL_WORDS } from "@/lib/analytics/profit-and-loss";
import { findHeaderRow, fingerprintOf, headerKey, readDate, readHeaderRow, readHeaderWith, readMoney, sayDollars } from "@/lib/supplier-open-list";

/**
 * A BANK'S DOWNLOAD, SORTED THE WAY THE COMPANY SORTS IT (Erik, 2026-09-27, "yes go for those").
 *
 * That night we sorted ET's checking export by hand: deposits were the invoice payments already
 * recorded (never written again), CED's card payments were CED's account, fuel and insurance were
 * business costs in their buckets, the transfers to his own account were owner's draw (never a
 * cost), the dentist was personal. This module does exactly that, in plain code, no model:
 *
 *   1. ALREADY DOWNLOADED: a line whose key is already in bank_lines is counted, never shown. So is
 *      a line another download of the same account counted under another key (a QFX after a CSV
 *      of the same weeks: the bank's id in one, the line itself in the other): the same money, 2
 *      days apart at most, the same account, and words that name the same merchant.
 *   2. MATCH, exact cents, each money row once, in two passes over every line (a sure match first,
 *      so a looser one can never take a row a later line was surely for):
 *        · a deposit is one payment paid the way the bank says the money came (a check or cash for
 *          a deposit, Venmo for a Venmo payout, a card for a Stripe payout) up to 30 days before it
 *          posts, or exactly one group of up to 6 (a card payout less Stripe's fee, a Venmo sweep);
 *          only then, a payment the bank's words or the payment's method can't place, up to 7 days;
 *        · a check or a debit to a crew member is a live crew payment (by check number, or by amount
 *          from 5 days before it was recorded to 60 after: a check can sit in a wallet for weeks,
 *          and the office may record the pay a few days after the bank posts it);
 *        · a payment to an on-account supplier whose name, spelling or number the line carries is
 *          that supplier's payment;
 *        · an ATM withdrawal is a petty-cash top-up of the same amount within 3 days, when one was
 *          already written (so it counts once); otherwise its guess is Cash Taken Out (Not A Cost),
 *          which writes nothing (W1-34);
 *        · anything else is a bill for the same amount within 3 days whose supplier the line names
 *          (a word they share, or the name's start), never one a supplier's account pays (those are
 *          paid through the account), and never for a transfer between the company's own accounts.
 *          Only a line that names nobody (a bare check) takes a bill by amount alone, in the loose
 *          pass; a line that names someone else asks.
 *   3. A RULE THE COMPANY MADE (bank_rules) → its choice. Written only by a person's tap, and only
 *      for the amounts it was answered for (its band, stretched 2x either way): one merchant may
 *      have two answers ("fill-up-sized is Fuel, coffee-sized is Other"). A line outside every
 *      band for its merchant asks, with the nearest band's answer as the guess.
 *   4. OTHERWISE IT NEEDS YOU: one row per merchant (split when its amounts are far apart), the
 *      app's guess first, never picked for you.
 *
 * BUILD FOR MILLIONS: no company, bank, supplier or person is named in here. Columns are found by
 * header words (BANK_WORDS); the guesses are generic words (FUEL, INSURANCE, FEE) and the
 * company's own accounts, invoices and crew. ET's checking export is the fixture, never the rule.
 *
 * PRIVACY: a line keeps the last 4 of its account and a description with every run of 6 or more
 * digits (joined by spaces or dashes, the way card numbers are printed) cut to its last 4. The raw
 * cells never leave the server action that reads them; bank_lines refuses a longer run itself.
 *
 * PURE: no database, no browser. The server hands it the rows it read; the page and Apply work out
 * the same plan from them, and Apply writes only what a person saw (the fingerprint).
 */

// ── COLUMNS ────────────────────────────────────────────────────────────────────────────────────

export const BANK_FIELDS = ["date", "txDate", "description", "amount", "debit", "credit", "check", "balance", "account", "id", "type", "status"] as const;
export type BankField = (typeof BANK_FIELDS)[number];
export type BankColumns = Partial<Record<BankField, number>>;

/** The words banks put over each column, reduced by headerKey ("Check #" → "check"). Exact only. */
export const BANK_WORDS: Record<BankField, readonly string[]> = {
  date: ["post date", "posted", "posting date", "posted date", "date posted", "date", "effective date", "value date"],
  txDate: ["transaction date", "trans date", "tran date", "purchase date"],
  description: [
    "description", "desc", "memo", "payee", "name", "payee name", "merchant", "merchant name", "transaction description",
    "original description", "narrative", "transaction details", "transaction",
  ],
  amount: ["amount", "transaction amount", "amt", "amount usd", "net amount"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "withdrawal amount", "withdrawal amt", "debit amount", "debit amt", "money out", "amount debit", "paid out"],
  credit: ["credit", "credits", "deposit", "deposits", "deposit amount", "deposit amt", "credit amount", "credit amt", "money in", "amount credit", "paid in"],
  check: ["check", "check number", "chk", "chk number", "check or slip", "cheque", "cheque number", "check num", "checknum"],
  balance: ["balance", "running balance", "running bal", "ledger balance", "available balance", "account balance", "bal"],
  account: ["account", "account number", "acct", "acct number", "card", "card number", "account id"],
  id: ["id", "fitid", "transaction id", "trans id"],
  type: ["type", "transaction type", "details", "dr cr", "debit credit"],
  status: ["status", "transaction status"],
};

/** Words only a bank prints over a column, so a table that also has a paper-number column is still
 *  read as a bank download when it carries one of these. Never "balance": a supplier's statement
 *  prints a running balance beside its paper numbers too, and it is the supplier's list. */
const BANK_ONLY = new Set([
  "debit", "credit", "withdrawal", "withdrawals", "withdrawal amt", "withdrawal amount", "deposit", "deposits", "deposit amt",
  "deposit amount", "debit amt", "credit amt", "check", "posted", "post date", "posting date", "posted date", "date posted", "memo", "payee", "fitid",
]);

/**
 * The header row of a bank download: a day, a description and money (one signed column, or debit
 * and credit). The row (of the first 15) that names the most fields; null when none does.
 */
export function findBankHeader(table: readonly (readonly string[])[]): { row: number; columns: BankColumns } | null {
  let best: { row: number; columns: BankColumns; found: number } | null = null;
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const { columns } = readHeaderWith<BankField>(table[i] ?? [], BANK_WORDS);
    const hasDate = columns.date !== undefined || columns.txDate !== undefined;
    const hasMoney = columns.amount !== undefined || columns.debit !== undefined || columns.credit !== undefined;
    if (!hasDate || columns.description === undefined || !hasMoney) continue;
    const found = Object.keys(columns).length;
    if (!best || found > best.found) best = { row: i, columns, found };
  }
  return best ? { row: best.row, columns: best.columns } : headerlessBank(table);
}

/**
 * THE SHAPE OF A BANK'S LINES WITH NO HEADINGS OVER THEM: one column of days, one of money, one of
 * words long enough to be a bank's description, and no column of paper numbers (a supplier's list
 * without headings has one, and stays the supplier's). Null when the table is not laid out that way.
 *
 * It is its own function because two questions ask it. `headerlessBank` below adds the proof that
 * tells money out from money in, and reads the download. `unreadBankTable` asks the shape alone, to
 * refuse a bank's table that could not be read rather than keep the owner's spending as a supplier's
 * list — a file with no minus sign in it is still the bank's.
 */
function headerlessShape(table: readonly (readonly string[])[]): BankColumns | null {
  const rows = table.filter((r) => r.some((c) => String(c ?? "").trim() !== "")).slice(0, 25);
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 3) return null;
  const at = (r: readonly string[], i: number) => String(r[i] ?? "").trim();
  const share = (i: number, test: (v: string) => boolean) => rows.filter((r) => test(at(r, i))).length / rows.length;
  const isDay = (v: string) => /[/-]/.test(v) && readBankDate(v) !== null;
  const isMoney = (v: string) => /\d\.\d{2}\b|^[-+(]/.test(v) && readBankMoney(v) !== null && !isDay(v);
  const cols = [...Array(width).keys()];
  const date = cols.find((i) => share(i, isDay) >= 0.9);
  const amount = cols.find((i) => i !== date && share(i, isMoney) >= 0.9);
  if (date === undefined || amount === undefined) return null;
  let description: number | undefined;
  let longest = 0;
  for (const i of cols) {
    if (i === date || i === amount || share(i, (v) => /[a-z]{3}/i.test(v)) < 0.9) continue;
    const avg = rows.reduce((n, r) => n + at(r, i).length, 0) / rows.length;
    if (avg > longest) [description, longest] = [i, avg];
  }
  if (description === undefined || longest < 10) return null;
  const paperNumbers = cols.some((i) => i !== date && i !== amount && i !== description && share(i, (v) => /^[a-z]{0,4}[-#]?\d[\d-]{3,}$/i.test(v) && !isDay(v)) >= 0.8);
  return paperNumbers ? null : { date, amount, description };
}

/**
 * A DOWNLOAD WITH NO HEADINGS AT ALL (a big bank's CSV is just "09/25/2026","-42.00","*","","ACME…").
 * Read by what its columns hold, on a strong sign only: the shape above, and at least one line going
 * out — with no heading to say so, a minus sign is the only thing that tells money out from money in,
 * and a download read the wrong way round would file his deposits as costs. The header row is -1:
 * every row is a line.
 */
function headerlessBank(table: readonly (readonly string[])[]): { row: number; columns: BankColumns } | null {
  const columns = headerlessShape(table);
  if (!columns || columns.amount === undefined) return null;
  const amount = columns.amount;
  if (!table.some((r) => (readBankMoney(String(r[amount] ?? "")) ?? 0) < 0)) return null;
  return { row: -1, columns };
}

/**
 * A HEADING ONLY A BANK PRINTS (Withdrawal, Deposit) OVER NO COLUMN OF PAPER NUMBERS. Both questions
 * below end here, so the heading rule is written once: a second copy is how one of them gains a word
 * the other never hears about.
 */
function bankHeadingNoPapers(table: readonly (readonly string[])[], headerRow: number, supplierHasReference: boolean): boolean {
  if (supplierHasReference) return false;
  const words = new Set([...BANK_WORDS.debit, ...BANK_WORDS.credit]);
  return (table[headerRow] ?? []).some((c) => words.has(headerKey(c)));
}

/**
 * A TABLE THAT MAY BE A BANK'S, BUT DIDN'T READ AS ONE: no headings, or a heading only a bank
 * prints (Withdrawal, Deposit) and no paper-number column. Where it waits for a person to point at
 * its columns, every cell with words in it is kept with its long digit runs cut to their last 4
 * ("ONLINE TRANSFER FROM SAVINGS 000123456789" keeps ••6789), the same as a bank line. A cell of
 * only a number (a paper number, an amount, a day) is left alone: a supplier's list needs them.
 *
 * THIS IS THE PRIVACY QUESTION, asked wide on purpose: any headerless table is cut, because a cell
 * that holds an account number costs nothing to cut. `unreadBankTable` below is the narrower one.
 */
export function mayBeBankTable(table: readonly (readonly string[])[], headerRow: number, supplierHasReference: boolean): boolean {
  if (findBankHeader(table)) return false;
  if (headerRow < 0) return true;
  return bankHeadingNoPapers(table, headerRow, supplierHasReference);
}

/**
 * THESE ROWS ARE A BANK'S, THOUGH THEY DID NOT READ AS A DOWNLOAD (2026-10-02). Every door refuses
 * such a table, whoever drops it, and `notABankDownloadSaid` is what it says.
 *
 * WHY A REFUSAL AND NOT A CARD. A table that does not read as a download is otherwise kept as a
 * supplier's list waiting for a person to point at its columns — and the database holds THAT class of
 * paper to is_org_staff(), every office hand, while it holds a bank download to viewer_sorts_bank(),
 * the owner's own switch (0365). A bank's lines stored as a supplier's list are therefore the owner's
 * draw and his dentist on the screen of an office hand the owner switched off, four of them sampled
 * onto the card itself. The owner's own door loses nothing: a list with no paper numbers in it could
 * never have been applied anyway, and the refusal says which download to take instead.
 *
 * NARROWER THAN mayBeBankTable, which cuts long numbers out of any headerless table. This asks
 * whether the rows ARE a bank's: laid out like a bank's lines, or under a heading only a bank prints.
 * A headerless list of paper numbers and amounts is a supplier's, and still gets its column picker.
 */
export function unreadBankTable(table: readonly (readonly string[])[], headerRow: number, supplierHasReference: boolean): boolean {
  if (findBankHeader(table)) return false;
  if (headerRow < 0) return headerlessShape(table) !== null;
  return bankHeadingNoPapers(table, headerRow, supplierHasReference);
}

/**
 * WHAT A DOOR SAYS TO A FILE THAT IS A BANK'S AND DIDN'T READ AS ONE. One sentence in one place: the
 * door that promised a bank download and the door that takes either statement are asking the same
 * question, and two spellings of the answer is how one of them stops naming what to do next.
 */
export function notABankDownloadSaid(name: string): string {
  return `${name} doesn't read as a bank download: it needs a date, a description and an amount on every line. Download it again as CSV (with column headings, if the bank offers them) and drop that. Nothing was added.`;
}

export function redactWordCells(table: readonly (readonly string[])[]): string[][] {
  return table.map((r) => r.map((c) => (/[a-z]/i.test(String(c ?? "")) ? redactDigits(String(c ?? "")) : String(c ?? ""))));
}

/** Debit and Credit alone: a supplier's statement prints them over its papers too. */
const DEBIT_CREDIT = new Set(["debit", "credit", "debits", "credits"]);

/**
 * IS THIS TABLE A BANK DOWNLOAD (rather than a supplier's open list)? It has the bank header, and
 * no paper-number column, or a sign only a bank gives:
 *   · a paper number AND an open balance ("Open Balance", "Balance Due") is a supplier's open-item
 *     list, whatever else it prints (a plain "Balance" may be a bank's running balance: no sign);
 *   · a word only a bank prints over a column (Posted, Memo, Payee, Withdrawal, Deposit, Check) is
 *     a bank's;
 *   · Debit and Credit and nothing else: the paper-number column decides. A supplier's holds paper
 *     numbers ("INV-1001"); a bank's "Transaction" column holds words ("DEBIT CARD PURCHASE").
 */
export function looksLikeBankTable(table: readonly (readonly string[])[], supplierHasReference: boolean): boolean {
  const h = findBankHeader(table);
  if (!h) return false;
  if (!supplierHasReference) return true;
  const at = findHeaderRow(table);
  const cells = table[at] ?? [];
  const sup = at >= 0 ? readHeaderRow(cells).columns : {};
  if (sup.openBalance !== undefined && headerKey(cells[sup.openBalance]) !== "balance") return false;
  const bankOnly = (table[h.row] ?? []).map((c) => headerKey(c)).filter((k) => BANK_ONLY.has(k));
  if (!bankOnly.length) return false;
  if (bankOnly.some((k) => !DEBIT_CREDIT.has(k))) return true;
  if (sup.reference === undefined) return true;
  const ref = sup.reference;
  const values = table
    .slice(at + 1)
    .map((r) => String(r[ref] ?? "").trim())
    .filter(Boolean)
    .slice(0, 30);
  const paperNumbers = values.filter((v) => /\d/.test(v) && !/\s/.test(v) && v.length <= 30).length;
  return !(values.length > 0 && paperNumbers / values.length >= 0.6);
}

// ── ONE LINE ───────────────────────────────────────────────────────────────────────────────────

export type BankLine = {
  /** The line in the file (1-based, counting the header), for "Line 12 didn't read". */
  row: number;
  postedOn: string;
  /** Signed cents: money in is positive, money out negative. */
  cents: number;
  /** As the bank wrote it, with every run of 6+ digits cut to its last 4. */
  description: string;
  check: string | null;
  last4: string | null;
  /** 1-2 words that name the merchant: what a rule remembers. */
  merchantKey: string;
  /** The line's identity across downloads (bank_lines.line_key). */
  key: string;
};

export type BankDownload = {
  v: 1;
  name: string;
  /** The account the file is for (its most common last 4), or null. */
  last4: string | null;
  from: string | null;
  to: string | null;
  lines: BankLine[];
  skipped: { line: number; why: string }[];
  /** The header's own words, for the column choice a later file with the same headers reuses. */
  header: string[];
  /** Money in and out were read the other way round from how the file prints them: a card's
   *  download that prints charges as positive (found by the reader, or a person's Swap). */
  swapped?: boolean;
};

/** Every run of 6 or more digits, even printed in groups ("1234-5678-9012"), cut to its last 4. */
export function redactDigits(s: string): string {
  return String(s ?? "").replace(/\d(?:[ -]?\d)*/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 6 ? `••${digits.slice(-4)}` : m;
  });
}

/** The description as stored: redacted, one space between words, at most 200 characters. */
export function cleanDescription(raw: string): string {
  return redactDigits(String(raw ?? "").replace(/\s+/g, " ").trim()).slice(0, 200);
}

/** Words that open a merchant's name but name nobody alone: kept, joined with the word after
 *  ("the home", "sq coffee", "paypal acme"). */
const STOP_FIRST = new Set(["the", "sq", "tst", "pp", "paypal", "sp", "py", "in", "an", "of", "el", "la", "le", "los", "las"]);
/**
 * Words a bank puts IN FRONT of the payee: how the money went, never who got it ("Online Payment
 * To Verizon", "BILL PAY PG&E", "Zelle payment to Pat", "VENMO *JOHN", "WIRE TRANSFER TO ACME").
 * Dropped from the front, as many as there are, so each payee is its own merchant: kept, "zelle"
 * or "bill pay" would put crew pay, a subcontractor, a loan and a tax payment under one answer.
 */
const DROP_LEAD = new Set([
  "online", "mobile", "remote", "bill", "external", "electronic", "www", "ext", "int", "intl", "dd", "ppd", "ccd", "web", "tel",
  "ref", "to", "from", "pay", "name", "orig", "zelle", "venmo", "cashapp", "wire", "transfer", "xfer", "trnsfr", "id", "des",
  "desc", "entry", "ind", "sent", "received", "recd",
]);
/** Words a bank adds around every merchant (the kind of transaction, never who). */
const NOISE = new Set([
  "pos", "ach", "debit", "credit", "purchase", "card", "checkcard", "dbt", "crd", "recurring", "visa", "mastercard", "mc",
  "authorized", "on", "pending", "withdrawal", "payment", "pmt", "trans", "transaction", "sale", "preauth", "pin", "signature",
  "usa", "us", "inc", "llc", "co", "corp", "preauthorized", "dda", "pur", "withdraw",
]);

/** A description's words, lowercased, with numbers, dates, card prefixes and bank noise taken out. */
export function merchantWords(description: string): string[] {
  let s = String(description ?? "").toLowerCase();
  s = s.replace(/^\s*\d{4}[-\s]+/, " "); // a card's last 4 in front: "1111-SHELL"
  s = s.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " "); // dates
  s = s.replace(/['’`]/g, " ");
  s = s.replace(/\bcash\s*app\b/g, " cashapp ");
  // "POINT OF SALE WITHDRAWAL SHELL…": the kind of transaction, in front of every card purchase.
  s = s.replace(/\bpoint\s+of\s+sale\b/g, " ");
  return s
    .split(/[^a-z0-9&]+/)
    .filter((w) => w && !/\d/.test(w) && !NOISE.has(w));
}

const TRANSFER_RE = /\b(transfer|xfer|trnsfr)\b/i;
/** Card processors and payment apps: their "transfer" is a payout of customers' money, not a move
 *  between the company's own accounts, so it keeps its merchant's name. */
const PROCESSOR_RE = /\b(stripe|square|sq|venmo|zelle|paypal|cash ?app|clover|toast|shopify|intuit|quickbooks)\b/i;

/**
 * THE MERCHANT KEY: the first word, or two when the first names nobody ("the home", "sq coffee",
 * "o reilly"). A transfer is keyed by the account it goes to or comes from (its last 4), since
 * "transfer" alone would put the owner's draw and a move to savings under one rule.
 */
export function merchantKeyOf(description: string): string {
  // AN ACH LINE names its payee after "CO NAME:" ("ORIG CO NAME:ACME INSURANCE ORIG ID:…"); every
  // ACH line starts "ORIG", so the payee is the only part that says who.
  const co = /\bCO(?:MPANY)?\s*NAME\s*:\s*(.+?)(?=\s+(?:ORIG|ENTRY|DESC|SEC|IND|TRACE|CO\s*ID)\b|$)/i.exec(String(description ?? ""));
  const text = co ? co[1] : String(description ?? "");
  if (TRANSFER_RE.test(text) && !PROCESSOR_RE.test(text)) {
    // The other account's number: a masked one first ("XXXXXX9876", "****9876"), else the first run
    // of 4 or more digits (never a date's 09 or 10, and never a reference number printed after it).
    const masked = [...text.matchAll(/[x*]{2,}-?(\d{4})\b/gi)].map((m) => m[1] ?? "").filter(Boolean);
    const runs = text.match(/\d{4,}/g) ?? [];
    const acct = masked.length ? (masked[masked.length - 1] ?? "") : (runs[0] ?? "").slice(-4);
    if (acct) return `transfer ${acct}`;
    // A wire or transfer TO someone with no account on it is keyed by who it went to.
    const payee = wordsKey(merchantWords(text));
    return payee && !DROP_LEAD.has(payee) ? payee : "transfer";
  }
  return wordsKey(merchantWords(text));
}

/** The key from a description's words: the bank's lead words off the front, then the first word,
 *  or two when the first names nobody alone. */
function wordsKey(all: readonly string[]): string {
  const words = [...all];
  while (words.length > 1 && DROP_LEAD.has(words[0])) words.shift();
  if (!words.length) return "";
  const first = words[0];
  const key = (STOP_FIRST.has(first) || first.length === 1) && words[1] ? `${first} ${words[1]}` : first;
  return key.slice(0, 60);
}

/** A deposit word with nothing else: every deposit shares it, so no rule is made or used on it. */
export function isGenericKey(key: string): boolean {
  const words = key.split(" ");
  return words.includes("deposit") || words.includes("deposits") || key === "check" || key === "counter" || key === "branch";
}

/** The words a bank prints on money coming in that say HOW it came, never from whom. */
const DEPOSIT_WORDS_RE = /\b(deposits?|dep|regular|mobile|branch|atm|counter|remote|teller|dslip|check|cheque|cash|payout|cashout|instant)\b/i;

/**
 * MONEY IN THAT MAY BE A CUSTOMER'S: a deposit (regular, mobile, branch, ATM, remote) or a payout
 * from a card processor or payment app (Stripe, Square, Venmo, Zelle, PayPal). Every one of them is
 * a row of its own, so an invoice can be offered, and none is ever placed by a rule or teaches one:
 * "REGULAR DEPOSIT" or "VENMO" names how the money came, never whose it was, and a rule on it would
 * file the next customer payment without asking.
 */
export function isCustomerMoneyIn(line: Pick<BankLine, "cents" | "description" | "merchantKey">): boolean {
  if (line.cents <= 0) return false;
  return isGenericKey(line.merchantKey) || DEPOSIT_WORDS_RE.test(line.description) || PROCESSOR_RE.test(line.description);
}

/** A line that is a check and says nothing else about who it paid. */
export function isBareCheck(line: Pick<BankLine, "check" | "merchantKey">): boolean {
  return !!line.check && (line.merchantKey === "" || line.merchantKey === "check" || line.merchantKey === "chk");
}

const digitsOnly = (s: unknown) => String(s ?? "").replace(/\D/g, "");

/** The last 4 digits of an account cell ("XXXXX1234", "****1234", "Checking - 1234"). */
export function last4Of(raw: unknown): string | null {
  const d = digitsOnly(raw);
  return d ? d.slice(-4) : null;
}

/**
 * THE ACCOUNT FROM THE FILE'S NAME, for a download with no account column ("Chase1111_Activity_
 * 20260930.csv" → 1111). Only one run of exactly 4 digits that isn't a year: a longer run may be a
 * date or a timestamp that changes every download (which would make the same line two lines), and
 * two candidates are no answer. Null when the name doesn't say.
 */
export function last4FromName(name: string): string | null {
  const base = String(name ?? "").replace(/\.[a-z0-9]{2,5}$/i, "");
  const runs = (base.match(/\d+/g) ?? []).filter((r) => r.length === 4 && !/^(19|20)\d{2}$/.test(r));
  return runs.length === 1 ? runs[0] : null;
}

/** A check number from its column, or from the description ("CHECK 1043", "CHECK #1043"). */
export function checkNumberOf(cell: unknown, description: string): string | null {
  const fromCell = digitsOnly(cell).replace(/^0+/, "");
  if (fromCell && fromCell.length <= 10) return fromCell;
  const m = /\b(?:check|chk|cheque)\s*(?:#|no\.?|number)?\s*(\d{1,10})\b/i.exec(description);
  return m ? m[1].replace(/^0+/, "") || null : null;
}

export type Hasher = (text: string) => string;

/** The line's key: the bank's own id when the file has one, else the line itself and which repeat
 *  of it this is within the file (two identical coffees on one day are two lines). */
export function lineKeyOf(hash: Hasher, l: { last4: string | null; fitid: string | null; postedOn: string; cents: number; description: string }, repeat: number): string {
  if (l.fitid) return `fitid:${hash(`${l.last4 ?? ""}|${l.fitid}`)}`;
  const desc = l.description.toUpperCase().replace(/\s+/g, " ").trim();
  return `line:${hash(`${l.last4 ?? ""}|${l.postedOn}|${l.cents}|${desc}|${repeat}`)}`;
}

/**
 * A BANK'S AMOUNT CELL. The supplier reader (readMoney) is for a supplier's statement, where "CR" is
 * a credit memo (money off what is owed). On a bank's own download CR is money IN and DR money OUT,
 * and a bank (or an OFX TRNAMT) may print a leading "+". Anything else reads as readMoney does.
 */
export function readBankMoney(raw: unknown): number | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  const tail = /\s*\b(CR|CREDIT|DR|DEBIT)\.?$/i.exec(s);
  if (tail) s = s.slice(0, tail.index).trim();
  if (s.startsWith("+")) s = s.slice(1).trim();
  const n = readMoney(s);
  if (n === null) return null;
  if (!tail) return n;
  return /^c/i.test(tail[1]) ? Math.abs(n) : -Math.abs(n);
}

/**
 * A BANK'S DAY CELL. Banks print a time after the day ("9/3/2026 12:00:00 AM", "9/3/2026 0:00"),
 * a year first with slashes ("2026/09/03") or the month as a word ("03-SEP-2026", "3 Sep 2026").
 * Each is brought to a shape readDate knows; an Excel serial day still reads (a date column).
 */
export function readBankDate(raw: unknown): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/(?:T|\s+)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AP]\.?M\.?)?\s*(?:Z|[+-]\d{2}:?\d{2})?$/i, "").trim();
  let m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (m) return readDate(`${m[1]}-${m[2]}-${m[3]}`);
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]+(\d{2}|\d{4})$/.exec(s);
  if (m) return readDate(`${m[2]} ${m[1]}, ${m[3].length === 2 ? `20${m[3]}` : m[3]}`);
  return readDate(s, true);
}

/** The skip reason for a day that is there but didn't read (never a total's blank). */
const DAY_DIDNT_READ = "didn't read as a day";

/** Why a download with no lines that read has none, in one sentence for the drop line. */
export function noLinesSaid(dl: Pick<BankDownload, "skipped">, name: string): string {
  const days = dl.skipped.filter((x) => x.why.includes(DAY_DIDNT_READ));
  if (days.length && days.length === dl.skipped.length)
    return `${name}: none of its dates read (${days[0].why.replace(/\.$/, "")}). Download it again with dates like 09/03/2026, and drop that.`;
  const why = dl.skipped[0]?.why;
  return `${name} has no transactions in it that read${why ? ` (${why.replace(/\.$/, "")})` : ""}.`;
}

/** The type words (a bank's Type column, OFX's TRNTYPE) that say which way unsigned money went.
 *  Money IN is asked first, so "ACH CREDIT" and "Transfer In" are never read as money out. */
const CREDIT_TYPE = /\b(credit|cr|deposit|dep|directdep|refund|return|dslip|interest|int|div|dividend|incoming|transfer in|xfer in|transfer from)\b/i;
const DEBIT_TYPE = /\b(debit|dr|withdrawal|check|payment|fee|srvchg|sale|purchase|pos|atm|xfer|transfer|directdebit|ach|cash|repeatpmt)\b/i;

/** What a card company prints on the payment the company made to its card. */
const CARD_THANKS_RE = /\b(thank you|thankyou|autopay|auto[- ]?pay|auto[- ]?pmt|payment received)\b/i;
/** A line that takes money OFF a card: its payment, a credit, a return. */
const CARD_CREDIT_RE = /\b(payment|pymt|pmt|thank you|autopay|auto[- ]?pay|credit|return|refund)\b/i;

/**
 * A CARD'S DOWNLOAD THAT PRINTS CHARGES AS POSITIVE (many card exports do: a charge adds to what is
 * owed). Read as printed, every charge would be money in. Swapped only on a strong sign: a card
 * member column, or (with no running balance, which a checking export carries) every negative line
 * a payment or credit, at least one of them the card's own "thank you" / autopay words, and most
 * lines positive. Anything else is read as printed; the card's Swap is the person's way round.
 */
function chargesPrintedPositive(lines: readonly { cents: number; description: string }[], header: readonly string[], hasBalance: boolean): boolean {
  const negatives = lines.filter((l) => l.cents < 0);
  const positives = lines.length - negatives.length;
  if (positives <= negatives.length) return false;
  if (header.some((h) => /card\s*member|cardmember/i.test(String(h ?? "")))) return true;
  if (hasBalance || !negatives.length) return false;
  return negatives.some((l) => CARD_THANKS_RE.test(l.description)) && negatives.every((l) => CARD_CREDIT_RE.test(l.description));
}

/**
 * MONEY IN AND OUT THE OTHER WAY ROUND (the card's Swap, or the reader's own finding). Each line's
 * sign flips and a key made from the line (not a bank's own id) is made again from the new sign.
 * Only for a download nothing has been applied from: no line is in bank_lines under the old key.
 */
export function swapDownloadSigns(dl: BankDownload, hash: Hasher): BankDownload {
  const lines = dl.lines.map((l) => ({
    ...l,
    cents: -l.cents,
    description: l.description === "Deposit" ? "Withdrawal" : l.description === "Withdrawal" ? "Deposit" : l.description,
  }));
  return { ...dl, lines: rekeyLines(lines, hash), swapped: !dl.swapped };
}

/** Each line's key made again from what it now says (a bank's own id stays as it was). */
function rekeyLines(lines: readonly BankLine[], hash: Hasher): BankLine[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    if (l.key.startsWith("fitid:")) return l;
    const same = `${l.last4 ?? ""}|${l.postedOn}|${l.cents}|${l.description.toUpperCase()}`;
    const repeat = seen.get(same) ?? 0;
    seen.set(same, repeat + 1);
    return { ...l, key: lineKeyOf(hash, { last4: l.last4, fitid: null, postedOn: l.postedOn, cents: l.cents, description: l.description }, repeat) };
  });
}

/** A person said which account a download with no account on it is for: every line carries its
 *  last 4, and its key with it. Only before anything is applied (the old keys are nowhere yet). */
export function withAccountLast4(dl: BankDownload, last4: string, hash: Hasher): BankDownload {
  const lines = dl.lines.map((l) => ({ ...l, last4: l.last4 ?? last4 }));
  return { ...dl, last4, lines: rekeyLines(lines, hash) };
}

/**
 * A TABLE INTO A DOWNLOAD. Null when it isn't one (no bank header). Every row that doesn't read is
 * kept by line with the reason, never dropped: a pending line, a line with no day or no amount.
 */
export function readBankTable(table: readonly (readonly string[])[], name: string, hash: Hasher): BankDownload | null {
  const header = findBankHeader(table);
  if (!header) return null;
  const c = header.columns;
  const cell = (r: readonly string[], at: number | undefined) => (at === undefined ? "" : String(r[at] ?? "").trim());
  const skipped: BankDownload["skipped"] = [];
  const raw: Omit<BankLine, "key" | "merchantKey">[] = [];
  const fitids: (string | null)[] = [];
  const body = table.slice(header.row + 1);
  // No account column: the file's name may say which account it is, so the same fee on two
  // accounts' downloads stays two lines.
  const nameLast4 = c.account === undefined ? last4FromName(name) : null;
  // An unsigned Amount column with a type column: the type says which way the money went.
  const amounts = c.amount !== undefined ? body.map((r) => readBankMoney(cell(r, c.amount))).filter((n): n is number => n !== null) : [];
  const unsigned = amounts.length > 0 && amounts.every((n) => n >= 0) && c.type !== undefined;
  body.forEach((r, i) => {
    const line = header.row + 2 + i;
    if (!r.some((x) => String(x ?? "").trim() !== "")) return;
    const status = cell(r, c.status);
    if (/pending|hold|authoriz/i.test(status)) {
      skipped.push({ line, why: "Pending at the bank, not posted yet. It comes in with the next download." });
      return;
    }
    const day = readBankDate(cell(r, c.date)) ?? readBankDate(cell(r, c.txDate));
    const text = cell(r, c.description);
    let amount: number | null = null;
    if (c.amount !== undefined && cell(r, c.amount) !== "") {
      amount = readBankMoney(cell(r, c.amount));
      if (amount !== null && unsigned) {
        // "ACH_DEBIT", "DEBIT_CARD": an underscore is a word character, so it is a space here.
        const t = cell(r, c.type).replace(/_/g, " ");
        if (CREDIT_TYPE.test(t)) amount = Math.abs(amount);
        else if (DEBIT_TYPE.test(t)) amount = -Math.abs(amount);
        else {
          // Never guessed: a withdrawal read as a deposit is money that never came in.
          skipped.push({ line, why: `Can't tell if this is money in or out: its type${t.trim() ? ` "${redactDigits(t.trim()).slice(0, 30)}"` : ""} isn't one the app knows.` });
          return;
        }
      }
    } else {
      const debit = readBankMoney(cell(r, c.debit));
      const credit = readBankMoney(cell(r, c.credit));
      if (debit !== null && Math.round(debit * 100) !== 0) amount = -Math.abs(debit);
      else if (credit !== null && Math.round(credit * 100) !== 0) amount = Math.abs(credit);
      else if (debit !== null || credit !== null) amount = 0;
    }
    if (!day) {
      // A day printed in a way nothing reads is said as that (the file needs another download);
      // a blank or a word is a total or a note under the table: said by line, never read as money.
      const printed = cell(r, c.date) || cell(r, c.txDate);
      skipped.push({
        line,
        why: /\d/.test(printed) && amount !== null ? `Its date "${redactDigits(printed).slice(0, 30)}" ${DAY_DIDNT_READ}.` : "No date on it, so it isn't a transaction (a total or a note).",
      });
      return;
    }
    if (amount === null) {
      skipped.push({ line, why: "No amount on it." });
      return;
    }
    const cents = Math.round(amount * 100);
    if (cents === 0) {
      skipped.push({ line, why: "$0.00: no money moved." });
      return;
    }
    const description = cleanDescription(text) || (cents > 0 ? "Deposit" : "Withdrawal");
    raw.push({
      row: line,
      postedOn: day,
      cents,
      description,
      // From the REDACTED words: "transfer to CHK 123456789" is an account number, not a check,
      // and it must never reach a bill number or a crew payment's reference.
      check: checkNumberOf(cell(r, c.check), description),
      last4: c.account === undefined ? nameLast4 : last4Of(cell(r, c.account)),
    });
    fitids.push(cell(r, c.id) || null);
  });
  // A card's download that prints its charges as positive is read the other way round.
  const swapped = c.amount !== undefined && !unsigned && chargesPrintedPositive(raw, (table[header.row] ?? []).map(String), c.balance !== undefined);
  if (swapped) {
    for (const l of raw) {
      l.cents = -l.cents;
      if (l.description === "Deposit") l.description = "Withdrawal";
      else if (l.description === "Withdrawal") l.description = "Deposit";
    }
  }
  // The account the file is for: its most common last 4 (a file may mix a card and checking).
  const tally = new Map<string, number>();
  for (const l of raw) if (l.last4) tally.set(l.last4, (tally.get(l.last4) ?? 0) + 1);
  const last4 = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const seen = new Map<string, number>();
  const lines: BankLine[] = raw.map((l, i) => {
    const same = `${l.last4 ?? ""}|${l.postedOn}|${l.cents}|${l.description.toUpperCase()}`;
    const repeat = seen.get(same) ?? 0;
    seen.set(same, repeat + 1);
    return { ...l, merchantKey: merchantKeyOf(l.description), key: lineKeyOf(hash, { ...l, fitid: fitids[i] }, repeat) };
  });
  const days = lines.map((l) => l.postedOn).sort();
  return {
    v: 1,
    name,
    last4,
    from: days[0] ?? null,
    to: days[days.length - 1] ?? null,
    lines,
    skipped,
    header: (table[header.row] ?? []).map((h) => String(h ?? "").trim().slice(0, 60)),
    ...(swapped ? { swapped: true } : {}),
  };
}

// ── CHOICES ────────────────────────────────────────────────────────────────────────────────────

/** A business cost is its bucket and nothing more: Fuel is a bucket of its own (0362), so a fill-up
 *  is "cost:Fuel" and the truck's repairs "cost:Auto".
 *
 *  CASH TAKEN OUT (NOT A COST) (Erik, 2026-09-27; W1-34): an ATM withdrawal. It writes NO row, like
 *  Not A Cost (Transfer): the cash counts only when its receipts come in, filed as costs paid with
 *  cash. It is never Owner's Draw, and there is no running cash-box balance. It was Petty Cash
 *  (ATM), which wrote a petty-cash top-up; those already written still count once, and still Undo. */
export type BankChoice =
  | { choice: "cost"; bucket: BusinessCostBucket }
  | { choice: "draw" }
  | { choice: "personal" }
  | { choice: "cash_out" }
  | { choice: "not_cost" }
  | { choice: "supplier"; supplierAccountId: string }
  | { choice: "crew"; profileId: string }
  | { choice: "invoice"; invoiceId: string }
  | { choice: "other_income" }
  | { choice: "not_income" };

export type ChoiceName = BankChoice["choice"];

/**
 * THE WORD A CHOICE IS STORED AS (bank_lines.choice, bank_rules.choice). 0363's CHECK names the words
 * a row may hold, and Cash Taken Out is kept under the one it replaced, 'petty_cash': a line applied
 * that way before W1-34 wrote a top-up, one applied after writes nothing, and both are cash that left
 * the bank. Read back through storedChoiceName, so the app only ever sees cash_out. No migration.
 */
export const CASH_OUT_STORED = "petty_cash";
export function storedChoice(c: BankChoice): string {
  return c.choice === "cash_out" ? CASH_OUT_STORED : c.choice;
}
/** A stored word as the app's choice name (the legacy word for Cash Taken Out comes back as cash_out). */
export function storedChoiceName(word: string): string {
  return word === CASH_OUT_STORED ? "cash_out" : word;
}

/** A choice as one string, for a button's value and the fingerprint. */
export function choiceId(c: BankChoice): string {
  switch (c.choice) {
    case "cost":
      return `cost:${c.bucket}`;
    case "supplier":
      return `supplier:${c.supplierAccountId}`;
    case "crew":
      return `crew:${c.profileId}`;
    case "invoice":
      return `invoice:${c.invoiceId}`;
    default:
      return c.choice;
  }
}

/** An id as the app writes one (a uuid); validPicks checks it names this company's own row. */
const UUIDISH = /^[A-Za-z0-9_-]{1,64}$/;

export function parseChoiceId(id: unknown): BankChoice | null {
  const s = String(id ?? "");
  const [head, a] = s.split(":");
  switch (head) {
    case "cost":
      // Exactly "cost:<bucket>": anything after the bucket (a retired "cost:<bucket>:<kind>" id)
      // is no answer, and the row asks again.
      return isBusinessCostBucket(a) && s === `cost:${a}` ? { choice: "cost", bucket: a } : null;
    case "supplier":
      return UUIDISH.test(a ?? "") ? { choice: "supplier", supplierAccountId: a } : null;
    case "crew":
      return UUIDISH.test(a ?? "") ? { choice: "crew", profileId: a } : null;
    case "invoice":
      return UUIDISH.test(a ?? "") ? { choice: "invoice", invoiceId: a } : null;
    // Cash Taken Out, and the word it had before W1-34 (a card's pick saved under the old name).
    case "cash_out":
    case CASH_OUT_STORED:
      return s === head ? { choice: "cash_out" } : null;
    case "draw":
    case "personal":
    case "not_cost":
    case "other_income":
    case "not_income":
      return s === head ? ({ choice: head } as BankChoice) : null;
    default:
      return null;
  }
}

const IN_CHOICES = new Set<ChoiceName>(["invoice", "other_income", "not_income"]);

/** Money in takes the income choices, or a business cost's bucket (a refund of that cost: a
 *  negative bill in the bucket); money out takes the rest. */
export function choiceFits(c: BankChoice, direction: "in" | "out"): boolean {
  return direction === "in" ? IN_CHOICES.has(c.choice) || c.choice === "cost" : !IN_CHOICES.has(c.choice);
}

export type BankNames = {
  accounts: Map<string, string>;
  crew: Map<string, string>;
  invoices: Map<string, string>;
};

/** The button's words, Title Case. */
export function choiceLabel(c: BankChoice, names: BankNames): string {
  switch (c.choice) {
    case "cost":
      return c.bucket;
    case "draw":
      return "Owner's Draw";
    case "personal":
      return "Personal";
    case "cash_out":
      return "Cash Taken Out (Not A Cost)";
    case "not_cost":
      return "Not A Cost (Transfer)";
    case "supplier":
      return `Pay ${names.accounts.get(c.supplierAccountId) ?? "Supplier"}`;
    case "crew":
      return `Pay ${names.crew.get(c.profileId) ?? "Crew"}`;
    case "invoice":
      return `On ${names.invoices.get(c.invoiceId) ?? "Invoice"}`;
    case "other_income":
      return "Other Income";
    case "not_income":
      // What it is for: a deposit already in North (a payment recorded), or money that was never
      // income (a transfer from the company's own account, a loan).
      return "Already Counted Or Not Income";
  }
}

// ── THE BOOKS IT IS COMPARED WITH ──────────────────────────────────────────────────────────────

export type BooksPayment = { id: string; invoiceId: string; invoiceNumber: string; cents: number; day: string; method: string; feeCents: number | null; stripe: boolean };
export type BooksPay = { id: string; profileId: string; cents: number; day: string; reference: string | null };
export type BooksSupplierPay = { id: string; accountId: string; cents: number; day: string; reference: string | null };
export type BooksBill = {
  id: string;
  cents: number;
  day: string | null;
  supplier: string;
  jobId: string | null;
  category: string | null;
  onAccount: boolean;
};
export type BooksPetty = { id: string; cents: number; day: string; kind: string };
export type BooksAccount = { id: string; name: string; number: string | null; branch: string | null; onAccount: boolean; aliases: string[] };
export type BooksInvoice = { id: string; number: string; balanceCents: number; customer?: string | null };
export type BooksCrew = { id: string; name: string };
export type BooksRule = {
  id: string;
  direction: "in" | "out";
  key: string;
  choice: Exclude<ChoiceName, "invoice">;
  bucket: string | null;
  supplierAccountId: string | null;
  profileId: string | null;
  /** The amounts (cents, positive) it was answered for; null = every amount. */
  minCents?: number | null;
  maxCents?: number | null;
};
export type AlreadyLine = { choice: string; bucket: string | null; amountCents: number };
/** A line already in bank_lines around this download's days, whatever download counted it. */
export type StoredLine = { key: string; postedOn: string; cents: number; last4: string | null; description: string; check: string | null };

export type BankBooks = {
  /** line_key → what it was, for every line of this download already in bank_lines. */
  already: Map<string, AlreadyLine>;
  /** Only rows no bank line marks yet. */
  payments: BooksPayment[];
  payPayments: BooksPay[];
  supplierPayments: BooksSupplierPay[];
  bills: BooksBill[];
  pettyCash: BooksPetty[];
  accounts: BooksAccount[];
  invoices: BooksInvoice[];
  crew: BooksCrew[];
  rules: BooksRule[];
  /** Every live crew payment (marked or not), for "a crew member on a check" guesses. */
  crewPaid: { profileId: string; cents: number }[];
  /** The company's bank lines 3 days either side of this download, under any key (the twin check). */
  stored?: StoredLine[];
};

// ── THE PLAN ───────────────────────────────────────────────────────────────────────────────────

export type MatchTable = "payments" | "bills" | "supplier_payments" | "pay_payments" | "petty_cash";

export type Disposition =
  | { how: "already" }
  | { how: "match"; table: MatchTable; ids: string[]; said: string }
  | { how: "rule"; ruleId: string; choice: BankChoice }
  | { how: "need"; group: string };

export type NeedGroup = {
  id: string;
  direction: "in" | "out";
  /** What the row says: the first line's description. */
  label: string;
  keys: string[];
  /** The group's total (signed cents). */
  cents: number;
  /** Every line's amount when they are all the same (signed cents), else null. */
  each: number | null;
  first: string;
  last: string;
  check: string | null;
  /** A single line may go on an invoice; a merchant's several lines may not. */
  single: boolean;
  /** The app's guess (a choice id), the first button, never picked for the person. */
  guess: string | null;
  /** The buttons, guess first, then the usual answers for this kind of line. */
  buttons: string[];
  /** A rule can be learned from the person's tap on this row. */
  learnable: boolean;
  /** A sentence for the row when the books hold something that looks like it ("Maybe the payment on
   *  INV-1001 of Sep 1, already in North"), or null. */
  hint?: string | null;
  merchantKey: string;
};

export type BankPlan = {
  dispositions: Map<string, Disposition>;
  groups: NeedGroup[];
  counts: { lines: number; already: number; matched: number; ruled: number; needLines: number; needRows: number };
  fingerprint: string;
};

const r2c = (n: unknown) => Math.round((Number(n) || 0) * 100);
export const centsOf = r2c;

/** Whole days from b to a ("YYYY-MM-DD"), a - b. */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
}

/** How far a payment the company wrote (crew pay, a supplier's) may be from the bank's day: up to
 *  60 days before it posts (a check cashed late), up to 5 after (recorded after the bank posted). */
export const PAY_WINDOW = { before: 60, after: 5 } as const;
export function inPayWindow(postedOn: string, recordedOn: string): boolean {
  const d = dayDiff(postedOn, recordedOn);
  return d >= -PAY_WINDOW.after && d <= PAY_WINDOW.before;
}

const compact = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Does the line name this supplier account: its number, its branch, its name or a spelling of it?
 *   · a branch code of digits is a number on its own ("(PC) 4410 T"), never digits inside another
 *     number (a store's 44101); an account number with letters in it is found squeezed together;
 *   · a name or spelling of 5+ letters by its first 12 (a bank cuts names short); a short one
 *     ("CED", "OSH") as a word of its own, never letters inside another word.
 */
export function lineNamesAccount(description: string, a: BooksAccount): boolean {
  const d = compact(description);
  if (!d) return false;
  for (const raw of [a.number, a.branch]) {
    const code = compact(raw ?? "");
    if (code.length < 4) continue;
    if (/^\d+$/.test(code) ? new RegExp(`(^|\\D)${code}(\\D|$)`).test(String(description)) : d.includes(code)) return true;
  }
  const spellings = [a.name, ...a.aliases];
  if (spellings.map(compact).filter((x) => x.length >= 5).some((x) => d.includes(x.slice(0, 12)))) return true;
  const words = ` ${String(description).toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return spellings
    .map((x) => String(x ?? "").trim().toLowerCase())
    .filter((x) => /^[a-z0-9]{3,4}$/.test(x))
    .some((x) => words.includes(` ${x} `));
}

/**
 * A SUPPLIER'S BRANCH, FROM ITS OWN PAPERS when the account doesn't say one: the number in front of
 * most of its documents ("4410-1100001" → 4410). A card payment at the counter is often printed with
 * that branch and nothing else. Only when at least two papers carry it and most of them do.
 */
export function branchFromNumbers(numbers: readonly (string | null | undefined)[]): string | null {
  const tally = new Map<string, number>();
  let n = 0;
  for (const raw of numbers) {
    const m = /^\s*(\d{3,6})[-\s]\d{4,}/.exec(String(raw ?? ""));
    if (!raw) continue;
    n++;
    if (m) tally.set(m[1], (tally.get(m[1]) ?? 0) + 1);
  }
  const [best, count] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return best && count >= 2 && count / n >= 0.6 ? best : null;
}

/** Do two lines' words name the same merchant (a word of 3+ letters in common, the same check
 *  number, or one of them naming nobody at all)? */
function sameLineWords(a: { description: string; check: string | null }, b: { description: string; check: string | null }): boolean {
  if (a.check && b.check) return a.check === b.check;
  const wa = merchantWords(a.description).filter((w) => w.length >= 3);
  const wb = new Set(merchantWords(b.description).filter((w) => w.length >= 3));
  if (!wa.length || !wb.size) return true;
  return wa.some((w) => wb.has(w));
}

/** Does the line name the bill's supplier: a word of 3+ letters they share ("HOME HARDWARE #55" and
 *  "Home Hardware"), or the first 5 letters of the supplier's name ("LOWES #1234" and "Lowe's")? */
export function lineNamesSupplier(description: string, supplier: string): boolean {
  const words = new Set(merchantWords(description).filter((w) => w.length >= 3));
  if (merchantWords(supplier).some((w) => w.length >= 3 && words.has(w))) return true;
  const start = compact(supplier).slice(0, 5);
  return start.length >= 4 && compact(description).includes(start);
}

const FUEL_RE =
  /\b(fuel|gas|gasoline|diesel|petrol|shell|chevron|texaco|exxon|mobil|arco|valero|sinclair|conoco|phillips|marathon|citgo|sunoco|maverik|pilot|loves|flying j|circle k|speedway|costco gas|gas station|fuel stop|truck stops?|travel cent(er|re)s?|travel plazas?)\b/i;
/** Auto is asked BEFORE Fuel, so a service at a fuel brand ("CHEVRON CAR WASH", "SHELL OIL CHANGE")
 *  is Auto. So a bare "truck" must never be a truck stop's: "FLYING J TRUCK STOP" is a fill-up. */
const AUTO_RE = /\b(auto parts|autozone|o ?reilly|napa|jiffy|lube|oil change|tire|tires|car wash|smog|dmv|registration|towing|mechanic|auto repair|truck(?!\s+stops?\b))\b/i;
const INSURANCE_RE = /\b(insur\w*|ins prem|premium|liability|bond|bonding|licen[cs]e\w*|cslb)\b/i;
const FEE_RE = /\b(fee|fees|service charge|overdraft|nsf|interest charge|finance charge|monthly maintenance|wire fee)\b/i;
const PHONE_RE = /\b(verizon|at&t|att|t-mobile|tmobile|sprint|comcast|xfinity|spectrum|internet|wireless|phone|google|microsoft|adobe|dropbox|quickbooks|intuit|office)\b/i;
const TOOLS_RE = /\b(home depot|lowes|lowe s|harbor freight|ace hardware|hardware|tool|tools|grainger|fastenal|menards)\b/i;
/** An ATM, said as one: never a bare "Withdrawal", which many banks print before every debit
 *  (a card purchase, an ACH bill, a transfer to the owner). */
const ATM_RE = /\b(atm|cash withdrawal)\b/i;
const PAY_WORDS_RE = /\b(zelle|venmo|cash app|cashapp|payroll|transfer|xfer)\b/i;

const FUEL: BankChoice = { choice: "cost", bucket: "Fuel" };
const AUTO: BankChoice = { choice: "cost", bucket: "Auto" };

/** A crew member the line names by first name. */
function crewNamed(description: string, crew: readonly BooksCrew[]): BooksCrew | null {
  const d = ` ${description.toLowerCase().replace(/[^a-z]+/g, " ")} `;
  const hits = crew.filter((p) => {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return first.length >= 3 && d.includes(` ${first} `);
  });
  return hits.length === 1 ? hits[0] : null;
}

/** How many days AFTER a deposit posted a payment of its money may have been recorded and still be
 *  "very likely that payment": the books read payments up to the download's last day + 10
 *  (bank-core loadBankBooks), and a payment written down a week after the bank took it is common. */
export const LOOKALIKE_AFTER_DAYS = 10;

/** A payment already in North of this deposit's money, recorded up to 30 days before it posted
 *  (or 10 after), that no line took: the deposit is very likely that payment, just not surely.
 *  With `invoiceId`, only a payment on that invoice. */
export function lookalikePayment(line: BankLine, books: Pick<BankBooks, "payments">, used?: ReadonlySet<string>, invoiceId?: string): BooksPayment | null {
  if (line.cents <= 0) return null;
  const hits = books.payments.filter((p) => {
    if (used?.has(p.id)) return false;
    if (invoiceId && p.invoiceId !== invoiceId) return false;
    const d = dayDiff(line.postedOn, p.day);
    return d >= -LOOKALIKE_AFTER_DAYS && d <= 30 && (p.cents === line.cents || bankCentsOf(p) === line.cents);
  });
  return hits.sort((a, b) => Math.abs(dayDiff(line.postedOn, a.day)) - Math.abs(dayDiff(line.postedOn, b.day)) || a.id.localeCompare(b.id))[0] ?? null;
}

/** The one open invoice whose balance is exactly this deposit, or null (none, or two). */
export function invoiceByBalance(line: BankLine, books: Pick<BankBooks, "invoices">): BooksInvoice | null {
  if (line.cents <= 0) return null;
  const hits = books.invoices.filter((i) => i.balanceCents === line.cents);
  return hits.length === 1 ? hits[0] : null;
}

/** THE GUESS for a line nothing matched and no rule placed. Never picked; marked Guess. */
export function guessFor(line: BankLine, books: BankBooks, used?: ReadonlySet<string>): BankChoice | null {
  if (line.cents > 0) {
    // A payment already in North of this money (a way of paying the bank's words don't say, or
    // further back or later than a sure match reaches): already counted, never Other Income on top
    // of it, and never a SECOND payment on an invoice whose balance happens to be the same money
    // (a 50% deposit, an equal last installment): that counted Received twice and called the
    // invoice paid (review of release/v1026). Asked FIRST; the invoice stays a button (buttonsFor).
    if (lookalikePayment(line, books, used)) return { choice: "not_income" };
    const hit = invoiceByBalance(line, books);
    if (hit) return { choice: "invoice", invoiceId: hit.id };
    // Money moved in from another of the company's own accounts is not income, and neither is the
    // payment that shows as money in on a card's own download ("Payment Thank You"); a processor's
    // payout of customers' money is income, and gets no guess (the person says which).
    if ((TRANSFER_RE.test(line.description) || CARD_THANKS_RE.test(line.description)) && !PROCESSOR_RE.test(line.description)) return { choice: "not_income" };
    return null;
  }
  const amount = -line.cents;
  if (line.check || /\bcheck\b/i.test(line.description)) {
    const named = crewNamed(line.description, books.crew);
    if (named) return { choice: "crew", profileId: named.id };
    const byAmount = [...new Set(books.crewPaid.filter((p) => p.cents === amount).map((p) => p.profileId))].filter((id) => books.crew.some((c) => c.id === id));
    if (byAmount.length === 1) return { choice: "crew", profileId: byAmount[0] };
    if (books.crew.length === 1) return { choice: "crew", profileId: books.crew[0].id };
  }
  const account = books.accounts.find((a) => a.onAccount && lineNamesAccount(line.description, a));
  if (account) return { choice: "supplier", supplierAccountId: account.id };
  const named = PAY_WORDS_RE.test(line.description) ? crewNamed(line.description, books.crew) : null;
  if (named) return { choice: "crew", profileId: named.id };
  const d = line.description.replace(/[*_]/g, " ");
  // A transfer is asked first: "ONLINE TRANSFER WITHDRAWAL TO XXXX9876" is the owner's, not an ATM.
  if (TRANSFER_RE.test(d) && !PROCESSOR_RE.test(d)) return { choice: "draw" };
  // An ATM: Cash Taken Out (Not A Cost). The cash counts when its receipts come in.
  if (ATM_RE.test(d)) return { choice: "cash_out" };
  if (INSURANCE_RE.test(d)) return { choice: "cost", bucket: "Insurance & Licenses" };
  if (FEE_RE.test(d)) return { choice: "cost", bucket: "Fees" };
  if (AUTO_RE.test(d)) return AUTO;
  if (FUEL_RE.test(d)) return FUEL;
  if (PHONE_RE.test(d)) return { choice: "cost", bucket: "Phone & Office" };
  if (TOOLS_RE.test(d)) return { choice: "cost", bucket: "Tools & Supplies" };
  return null;
}

/** How far past its band a rule still reaches: half its smallest amount to twice its largest. */
export const RULE_STRETCH = 2;
/** Amounts further apart than this (largest over smallest) are two rows, and two answers. */
export const SPLIT_RATIO = 4;

/** The company's rules for this line's merchant: same direction, the key a word-prefix of the line's
 *  words, the longest such key winning (all its answers). Checks with no payee and bare deposits
 *  have none. */
export function rulesFor(line: BankLine, rules: readonly BooksRule[]): BooksRule[] {
  const direction = line.cents > 0 ? "in" : "out";
  if (isBareCheck(line) || isGenericKey(line.merchantKey) || !line.merchantKey || isCustomerMoneyIn(line)) return [];
  const words = merchantWords(line.description).join(" ");
  const own = line.merchantKey;
  const hits = rules.filter((r) => r.direction === direction && (r.key === own || words === r.key || words.startsWith(`${r.key} `) || own.startsWith(`${r.key} `)));
  const longest = Math.max(0, ...hits.map((r) => r.key.length));
  return hits.filter((r) => r.key.length === longest).sort((a, b) => a.id.localeCompare(b.id));
}

/** Is this amount (cents, positive) inside the rule's band, stretched `stretch` times either way? */
function inBand(r: BooksRule, amount: number, stretch = RULE_STRETCH): boolean {
  if (r.minCents == null || r.maxCents == null) return true;
  return amount * stretch >= r.minCents && amount <= r.maxCents * stretch;
}

/** How far the amount is from the rule's band, as a ratio (1 inside it). */
function bandDistance(r: BooksRule, amount: number): number {
  if (r.minCents == null || r.maxCents == null || amount <= 0) return 1;
  if (amount < r.minCents) return r.minCents / amount;
  if (amount > r.maxCents) return amount / r.maxCents;
  return 1;
}

/** THE RULE THAT PLACES THIS LINE: the one answer whose band holds its amount. Two that both hold
 *  it (bands that overlap) settle on the one whose own band holds it exactly, or ask. */
export function ruleFor(line: BankLine, rules: readonly BooksRule[]): BooksRule | null {
  const amount = Math.abs(line.cents);
  const fitting = rulesFor(line, rules).filter((r) => inBand(r, amount));
  if (fitting.length <= 1) return fitting[0] ?? null;
  const exact = fitting.filter((r) => inBand(r, amount, 1));
  return exact.length === 1 ? exact[0] : null;
}

/** The merchant's nearest answer, for a line no band holds: the guess, never the answer. */
export function ruleHintFor(line: BankLine, rules: readonly BooksRule[]): BooksRule | null {
  const amount = Math.abs(line.cents);
  return [...rulesFor(line, rules)].sort((a, b) => bandDistance(a, amount) - bandDistance(b, amount) || a.id.localeCompare(b.id))[0] ?? null;
}

/** "$40.00 to $140.00", "$88.45", or "" for a rule with no band. */
export function sayBand(r: Pick<BooksRule, "minCents" | "maxCents">): string {
  if (r.minCents == null || r.maxCents == null) return "";
  return r.minCents === r.maxCents ? sayDollars(r.minCents / 100) : `${sayDollars(r.minCents / 100)} to ${sayDollars(r.maxCents / 100)}`;
}

/** A rule's choice, if it can still be used (its supplier or crew member is still here). */
export function ruleChoice(r: BooksRule, books: Pick<BankBooks, "accounts" | "crew">): BankChoice | null {
  switch (r.choice) {
    // OTHER INCOME IS NEVER A RULE'S (0363): money in that is income is a customer's until a person
    // says otherwise, every time. A rule on money in may only say Not Income.
    case "other_income":
      return null;
    case "cost":
      return isBusinessCostBucket(r.bucket) ? { choice: "cost", bucket: r.bucket } : null;
    case "supplier":
      return r.supplierAccountId && books.accounts.some((a) => a.id === r.supplierAccountId) ? { choice: "supplier", supplierAccountId: r.supplierAccountId } : null;
    case "crew":
      return r.profileId && books.crew.some((c) => c.id === r.profileId) ? { choice: "crew", profileId: r.profileId } : null;
    default:
      return { choice: r.choice } as BankChoice;
  }
}

/** Subsets of `pool` (size 2..6) whose cents add to `target`: stops at the second, since only
 *  exactly one group is a match. */
function groupsSumming(pool: { id: string; cents: number }[], target: number): string[][] {
  const found: string[][] = [];
  const pick: string[] = [];
  const walk = (start: number, left: number) => {
    if (found.length > 1) return;
    if (left === 0 && pick.length >= 2) {
      found.push([...pick]);
      return;
    }
    if (pick.length >= 6) return;
    for (let i = start; i < pool.length; i++) {
      if (pool[i].cents > left || pool[i].cents <= 0) continue;
      pick.push(pool[i].id);
      walk(i + 1, left - pool[i].cents);
      pick.pop();
      if (found.length > 1) return;
    }
  };
  walk(0, target);
  return found;
}

/** How the bank says money came in, from its words: a card processor's payout, a payment app's, a
 *  transfer, or paper (a check or cash deposited). Null when the words don't say. */
export type DepositKind = "card" | "venmo" | "zelle" | "paypal" | "cashapp" | "transfer" | "paper";
export function depositKindOf(description: string): DepositKind | null {
  const d = String(description ?? "").toLowerCase();
  if (/\b(stripe|square|sq|clover|toast|shopify|intuit|quickbooks|merchant|card)\b/.test(d)) return "card";
  if (/\bvenmo\b/.test(d)) return "venmo";
  if (/\bzelle\b/.test(d)) return "zelle";
  if (/\bpaypal\b/.test(d)) return "paypal";
  if (/\bcash\s*app\b/.test(d)) return "cashapp";
  if (/\b(ach|transfer|xfer|wire)\b/.test(d)) return "transfer";
  if (/\b(deposits?|dep|mobile|remote|branch|atm|regular|teller|check|cheque|counter|dslip|cash)\b/.test(d)) return "paper";
  return null;
}

/** The payment methods (0287 keys) each kind of deposit carries; a method not listed here (other, a
 *  custom one) says nothing. */
const KIND_METHODS: Record<DepositKind, readonly string[]> = {
  card: ["card"],
  venmo: ["venmo"],
  zelle: ["zelle"],
  paypal: ["paypal"],
  cashapp: ["cashapp"],
  transfer: ["ach", "transfer"],
  paper: ["check", "cash"],
};
const KNOWN_METHODS = new Set(Object.values(KIND_METHODS).flat());

/** A payment's kind of deposit, or null when its method says nothing. */
function paymentKindOf(p: BooksPayment): DepositKind | null {
  if (p.stripe) return "card";
  const m = String(p.method ?? "").toLowerCase();
  if (!KNOWN_METHODS.has(m)) return null;
  return (Object.keys(KIND_METHODS) as DepositKind[]).find((k) => KIND_METHODS[k].includes(m)) ?? null;
}

/** What a payment put in the bank: a card payment arrives less the card fee (0284), and an unknown
 *  fee means an unknown deposit (never read NULL as $0). */
function bankCentsOf(p: BooksPayment): number | null {
  if (!p.stripe) return p.cents;
  return p.feeCents === null ? null : p.cents - p.feeCents;
}

/**
 * THE PLAN: what each line is (already here, a match, a rule's, or a question) and the questions as
 * one row per merchant. Pure, deterministic for the same download and books (the fingerprint).
 */
export function planBankDownload(dl: BankDownload, books: BankBooks): BankPlan {
  const lines = [...dl.lines].sort((a, b) => a.postedOn.localeCompare(b.postedOn) || a.row - b.row);
  const dispositions = new Map<string, Disposition>();
  const used = new Set<string>();
  const counts = { lines: lines.length, already: 0, matched: 0, ruled: 0, needLines: 0, needRows: 0 };
  const byDistance = <T extends { day: string | null; id: string }>(day: string) => (a: T, b: T) =>
    Math.abs(dayDiff(day, a.day ?? day)) - Math.abs(dayDiff(day, b.day ?? day)) || a.id.localeCompare(b.id);

  /** SURE: the bank's words and the payment's method agree (up to 30 days back). LOOSE: one of
   *  them says nothing (up to 7 days back), only after every line had its sure pass. */
  type Pass = "sure" | "loose";
  const match = (line: BankLine, pass: Pass): Disposition | null => {
    const amount = -line.cents;
    // A BILL FOR THE SAME MONEY within 3 days, not one a supplier account pays. Sure: the line names
    // the bill's supplier. Loose: the line names nobody, so the amount is all there is to go on. A
    // transfer between the company's own accounts is never a bill. Money IN is a return or a
    // supplier's credit already on the books as a negative bill of the same money.
    const billMatch = (): Disposition | null => {
      if (TRANSFER_RE.test(line.description) && !PROCESSOR_RE.test(line.description)) return null;
      const namesNobody = isBareCheck(line) || !merchantWords(line.description).some((w) => w.length >= 3);
      if (pass === "loose" && !namesNobody) return null;
      const near = books.bills.filter((b) => !used.has(b.id) && !b.onAccount && b.cents === amount && b.day && Math.abs(dayDiff(line.postedOn, b.day)) <= 3);
      const hits = pass === "sure" ? near.filter((b) => lineNamesSupplier(line.description, b.supplier)) : near;
      if (!hits.length) return null;
      hits.sort(byDistance(line.postedOn));
      const b = hits[0];
      // A MATCH ONLY MARKS: the bill keeps the bucket (or job) it was filed in. A pump receipt a
      // person filed as Fuel is already Fuel (0362); the line never re-files it.
      return { how: "match", table: "bills", ids: [b.id], said: `${line.cents > 0 ? "Return from " : ""}${b.supplier} already on the books` };
    };
    if (line.cents > 0) {
      const kind = depositKindOf(line.description);
      const fits = (p: BooksPayment) => {
        const pk = paymentKindOf(p);
        return pass === "sure" ? kind !== null && pk === kind : kind === null || pk === null;
      };
      // ONE PAYMENT: recorded before the deposit posts (30 days when sure, 7 when not), or up to 3
      // days after it.
      const back = pass === "sure" ? 30 : 7;
      const window = (p: BooksPayment) => {
        const d = dayDiff(line.postedOn, p.day);
        return d >= -3 && d <= back && !used.has(p.id) && fits(p);
      };
      const one = books.payments.filter((p) => window(p) && bankCentsOf(p) === line.cents).sort(byDistance(line.postedOn));
      if (one.length) {
        const p = one[0];
        return { how: "match", table: "payments", ids: [p.id], said: `Payment on ${p.invoiceNumber}` };
      }
      // A GROUP: one card payout, or one Venmo sweep, and only when exactly one group adds up.
      for (const pool of [
        books.payments.filter((p) => window(p) && p.stripe && bankCentsOf(p) !== null),
        books.payments.filter((p) => window(p) && !p.stripe && p.method === "venmo"),
      ]) {
        const near = pool.sort(byDistance(line.postedOn)).slice(0, 14);
        const sums = groupsSumming(near.map((p) => ({ id: p.id, cents: bankCentsOf(p) ?? 0 })), line.cents);
        if (sums.length === 1) {
          const picked = near.filter((p) => sums[0].includes(p.id));
          const numbers = [...new Set(picked.map((p) => p.invoiceNumber))].join(", ");
          const card = picked[0].stripe;
          return { how: "match", table: "payments", ids: sums[0], said: `${picked.length} ${card ? "card" : "Venmo"} payments (${numbers})${card ? ", less the card fees" : ""}` };
        }
      }
      return billMatch();
    }
    if (pass === "loose") return billMatch();
    // A CHECK BY ITS NUMBER: a crew payment or a supplier payment that wrote it down.
    if (line.check) {
      const crew = books.payPayments.find((p) => !used.has(p.id) && digitsOnly(p.reference).replace(/^0+/, "") === line.check && p.cents === amount);
      if (crew) return { how: "match", table: "pay_payments", ids: [crew.id], said: `Check ${line.check}, crew pay` };
      const sup = books.supplierPayments.find((p) => !used.has(p.id) && digitsOnly(p.reference).replace(/^0+/, "") === line.check && p.cents === amount);
      if (sup) return { how: "match", table: "supplier_payments", ids: [sup.id], said: `Check ${line.check}, supplier payment` };
    }
    // CREW PAY BY AMOUNT, on a check or a line that names a way crew are paid (or the person). A
    // transfer between the company's own accounts is never crew pay, however much it moved: it
    // names no crew member and no payment app, so it is the owner's (a draw) or a move to savings.
    const named = crewNamed(line.description, books.crew);
    const ownTransfer = TRANSFER_RE.test(line.description) && !PROCESSOR_RE.test(line.description) && !named;
    if (!ownTransfer && (line.check || /\bcheck\b/i.test(line.description) || PAY_WORDS_RE.test(line.description) || named)) {
      const hits = books.payPayments
        .filter((p) => !used.has(p.id) && p.cents === amount && inPayWindow(line.postedOn, p.day))
        .sort(byDistance(line.postedOn));
      if (hits.length) return { how: "match", table: "pay_payments", ids: [hits[0].id], said: "Crew pay already recorded" };
    }
    // A SUPPLIER'S OWN PAYMENT, when the line names the account.
    const accountsNamed = books.accounts.filter((a) => lineNamesAccount(line.description, a)).map((a) => a.id);
    if (accountsNamed.length) {
      const hits = books.supplierPayments
        .filter((p) => !used.has(p.id) && accountsNamed.includes(p.accountId) && p.cents === amount && inPayWindow(line.postedOn, p.day))
        .sort(byDistance(line.postedOn));
      if (hits.length) {
        const who = books.accounts.find((a) => a.id === hits[0].accountId)?.name ?? "the supplier";
        return { how: "match", table: "supplier_payments", ids: [hits[0].id], said: `Payment to ${who} already recorded` };
      }
    }
    // AN ATM WITHDRAWAL that is a petty-cash top-up already written down.
    if (ATM_RE.test(line.description)) {
      const hits = books.pettyCash
        .filter((p) => !used.has(p.id) && p.kind === "replenish" && p.cents === amount && Math.abs(dayDiff(line.postedOn, p.day)) <= 3)
        .sort(byDistance(line.postedOn));
      if (hits.length) return { how: "match", table: "petty_cash", ids: [hits[0].id], said: "Petty cash top-up already recorded" };
    }
    return billMatch();
  };

  // ALREADY, then MATCHES in two passes over every line, then rules and questions.
  for (const line of lines) {
    if (!books.already.has(line.key)) continue;
    dispositions.set(line.key, { how: "already" });
    counts.already++;
  }
  // THE SAME LINE UNDER ANOTHER KEY: a line another download (another format) already counted.
  // Each stored line stands for one line here, and a line this download carries under its own key
  // is never anyone's twin.
  const mine = new Set(lines.map((l) => l.key));
  const twins = new Set<string>();
  for (const line of lines) {
    if (dispositions.has(line.key)) continue;
    const twin = (books.stored ?? [])
      .filter(
        (s) => !mine.has(s.key) && !twins.has(s.key) && s.cents === line.cents && Math.abs(dayDiff(line.postedOn, s.postedOn)) <= 2 && sameLineWords(line, s) && (!s.last4 || !line.last4 || s.last4 === line.last4),
      )
      .sort((a, b) => Math.abs(dayDiff(line.postedOn, a.postedOn)) - Math.abs(dayDiff(line.postedOn, b.postedOn)) || a.key.localeCompare(b.key))[0];
    if (!twin) continue;
    twins.add(twin.key);
    dispositions.set(line.key, { how: "already" });
    counts.already++;
  }
  for (const pass of ["sure", "loose"] as const) {
    for (const line of lines) {
      if (dispositions.has(line.key)) continue;
      const m = match(line, pass);
      if (!m || m.how !== "match") continue;
      for (const id of m.ids) used.add(id);
      dispositions.set(line.key, m);
      counts.matched++;
    }
  }

  // RULES, then the questions that are left.
  const asking: { line: BankLine; direction: "in" | "out"; guess: BankChoice | null; single: boolean }[] = [];
  for (const line of lines) {
    if (dispositions.has(line.key)) continue;
    const direction = line.cents > 0 ? "in" : "out";
    const rule = ruleFor(line, books.rules);
    const rc = rule ? ruleChoice(rule, books) : null;
    // Money in that is exactly an open invoice's balance is asked, whatever a rule says (even when
    // the guess is Already Counted: a payment of that money is already in North).
    const onInvoice = !!invoiceByBalance(line, books);
    if (rule && rc && !onInvoice && choiceFits(rc, direction)) {
      dispositions.set(line.key, { how: "rule", ruleId: rule.id, choice: rc });
      counts.ruled++;
      continue;
    }
    // Outside every band the merchant has: its nearest answer is the guess (asked, never placed).
    const hint = rule ? null : ruleHintFor(line, books.rules);
    const hinted = hint ? ruleChoice(hint, books) : null;
    const guess = onInvoice ? guessFor(line, books, used) : hinted && choiceFits(hinted, direction) ? hinted : guessFor(line, books, used);
    const single =
      isBareCheck(line) || !line.merchantKey || isGenericKey(line.merchantKey) || onInvoice || guess?.choice === "invoice" || (direction === "out" && !!line.check) || isCustomerMoneyIn(line);
    asking.push({ line, direction, guess, single });
  }
  // ONE ROW PER MERCHANT, SPLIT BY AMOUNT: a merchant's lines far apart in size (a fill-up and a
  // coffee at one store) are separate rows, so one tap never answers both.
  const bandOf = new Map<string, number>();
  const bandsPer = new Map<string, number>();
  const amountsBy = new Map<string, number[]>();
  for (const a of asking) {
    if (a.single) continue;
    const k = `${a.direction}:${a.line.merchantKey}`;
    amountsBy.set(k, [...(amountsBy.get(k) ?? []), Math.abs(a.line.cents)]);
  }
  for (const [k, amounts] of amountsBy) {
    const sorted = [...new Set(amounts)].sort((a, b) => a - b);
    let band = 0;
    let low = sorted[0];
    for (const amt of sorted) {
      if (amt > low * SPLIT_RATIO) {
        band++;
        low = amt;
      }
      bandOf.set(`${k}|${amt}`, band);
    }
    bandsPer.set(k, band + 1);
  }
  const groups = new Map<string, NeedGroup>();
  for (const { line, direction, guess, single } of asking) {
    // A QUESTION: one row per merchant (and amount band); a check, a deposit an invoice may be, or a
    // line with no merchant words is a row of its own.
    const k = `${direction}:${line.merchantKey}`;
    const id = single ? `line:${line.key.slice(-16)}` : (bandsPer.get(k) ?? 1) > 1 ? `${k}#${(bandOf.get(`${k}|${Math.abs(line.cents)}`) ?? 0) + 1}` : k;
    let g = groups.get(id);
    if (!g) {
      g = {
        id,
        direction,
        label: line.description,
        keys: [],
        cents: 0,
        each: line.cents,
        first: line.postedOn,
        last: line.postedOn,
        check: line.check,
        single,
        guess: guess ? choiceId(guess) : null,
        buttons: [],
        learnable: !single && !!line.merchantKey && !isGenericKey(line.merchantKey),
        merchantKey: line.merchantKey,
        hint: (() => {
          const p = lookalikePayment(line, books, used);
          return p ? `Maybe the payment on ${p.invoiceNumber} of ${sayRange(p.day, p.day)}, already in North.` : null;
        })(),
      };
      groups.set(id, g);
    }
    g.keys.push(line.key);
    g.cents += line.cents;
    if (g.each !== line.cents) g.each = null;
    if (line.postedOn < g.first) g.first = line.postedOn;
    if (line.postedOn > g.last) g.last = line.postedOn;
    dispositions.set(line.key, { how: "need", group: id });
    counts.needLines++;
  }
  const out = [...groups.values()];
  for (const g of out) {
    // One line may go on an invoice, whatever its merchant; several may not.
    g.single = g.keys.length === 1;
    g.buttons = buttonsFor(g, books);
  }
  // The biggest money first: that is the row worth the tap.
  out.sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.id.localeCompare(b.id));
  counts.needRows = out.length;
  const fingerprint = fingerprintOf(
    lines.map((l) => {
      const d = dispositions.get(l.key)!;
      const tail = d.how === "match" ? `${d.table}:${d.ids.join(",")}` : d.how === "rule" ? `${d.ruleId}:${choiceId(d.choice)}` : d.how === "need" ? d.group : "";
      return `${l.key}:${d.how}:${tail}`;
    }),
  );
  return { dispositions, groups: out, counts, fingerprint };
}

/** The buttons on a question row: the guess first, then the usual answers for that kind of line. */
function buttonsFor(g: NeedGroup, books: BankBooks): string[] {
  const out: string[] = [];
  const add = (id: string | null) => {
    if (id && !out.includes(id)) out.push(id);
  };
  add(g.guess);
  if (g.direction === "in") {
    // With no guess, Already Counted comes before Other Income: a deposit already in North counted
    // again as income is money that never came in twice.
    if (!g.guess) add("not_income");
    // One deposit that is exactly an open invoice's balance keeps that invoice a tap away, even when
    // the guess is Already Counted (a payment of the same money is already in North).
    const onInvoice = g.single ? books.invoices.filter((i) => i.balanceCents === g.cents) : [];
    if (onInvoice.length === 1) add(choiceId({ choice: "invoice", invoiceId: onInvoice[0].id }));
    add("other_income");
    add("not_income");
    return out.slice(0, 3);
  }
  if (g.check) {
    for (const c of books.crew.slice(0, 2)) add(`crew:${c.id}`);
    if (out.length < 2) add("personal");
    return out.slice(0, 2);
  }
  // Fuel and Auto are each other's second: a fill-up guessed as a repair, or the other way round.
  if (g.guess === choiceId(FUEL)) add(choiceId(AUTO));
  if (g.guess === choiceId(AUTO)) add(choiceId(FUEL));
  add("personal");
  add("draw");
  add(choiceId(FUEL));
  return out.slice(0, 3);
}

/** Every answer a row may take, for its Other… list. */
export function everyChoice(direction: "in" | "out", books: Pick<BankBooks, "accounts" | "crew" | "invoices">, single: boolean): BankChoice[] {
  if (direction === "in") {
    const out: BankChoice[] = [];
    if (single) for (const i of books.invoices) out.push({ choice: "invoice", invoiceId: i.id });
    out.push({ choice: "other_income" }, { choice: "not_income" });
    // A REFUND OF A COST: money back from a store or a supplier comes off that bucket.
    for (const b of BUSINESS_COST_BUCKETS) out.push({ choice: "cost", bucket: b });
    return out;
  }
  // Every bucket, Fuel and Auto first (the list's own order).
  const out: BankChoice[] = BUSINESS_COST_BUCKETS.map((b): BankChoice => ({ choice: "cost", bucket: b }));
  out.push({ choice: "draw" }, { choice: "personal" }, { choice: "cash_out" }, { choice: "not_cost" });
  for (const a of books.accounts) if (a.onAccount) out.push({ choice: "supplier", supplierAccountId: a.id });
  for (const c of books.crew) out.push({ choice: "crew", profileId: c.id });
  return out;
}

// ── WHAT THE CARD SAYS ─────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Aug 26–Sep 25" (the year only when the range is not this year). */
export function sayRange(from: string | null, to: string | null, today?: string | null): string {
  if (!from || !to) return "no dates";
  const year = (d: string) => (today && today.slice(0, 4) !== d.slice(0, 4) ? { year: "numeric" as const } : {});
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...year(d) });
  return from === to ? f(from) : `${f(from)}–${f(to)}`;
}

/** THE ONE LINE: "Bank ••1234 · Aug 26–Sep 25 · 96 sorted · 17 already in North · 5 need you, in 3
 *  rows". Every figure counts LINES, as Apply's "N lines left for later" does; the rows are said
 *  beside them when a row holds several. */
export function bankHeadline(dl: Pick<BankDownload, "last4" | "from" | "to">, counts: BankPlan["counts"], today?: string | null): string {
  const parts = [dl.last4 ? `Bank ••${dl.last4}` : "Bank download", sayRange(dl.from, dl.to, today)];
  const sorted = counts.matched + counts.ruled;
  if (sorted) parts.push(`${sorted} sorted`);
  if (counts.already) parts.push(`${counts.already} already in North`);
  parts.push(
    !counts.needRows ? "nothing needs you" : counts.needLines === counts.needRows ? `${counts.needLines} need you` : `${counts.needLines} need you, in ${counts.needRows} rows`,
  );
  return parts.join(" · ");
}

/** Where the money went, out of the account: one segment per place, biggest first. */
export type FlowSegment = { key: string; label: string; cents: number };

/**
 * THE BAR'S SEGMENTS, in Money by Month's words (money-chart.ts): Fuel on its own (the Fuel
 * bucket, the one Erik watches), every other business cost as ONE Overhead segment (the profit and
 * loss's own word for them, profit-and-loss.ts; six pinks side by side read as one colour anyway,
 * and the legend is the place for names), Materials & Bills, Crew Pay, Owner's Draw (here: money the
 * owner took out of the account). The rest are the bank's own: Suppliers, Cash Taken Out,
 * Transfers, Personal, Already In North, Needs You.
 *
 * THIS BAR IS A BREAKDOWN, so every dollar lands in exactly one segment: Fuel out on its own means
 * the Overhead segment here is the OTHER buckets, even though Fuel is an Overhead bucket itself
 * (2026-09-30) and Money by Month's Overhead BAR carries the whole total, fuel included. Each is
 * true of what it draws; neither counts a dollar twice inside itself.
 */
export function flowLabelOf(choice: string, bucket: string | null): { key: string; label: string } {
  switch (choice) {
    case "cost": {
      const b = bucketOf(bucket);
      if (b === "Fuel") return { key: "fuel", label: "Fuel" };
      // Overhead is the buckets BUCKET_SECTION says it is, never a guess. Every bucket is Overhead
      // today; one ever moved to Cost of Goods Sold (COGS) gets its own segment, by its own name,
      // rather than being drawn as Overhead it is not.
      return BUCKET_SECTION[b] === "overhead" ? { key: "business", label: PNL_WORDS.overhead } : { key: `bucket:${b}`, label: b };
    }
    case "draw":
      return { key: "draw", label: "Owner's Draw" };
    case "personal":
      return { key: "personal", label: "Personal" };
    // An ATM's cash (W1-34), its own segment: no cost yet, and never the owner's. A line stored under
    // the old word (an ATM top-up applied before) is the same money.
    case "cash_out":
    case CASH_OUT_STORED:
      return { key: "cash_out", label: "Cash Taken Out" };
    case "not_cost":
      return { key: "not_cost", label: "Transfers" };
    case "supplier":
      return { key: "suppliers", label: "Suppliers" };
    case "crew":
      return { key: "crew", label: "Crew Pay" };
    default:
      return { key: "other", label: "Other" };
  }
}

export function moneyFlow(dl: BankDownload, plan: BankPlan, books: BankBooks): { out: FlowSegment[]; inCents: number; outCents: number } {
  const seg = new Map<string, FlowSegment>();
  const add = (k: { key: string; label: string }, cents: number) => {
    const s = seg.get(k.key) ?? { ...k, cents: 0 };
    s.cents += cents;
    seg.set(k.key, s);
  };
  let inCents = 0;
  let outCents = 0;
  const billOf = new Map(books.bills.map((b) => [b.id, b]));
  for (const l of dl.lines) {
    if (l.cents > 0) {
      inCents += l.cents;
      continue;
    }
    const amt = -l.cents;
    outCents += amt;
    const d = plan.dispositions.get(l.key);
    if (!d) continue;
    if (d.how === "already") {
      const a = books.already.get(l.key);
      if (a?.choice === "matched" || !a) add({ key: "books", label: "Already In North" }, amt);
      else add(flowLabelOf(a.choice, a.bucket), amt);
    } else if (d.how === "rule") {
      const c = d.choice;
      add(flowLabelOf(c.choice, c.choice === "cost" ? c.bucket : null), amt);
    } else if (d.how === "match") {
      if (d.table === "supplier_payments") add({ key: "suppliers", label: "Suppliers" }, amt);
      else if (d.table === "pay_payments") add({ key: "crew", label: "Crew Pay" }, amt);
      else if (d.table === "petty_cash") add(flowLabelOf("cash_out", null), amt);
      else {
        const b = billOf.get(d.ids[0]);
        add(b && !b.jobId ? flowLabelOf("cost", b.category) : { key: "materials", label: "Materials & Bills" }, amt);
      }
    } else add({ key: "need", label: "Needs You" }, amt);
  }
  return { out: [...seg.values()].sort((a, b) => b.cents - a.cents), inCents, outCents };
}

/** "$288.45"; several lines: "3 charges · $288.45" (the total), or "3× $96.15" only when every
 *  line is that same amount (a price after "3×" reads as each one's). */
export function sayGroupMoney(g: Pick<NeedGroup, "keys" | "cents" | "direction"> & { each?: number | null }): string {
  const n = g.keys.length;
  if (n <= 1) return sayDollars(Math.abs(g.cents) / 100);
  if (g.each != null) return `${n}× ${sayDollars(Math.abs(g.each) / 100)}`;
  return `${n} ${g.direction === "in" ? "deposits" : "charges"} · ${sayDollars(Math.abs(g.cents) / 100)}`;
}

/** What a row says on its line: "SHELL 123 ANYTOWN", "Check 1043", "Deposit Sep 4". */
export function groupTitle(g: Pick<NeedGroup, "label" | "check" | "direction" | "first">, today?: string | null): string {
  if (g.check && g.direction === "out") return `Check ${g.check}`;
  const label = g.label.replace(/^\s*\d{4}-/, "").trim();
  if (g.direction === "in" && /^deposit$/i.test(label)) return `Deposit ${sayRange(g.first, g.first, today)}`;
  return label || (g.direction === "in" ? "Deposit" : "Withdrawal");
}

export { plural as sayCount };

// ── THE PERSON'S ANSWERS ───────────────────────────────────────────────────────────────────────

/**
 * The picks Apply may use: only for rows the plan has, only an answer that fits the row (money in
 * takes income answers; an invoice only on a single deposit), and only names this company has.
 * Anything else is dropped and said.
 */
export function validPicks(
  picks: Record<string, unknown> | null | undefined,
  plan: Pick<BankPlan, "groups">,
  books: Pick<BankBooks, "accounts" | "crew" | "invoices">,
): { ok: Map<string, BankChoice>; refused: string[] } {
  const ok = new Map<string, BankChoice>();
  const refused: string[] = [];
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  for (const [gid, raw] of Object.entries(picks ?? {})) {
    const g = byId.get(gid);
    if (!g) {
      refused.push("an answer for a row that is no longer on the card");
      continue;
    }
    const c = parseChoiceId(raw);
    if (!c || !choiceFits(c, g.direction)) {
      refused.push(`${groupTitle(g)}: that answer doesn't fit ${g.direction === "in" ? "money in" : "money out"}`);
      continue;
    }
    if (c.choice === "invoice" && (!g.single || !books.invoices.some((i) => i.id === c.invoiceId && i.balanceCents >= g.cents))) {
      refused.push(`${groupTitle(g)}: that invoice isn't open for that much`);
      continue;
    }
    if (c.choice === "supplier" && !books.accounts.some((a) => a.id === c.supplierAccountId)) {
      refused.push(`${groupTitle(g)}: that supplier isn't one of yours`);
      continue;
    }
    if (c.choice === "crew" && !books.crew.some((p) => p.id === c.profileId)) {
      refused.push(`${groupTitle(g)}: that person isn't on your crew`);
      continue;
    }
    ok.set(gid, c);
  }
  // TWO DEPOSITS ON ONE INVOICE are held to its balance TOGETHER: each alone may fit, both may not.
  const onInvoice = new Map<string, string[]>();
  for (const [gid, c] of ok) if (c.choice === "invoice") onInvoice.set(c.invoiceId, [...(onInvoice.get(c.invoiceId) ?? []), gid]);
  for (const [invoiceId, gids] of onInvoice) {
    if (gids.length < 2) continue;
    const inv = books.invoices.find((i) => i.id === invoiceId);
    const total = gids.reduce((n, gid) => n + (byId.get(gid)?.cents ?? 0), 0);
    if (inv && total <= inv.balanceCents) continue;
    for (const gid of gids) ok.delete(gid);
    refused.push(`${gids.length} deposits (${sayDollars(total / 100)}) are more than the ${sayDollars((inv?.balanceCents ?? 0) / 100)} open on ${inv?.number ?? "that invoice"}`);
  }
  return { ok, refused };
}

/** The same bucket words the business-cost list uses, for a check in the migration tests. */
export const BANK_BUCKETS: readonly BusinessCostBucket[] = BUSINESS_COST_BUCKETS;

// ── THE CARD, AS THE PAGE HANDS IT OVER ────────────────────────────────────────────────────────

/** What Apply did, one entry per press (a download can be applied in passes: the rows left for
 *  later wait on the card). */
export type BankAppliedPass = {
  at: string;
  by: string | null;
  fingerprint: string;
  lines: number;
  matched: number;
  ruled: number;
  picked: number;
  left: number;
};

/** On organized_items.proposal.bankImport: the lines as read (redacted), and what Apply did. */
export type StoredBank = {
  download: BankDownload;
  applied?: BankAppliedPass[] | null;
  /** When Apply claimed the row, until it finished the writes (an ISO time; `true` from before). */
  pending?: string | boolean | null;
  /** Only on the copy a page hands the browser (bank-core bankLinesStayHere), whose `download` has
   *  no lines: how many it has, for a viewer who sorts bank downloads; null for one who doesn't.
   *  Never stored. */
  lineCount?: number | null;
};

/** Minutes after which a claim that never finished is taken as dead (a lost request), so Undo can
 *  run: Apply takes seconds, and a card must never be stuck behind a claim nobody holds. */
export const APPLY_CLAIM_MINUTES = 5;

/** Is an Apply still writing this download right now? */
export function applyingNow(stored: Pick<StoredBank, "pending"> | null | undefined, now = Date.now()): boolean {
  const p = stored?.pending;
  if (!p) return false;
  if (typeof p !== "string") return false;
  const at = Date.parse(p);
  return Number.isFinite(at) && now - at < APPLY_CLAIM_MINUTES * 60_000;
}

export type BankButton = { id: string; label: string };
export type BankRowView = {
  id: string;
  title: string;
  money: string;
  dates: string;
  /** "Maybe the payment on INV-1001 of Sep 1, already in North." or null. */
  hint?: string | null;
  /** A single deposit's own Other… list: only the invoices open for at least its money, each said
   *  in full ("On INV-1001 · Pat Customer · $1,275.00 open"). Absent: the card's shared list. */
  others?: BankButton[];
  direction: "in" | "out";
  single: boolean;
  guess: string | null;
  buttons: BankButton[];
};

export type BankView = {
  headline: string;
  fingerprint: string;
  counts: BankPlan["counts"];
  rows: BankRowView[];
  /** The Other… lists: money out, money in, and money in on a single line (invoices too). */
  otherOut: BankButton[];
  otherIn: BankButton[];
  otherInSingle: BankButton[];
  flow: FlowSegment[];
  inCents: number;
  outCents: number;
  /** What Apply writes or marks without a question, by kind. */
  sorted: { label: string; n: number; cents: number }[];
  skipped: { line: number; why: string }[];
  appliedSaid: string | null;
  canUndo: boolean;
  /** Money in and out were read the other way round from how the file prints them. */
  swapped: boolean;
  /** Nothing applied yet: a person may still swap money in and out. */
  canSwap: boolean;
  /** No account on the file or its name: a person may say its last 4 (before anything applies). */
  askAccount: boolean;
  /** The company's rules that placed lines on this card, each with a way to forget it. */
  rules: { id: string; label: string; n: number }[];
  problem: string | null;
};

const MATCH_LABEL: Record<MatchTable, string> = {
  payments: "Payments Already Recorded",
  bills: "Bills Already On The Books",
  supplier_payments: "Supplier Payments Already Recorded",
  pay_payments: "Crew Pay Already Recorded",
  petty_cash: "Petty Cash Already Recorded",
};

/** "shell → Fuel ($40.00 to $140.00) · 3 lines": each rule that placed a line here. */
function rulesUsed(plan: BankPlan, books: BankBooks, names: BankNames): BankView["rules"] {
  const n = new Map<string, number>();
  for (const d of plan.dispositions.values()) if (d.how === "rule") n.set(d.ruleId, (n.get(d.ruleId) ?? 0) + 1);
  return [...n.entries()]
    .map(([id, count]) => {
      const r = books.rules.find((x) => x.id === id);
      const c = r ? ruleChoice(r, books) : null;
      if (!r || !c) return null;
      const band = sayBand(r);
      return { id, label: `${r.key.toUpperCase()} → ${choiceLabel(c, names)}${band ? ` (${band})` : ""}`, n: count };
    })
    .filter((x): x is { id: string; label: string; n: number } => !!x)
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

export function namesOf(books: Pick<BankBooks, "accounts" | "crew" | "invoices">): BankNames {
  return {
    accounts: new Map(books.accounts.map((a) => [a.id, a.name])),
    crew: new Map(books.crew.map((c) => [c.id, c.name])),
    invoices: new Map(books.invoices.map((i) => [i.id, i.number])),
  };
}

/** The card, worked out from the plan: plain data only. */
export function bankViewOf(dl: BankDownload, plan: BankPlan, books: BankBooks, opts: { today?: string | null; applied?: BankAppliedPass[] | null } = {}): BankView {
  const names = namesOf(books);
  const label = (id: string) => {
    const c = parseChoiceId(id);
    return c ? choiceLabel(c, names) : id;
  };
  const button = (c: BankChoice): BankButton => ({ id: choiceId(c), label: choiceLabel(c, names) });
  /** On money in, a bucket is a refund of that cost. */
  const inButton = (c: BankChoice): BankButton => ({ id: choiceId(c), label: c.choice === "cost" ? `Refund: ${choiceLabel(c, names)}` : choiceLabel(c, names) });
  /** An invoice in an Other… list, said in full: its number, its customer, what is open on it. */
  const invoiceButton = (i: BooksInvoice): BankButton => ({
    id: choiceId({ choice: "invoice", invoiceId: i.id }),
    label: [`On ${i.number}`, i.customer?.trim() || null, `${sayDollars(i.balanceCents / 100)} open`].filter(Boolean).join(" · "),
  });
  /** A single deposit's Other… list: the invoices it can go on (open for at least its money), then
   *  the rest of the money-in answers. */
  const othersForDeposit = (cents: number): BankButton[] => [
    ...books.invoices.filter((i) => i.balanceCents >= cents).map(invoiceButton),
    ...everyChoice("in", books, false).map(inButton),
  ];
  const byKey = new Map(dl.lines.map((l) => [l.key, l]));
  const sorted = new Map<string, { label: string; n: number; cents: number }>();
  for (const [key, d] of plan.dispositions) {
    if (d.how !== "match" && d.how !== "rule") continue;
    const name = d.how === "match" ? MATCH_LABEL[d.table] : `${choiceLabel(d.choice, names)} (Your Rule)`;
    const s = sorted.get(name) ?? { label: name, n: 0, cents: 0 };
    s.n += 1;
    s.cents += byKey.get(key)?.cents ?? 0;
    sorted.set(name, s);
  }
  const flow = moneyFlow(dl, plan, books);
  const passes = opts.applied ?? [];
  const lastPass = passes[passes.length - 1];
  const appliedSaid = lastPass
    ? `Applied ${sayRange(lastPass.at.slice(0, 10), lastPass.at.slice(0, 10), opts.today)}: ${plural(passes.reduce((n, p) => n + p.lines, 0), "line", "lines")} counted.` +
      (plan.counts.needRows ? ` ${plural(plan.counts.needLines, "line", "lines")} left for later ${plan.counts.needLines === 1 ? "is" : "are"} not counted yet.` : "")
    : null;
  return {
    headline: bankHeadline(dl, plan.counts, opts.today),
    fingerprint: plan.fingerprint,
    counts: plan.counts,
    rows: plan.groups.map((g) => {
      const title = groupTitle(g, opts.today);
      const dates = sayRange(g.first, g.last, opts.today);
      return {
        id: g.id,
        title,
        money: sayGroupMoney(g),
        // "Deposit Sep 4" already says its day.
        dates: title.endsWith(dates) ? "" : dates,
        direction: g.direction,
        single: g.single,
        guess: g.guess,
        hint: g.hint ?? null,
        buttons: g.buttons.map((id) => ({ id, label: label(id) })),
        ...(g.direction === "in" && g.single ? { others: othersForDeposit(g.cents) } : {}),
      };
    }),
    otherOut: everyChoice("out", books, false).map(button),
    otherIn: everyChoice("in", books, false).map(inButton),
    otherInSingle: everyChoice("in", books, true).map(inButton),
    flow: flow.out,
    inCents: flow.inCents,
    outCents: flow.outCents,
    sorted: [...sorted.values()].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)),
    skipped: dl.skipped,
    appliedSaid,
    canUndo: passes.length > 0,
    swapped: !!dl.swapped,
    canSwap: passes.length === 0 && dl.lines.length > 0,
    askAccount: passes.length === 0 && dl.lines.length > 0 && !dl.last4,
    rules: rulesUsed(plan, books, names),
    problem: null,
  };
}
