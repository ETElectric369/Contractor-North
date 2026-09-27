import { BUSINESS_COST_BUCKETS, isBusinessCostBucket, type BusinessCostBucket } from "@/lib/business-cost-buckets";
import { fingerprintOf, headerKey, readDate, readHeaderWith, readMoney, sayDollars } from "@/lib/supplier-open-list";

/**
 * A BANK'S DOWNLOAD, SORTED THE WAY THE COMPANY SORTS IT (Erik, 2026-09-27, "yes go for those").
 *
 * That night we sorted ET's checking export by hand: deposits were the invoice payments already
 * recorded (never written again), CED's card payments were CED's account, fuel and insurance were
 * business costs in their buckets, the transfers to his own account were owner's draw (never a
 * cost), the dentist was personal. This module does exactly that, in plain code, no model:
 *
 *   1. ALREADY DOWNLOADED: a line whose key is already in bank_lines is counted, never shown.
 *   2. MATCH, exact cents, each money row once:
 *        · a deposit is one payment (paid 3 days after to 7 days before it posts), or exactly one
 *          group of up to 6: a card payout (amounts less Stripe's fee) or a Venmo sweep;
 *        · a check or a debit to a crew member is a live crew payment (by check number, or by amount
 *          0 to 14 days after it was recorded);
 *        · a payment to an on-account supplier whose name, spelling or number the line carries is
 *          that supplier's payment;
 *        · an ATM withdrawal is a petty-cash top-up of the same amount within 3 days;
 *        · anything else is a bill for the same amount within 3 days (not one a supplier's account
 *          pays: those are paid through the account).
 *   3. A RULE THE COMPANY MADE (bank_rules) → its choice. Written only by a person's tap.
 *   4. OTHERWISE IT NEEDS YOU: one row per merchant, the app's guess first, never picked for you.
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
    "original description", "narrative", "transaction details",
  ],
  amount: ["amount", "transaction amount", "amt", "amount usd", "net amount"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "withdrawal amount", "debit amount", "money out", "amount debit", "paid out"],
  credit: ["credit", "credits", "deposit", "deposits", "deposit amount", "credit amount", "money in", "amount credit", "paid in"],
  check: ["check", "check number", "chk", "chk number", "check or slip", "cheque", "cheque number", "check num", "checknum"],
  balance: ["balance", "running balance", "running bal", "ledger balance", "available balance", "account balance"],
  account: ["account", "account number", "acct", "acct number", "card", "card number", "account id"],
  id: ["id", "fitid", "transaction id", "trans id"],
  type: ["type", "transaction type", "details", "dr cr", "debit credit"],
  status: ["status", "transaction status"],
};

/** Words only a bank prints over a column, so a table that also has a paper-number column is still
 *  read as a bank download when it carries one of these. Never "balance": a supplier's statement
 *  prints a running balance beside its paper numbers too, and it is the supplier's list. */
const BANK_ONLY = new Set(["debit", "credit", "withdrawal", "withdrawals", "deposit", "deposits", "check", "posted", "post date", "posting date", "memo", "payee", "fitid"]);

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
  return best ? { row: best.row, columns: best.columns } : null;
}

/**
 * IS THIS TABLE A BANK DOWNLOAD (rather than a supplier's open list)? It has the bank header, and
 * either no paper-number column or at least one word only a bank prints.
 */
export function looksLikeBankTable(table: readonly (readonly string[])[], supplierHasReference: boolean): boolean {
  const h = findBankHeader(table);
  if (!h) return false;
  if (!supplierHasReference) return true;
  return (table[h.row] ?? []).some((c) => BANK_ONLY.has(headerKey(c)));
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

/** Words that open a description but name nobody: the merchant is the word after. */
const STOP_FIRST = new Set([
  "the", "sq", "tst", "pp", "paypal", "sp", "py", "in", "an", "of", "el", "la", "le", "los", "las", "online", "mobile", "remote",
  "bill", "external", "electronic", "www", "ext", "int", "intl", "dd", "ppd", "ccd", "web", "tel", "ref",
]);
/** Words a bank adds around every merchant (the kind of transaction, never who). */
const NOISE = new Set([
  "pos", "ach", "debit", "credit", "purchase", "card", "checkcard", "dbt", "crd", "recurring", "visa", "mastercard", "mc",
  "authorized", "on", "pending", "withdrawal", "payment", "pmt", "trans", "transaction", "sale", "preauth", "pin", "signature",
  "usa", "us", "inc", "llc", "co", "corp",
]);

/** A description's words, lowercased, with numbers, dates, card prefixes and bank noise taken out. */
export function merchantWords(description: string): string[] {
  let s = String(description ?? "").toLowerCase();
  s = s.replace(/^\s*\d{4}[-\s]+/, " "); // a card's last 4 in front: "1111-SHELL"
  s = s.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " "); // dates
  s = s.replace(/['’`]/g, " ");
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
  if (TRANSFER_RE.test(description) && !PROCESSOR_RE.test(description)) {
    // The other account's number: a masked one first ("XXXXXX9876", "****9876"), else the first run
    // of 4 or more digits (never a date's 09 or 10, and never a reference number printed after it).
    const d = String(description);
    const masked = [...d.matchAll(/[x*]{2,}-?(\d{4})\b/gi)].map((m) => m[1] ?? "").filter(Boolean);
    const runs = d.match(/\d{4,}/g) ?? [];
    const acct = masked.length ? (masked[masked.length - 1] ?? "") : (runs[0] ?? "").slice(-4);
    return `transfer${acct ? ` ${acct}` : ""}`;
  }
  const words = merchantWords(description);
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
      last4: last4Of(cell(r, c.account)),
    });
    fitids.push(cell(r, c.id) || null);
  });
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
  };
}

// ── CHOICES ────────────────────────────────────────────────────────────────────────────────────

export type CostKind = "fuel" | "truck";

export type BankChoice =
  | { choice: "cost"; bucket: BusinessCostBucket; costKind: CostKind | null }
  | { choice: "draw" }
  | { choice: "personal" }
  | { choice: "petty_cash" }
  | { choice: "not_cost" }
  | { choice: "supplier"; supplierAccountId: string }
  | { choice: "crew"; profileId: string }
  | { choice: "invoice"; invoiceId: string }
  | { choice: "other_income" }
  | { choice: "not_income" };

export type ChoiceName = BankChoice["choice"];

/** A choice as one string, for a button's value and the fingerprint. */
export function choiceId(c: BankChoice): string {
  switch (c.choice) {
    case "cost":
      return `cost:${c.bucket}${c.costKind ? `:${c.costKind}` : ""}`;
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
  const [head, a, b] = s.split(":");
  switch (head) {
    case "cost": {
      if (!isBusinessCostBucket(a)) return null;
      const kind = b === "fuel" || b === "truck" ? b : null;
      if (b && !kind) return null;
      if (kind && a !== "Gas & Truck") return null;
      return { choice: "cost", bucket: a, costKind: kind };
    }
    case "supplier":
      return UUIDISH.test(a ?? "") ? { choice: "supplier", supplierAccountId: a } : null;
    case "crew":
      return UUIDISH.test(a ?? "") ? { choice: "crew", profileId: a } : null;
    case "invoice":
      return UUIDISH.test(a ?? "") ? { choice: "invoice", invoiceId: a } : null;
    case "draw":
    case "personal":
    case "petty_cash":
    case "not_cost":
    case "other_income":
    case "not_income":
      return s === head ? ({ choice: head } as BankChoice) : null;
    default:
      return null;
  }
}

const IN_CHOICES = new Set<ChoiceName>(["invoice", "other_income", "not_income"]);

/** Money in takes the income choices; money out takes the rest. */
export function choiceFits(c: BankChoice, direction: "in" | "out"): boolean {
  return direction === "in" ? IN_CHOICES.has(c.choice) : !IN_CHOICES.has(c.choice);
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
      if (c.costKind === "fuel") return "Fuel";
      if (c.costKind === "truck") return "Truck";
      return c.bucket;
    case "draw":
      return "Owner's Draw";
    case "personal":
      return "Personal";
    case "petty_cash":
      return "Petty Cash (ATM)";
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
      return "Not Income";
  }
}

// ── THE BOOKS IT IS COMPARED WITH ──────────────────────────────────────────────────────────────

export type BooksPayment = { id: string; invoiceId: string; invoiceNumber: string; cents: number; day: string; method: string; feeCents: number | null; stripe: boolean };
export type BooksPay = { id: string; profileId: string; cents: number; day: string; reference: string | null };
export type BooksSupplierPay = { id: string; accountId: string; cents: number; day: string; reference: string | null };
export type BooksBill = { id: string; cents: number; day: string | null; supplier: string; jobId: string | null; category: string | null; onAccount: boolean };
export type BooksPetty = { id: string; cents: number; day: string; kind: string };
export type BooksAccount = { id: string; name: string; number: string | null; branch: string | null; onAccount: boolean; aliases: string[] };
export type BooksInvoice = { id: string; number: string; balanceCents: number };
export type BooksCrew = { id: string; name: string };
export type BooksRule = {
  id: string;
  direction: "in" | "out";
  key: string;
  choice: Exclude<ChoiceName, "invoice">;
  bucket: string | null;
  costKind: string | null;
  supplierAccountId: string | null;
  profileId: string | null;
};
export type AlreadyLine = { choice: string; bucket: string | null; costKind: string | null; amountCents: number };

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
  cents: number;
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

const compact = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Does the line name this supplier account: its number, branch, name or a spelling of it? */
export function lineNamesAccount(description: string, a: BooksAccount): boolean {
  const d = compact(description);
  if (!d) return false;
  const codes = [a.number, a.branch].map((x) => compact(x ?? "")).filter((x) => x.length >= 4);
  if (codes.some((x) => d.includes(x))) return true;
  const names = [a.name, ...a.aliases].map(compact).filter((x) => x.length >= 5);
  // A bank cuts names short, so the first 12 letters of a name are enough.
  return names.some((x) => d.includes(x.slice(0, 12)));
}

const FUEL_RE = /\b(fuel|gas|gasoline|diesel|petrol|shell|chevron|texaco|exxon|mobil|arco|valero|sinclair|conoco|phillips|marathon|citgo|sunoco|maverik|pilot|loves|flying j|circle k|speedway|costco gas|gas station|fuel stop)\b/i;
const TRUCK_RE = /\b(auto parts|autozone|o ?reilly|napa|jiffy|lube|oil change|tire|tires|car wash|smog|dmv|registration|towing|mechanic|auto repair|truck)\b/i;
const INSURANCE_RE = /\b(insur\w*|ins prem|premium|liability|bond|bonding|licen[cs]e\w*|cslb)\b/i;
const FEE_RE = /\b(fee|fees|service charge|overdraft|nsf|interest charge|finance charge|monthly maintenance|wire fee)\b/i;
const PHONE_RE = /\b(verizon|at&t|att|t-mobile|tmobile|sprint|comcast|xfinity|spectrum|internet|wireless|phone|google|microsoft|adobe|dropbox|quickbooks|intuit|office)\b/i;
const TOOLS_RE = /\b(home depot|lowes|lowe s|harbor freight|ace hardware|hardware|tool|tools|grainger|fastenal|menards)\b/i;
const ATM_RE = /\b(atm|cash withdrawal|withdrawal)\b/i;
const PAY_WORDS_RE = /\b(zelle|venmo|cash app|cashapp|payroll|transfer|xfer)\b/i;

const FUEL: BankChoice = { choice: "cost", bucket: "Gas & Truck", costKind: "fuel" };
const TRUCK: BankChoice = { choice: "cost", bucket: "Gas & Truck", costKind: "truck" };

/** A crew member the line names by first name. */
function crewNamed(description: string, crew: readonly BooksCrew[]): BooksCrew | null {
  const d = ` ${description.toLowerCase().replace(/[^a-z]+/g, " ")} `;
  const hits = crew.filter((p) => {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return first.length >= 3 && d.includes(` ${first} `);
  });
  return hits.length === 1 ? hits[0] : null;
}

/** THE GUESS for a line nothing matched and no rule placed. Never picked; the first button. */
export function guessFor(line: BankLine, books: BankBooks): BankChoice | null {
  if (line.cents > 0) {
    const hits = books.invoices.filter((i) => i.balanceCents === line.cents);
    if (hits.length === 1) return { choice: "invoice", invoiceId: hits[0].id };
    // Money moved in from another of the company's own accounts is not income; a processor's
    // payout of customers' money is, and gets no guess (the person says which).
    if (TRANSFER_RE.test(line.description) && !PROCESSOR_RE.test(line.description)) return { choice: "not_income" };
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
  if (ATM_RE.test(d)) return { choice: "petty_cash" };
  if (TRANSFER_RE.test(d) && !PROCESSOR_RE.test(d)) return { choice: "draw" };
  if (INSURANCE_RE.test(d)) return { choice: "cost", bucket: "Insurance & Licenses", costKind: null };
  if (FEE_RE.test(d)) return { choice: "cost", bucket: "Fees", costKind: null };
  if (TRUCK_RE.test(d)) return TRUCK;
  if (FUEL_RE.test(d)) return FUEL;
  if (PHONE_RE.test(d)) return { choice: "cost", bucket: "Phone & Office", costKind: null };
  if (TOOLS_RE.test(d)) return { choice: "cost", bucket: "Tools & Supplies", costKind: null };
  return null;
}

/** The rule that places this line: same direction, its key a word-prefix of the line's words, the
 *  longest such key winning. Checks with no payee and bare deposits are never placed by a rule. */
export function ruleFor(line: BankLine, rules: readonly BooksRule[]): BooksRule | null {
  const direction = line.cents > 0 ? "in" : "out";
  if (isBareCheck(line) || isGenericKey(line.merchantKey) || !line.merchantKey) return null;
  const words = merchantWords(line.description).join(" ");
  const own = line.merchantKey;
  let best: BooksRule | null = null;
  for (const r of rules) {
    if (r.direction !== direction) continue;
    const hit = r.key === own || words === r.key || words.startsWith(`${r.key} `) || own.startsWith(`${r.key} `);
    if (!hit) continue;
    if (!best || r.key.length > best.key.length) best = r;
  }
  return best;
}

/** A rule's choice, if it can still be used (its supplier or crew member is still here). */
export function ruleChoice(r: BooksRule, books: Pick<BankBooks, "accounts" | "crew">): BankChoice | null {
  switch (r.choice) {
    case "cost":
      if (!isBusinessCostBucket(r.bucket)) return null;
      return { choice: "cost", bucket: r.bucket, costKind: r.bucket === "Gas & Truck" && (r.costKind === "fuel" || r.costKind === "truck") ? r.costKind : null };
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

  const match = (line: BankLine): Disposition | null => {
    if (line.cents > 0) {
      // ONE PAYMENT: recorded 7 days before the deposit posts, up to 3 days after.
      const window = (p: BooksPayment) => {
        const d = dayDiff(line.postedOn, p.day);
        return d >= -3 && d <= 7 && !used.has(p.id);
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
      return null;
    }
    const amount = -line.cents;
    // A CHECK BY ITS NUMBER: a crew payment or a supplier payment that wrote it down.
    if (line.check) {
      const crew = books.payPayments.find((p) => !used.has(p.id) && digitsOnly(p.reference).replace(/^0+/, "") === line.check && p.cents === amount);
      if (crew) return { how: "match", table: "pay_payments", ids: [crew.id], said: `Check ${line.check}, crew pay` };
      const sup = books.supplierPayments.find((p) => !used.has(p.id) && digitsOnly(p.reference).replace(/^0+/, "") === line.check && p.cents === amount);
      if (sup) return { how: "match", table: "supplier_payments", ids: [sup.id], said: `Check ${line.check}, supplier payment` };
    }
    // CREW PAY BY AMOUNT, on a check or a line that names a way crew are paid (or the person).
    if (line.check || /\bcheck\b/i.test(line.description) || PAY_WORDS_RE.test(line.description) || crewNamed(line.description, books.crew)) {
      const hits = books.payPayments
        .filter((p) => !used.has(p.id) && p.cents === amount && dayDiff(line.postedOn, p.day) >= 0 && dayDiff(line.postedOn, p.day) <= 14)
        .sort(byDistance(line.postedOn));
      if (hits.length) return { how: "match", table: "pay_payments", ids: [hits[0].id], said: "Crew pay already recorded" };
    }
    // A SUPPLIER'S OWN PAYMENT, when the line names the account.
    const named = books.accounts.filter((a) => lineNamesAccount(line.description, a)).map((a) => a.id);
    if (named.length) {
      const hits = books.supplierPayments
        .filter((p) => !used.has(p.id) && named.includes(p.accountId) && p.cents === amount && dayDiff(line.postedOn, p.day) >= -3 && dayDiff(line.postedOn, p.day) <= 14)
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
    // A BILL FOR THE SAME MONEY within 3 days, not one a supplier account pays.
    const bills = books.bills.filter((b) => !used.has(b.id) && !b.onAccount && b.cents === amount && b.day && Math.abs(dayDiff(line.postedOn, b.day)) <= 3);
    if (bills.length) {
      const words = new Set(merchantWords(line.description));
      const overlap = (b: BooksBill) => merchantWords(b.supplier).filter((w) => w.length >= 3 && words.has(w)).length;
      bills.sort((a, b) => overlap(b) - overlap(a) || byDistance(line.postedOn)(a, b));
      const b = bills[0];
      return { how: "match", table: "bills", ids: [b.id], said: `${b.supplier} already on the books` };
    }
    return null;
  };

  const groups = new Map<string, NeedGroup>();
  for (const line of lines) {
    if (books.already.has(line.key)) {
      dispositions.set(line.key, { how: "already" });
      counts.already++;
      continue;
    }
    const m = match(line);
    if (m && m.how === "match") {
      for (const id of m.ids) used.add(id);
      dispositions.set(line.key, m);
      counts.matched++;
      continue;
    }
    const rule = ruleFor(line, books.rules);
    const rc = rule ? ruleChoice(rule, books) : null;
    if (rule && rc && choiceFits(rc, line.cents > 0 ? "in" : "out")) {
      dispositions.set(line.key, { how: "rule", ruleId: rule.id, choice: rc });
      counts.ruled++;
      continue;
    }
    // A QUESTION: one row per merchant; a check, a deposit an invoice may be, or a line with no
    // merchant words is a row of its own.
    const direction = line.cents > 0 ? "in" : "out";
    const guess = guessFor(line, books);
    const single = isBareCheck(line) || !line.merchantKey || isGenericKey(line.merchantKey) || guess?.choice === "invoice" || (direction === "out" && !!line.check);
    const id = single ? `line:${line.key.slice(-16)}` : `${direction}:${line.merchantKey}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        id,
        direction,
        label: line.description,
        keys: [],
        cents: 0,
        first: line.postedOn,
        last: line.postedOn,
        check: line.check,
        single,
        guess: guess ? choiceId(guess) : null,
        buttons: [],
        learnable: !single && !!line.merchantKey && !isGenericKey(line.merchantKey),
        merchantKey: line.merchantKey,
      };
      groups.set(id, g);
    }
    g.keys.push(line.key);
    g.cents += line.cents;
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
    add("other_income");
    add("not_income");
    return out.slice(0, 3);
  }
  if (g.check) {
    for (const c of books.crew.slice(0, 2)) add(`crew:${c.id}`);
    if (out.length < 2) add("personal");
    return out.slice(0, 2);
  }
  if (g.guess === choiceId(FUEL)) add(choiceId(TRUCK));
  if (g.guess === choiceId(TRUCK)) add(choiceId(FUEL));
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
    return out;
  }
  const out: BankChoice[] = [FUEL, TRUCK];
  for (const b of BUSINESS_COST_BUCKETS) out.push({ choice: "cost", bucket: b, costKind: null });
  out.push({ choice: "draw" }, { choice: "personal" }, { choice: "petty_cash" }, { choice: "not_cost" });
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

/** THE ONE LINE: "Bank ••1234 · Aug 26–Sep 25 · 96 sorted · 17 already in North · 3 need you". */
export function bankHeadline(dl: Pick<BankDownload, "last4" | "from" | "to">, counts: BankPlan["counts"], today?: string | null): string {
  const parts = [dl.last4 ? `Bank ••${dl.last4}` : "Bank download", sayRange(dl.from, dl.to, today)];
  const sorted = counts.matched + counts.ruled;
  if (sorted) parts.push(`${sorted} sorted`);
  if (counts.already) parts.push(`${counts.already} already in North`);
  parts.push(counts.needRows ? `${counts.needRows} need you` : "nothing needs you");
  return parts.join(" · ");
}

/** Where the money went, out of the account: one segment per place, biggest first. */
export type FlowSegment = { key: string; label: string; cents: number };

export function flowLabelOf(choice: string, bucket: string | null, costKind: string | null): { key: string; label: string } {
  switch (choice) {
    case "cost":
      if (bucket === "Gas & Truck" && costKind === "fuel") return { key: "fuel", label: "Fuel" };
      return { key: `bucket:${bucket ?? "Other"}`, label: bucket ?? "Other" };
    case "draw":
      return { key: "draw", label: "Owner's Draw" };
    case "personal":
      return { key: "personal", label: "Personal" };
    case "petty_cash":
      return { key: "petty", label: "Petty Cash" };
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
      else add(flowLabelOf(a.choice, a.bucket, a.costKind), amt);
    } else if (d.how === "rule") {
      const c = d.choice;
      add(flowLabelOf(c.choice, c.choice === "cost" ? c.bucket : null, c.choice === "cost" ? c.costKind : null), amt);
    } else if (d.how === "match") {
      if (d.table === "supplier_payments") add({ key: "suppliers", label: "Suppliers" }, amt);
      else if (d.table === "pay_payments") add({ key: "crew", label: "Crew Pay" }, amt);
      else if (d.table === "petty_cash") add({ key: "petty", label: "Petty Cash" }, amt);
      else {
        const b = billOf.get(d.ids[0]);
        add(b && !b.jobId ? flowLabelOf("cost", b.category, null) : { key: "materials", label: "Materials & Bills" }, amt);
      }
    } else add({ key: "need", label: "Needs You" }, amt);
  }
  return { out: [...seg.values()].sort((a, b) => b.cents - a.cents), inCents, outCents };
}

/** "3× $288.45" or "$288.45". */
export function sayGroupMoney(g: Pick<NeedGroup, "keys" | "cents">): string {
  const n = g.keys.length;
  return `${n > 1 ? `${n}× ` : ""}${sayDollars(Math.abs(g.cents) / 100)}`;
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
  return { ok, refused };
}

/** The same bucket words the six-bucket list uses, for a check in the migration tests. */
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
  problem: string | null;
};

const MATCH_LABEL: Record<MatchTable, string> = {
  payments: "Payments Already Recorded",
  bills: "Bills Already On The Books",
  supplier_payments: "Supplier Payments Already Recorded",
  pay_payments: "Crew Pay Already Recorded",
  petty_cash: "Petty Cash Already Recorded",
};

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
        buttons: g.buttons.map((id) => ({ id, label: label(id) })),
      };
    }),
    otherOut: everyChoice("out", books, false).map(button),
    otherIn: everyChoice("in", books, false).map(button),
    otherInSingle: everyChoice("in", books, true).map(button),
    flow: flow.out,
    inCents: flow.inCents,
    outCents: flow.outCents,
    sorted: [...sorted.values()].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)),
    skipped: dl.skipped,
    appliedSaid,
    canUndo: passes.length > 0,
    problem: null,
  };
}
