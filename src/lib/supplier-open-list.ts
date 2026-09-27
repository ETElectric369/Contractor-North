import { normalizeDocNumber } from "@/lib/same-purchase";

/**
 * A SUPPLIER'S OWN LIST OF WHAT IS STILL OPEN, AND WHAT IT CHANGES ON THE BOOKS (2026-09-26).
 *
 * The app closed a supplier paper only when a paper stamped paid arrived (importCedInvoices), so a
 * payment made in chunks left everything it paid standing open: after Erik's 9/24 payment the app
 * still said $5,174.62 across 24 CED papers while CED's own Open tab listed 11. The supplier is the
 * truth about its own open balances (model B), and its open list says so in one page.
 *
 * ONE ENGINE, ANY SUPPLIER (Erik's law, 2026-09-26: "all of this needs to be able to apply to any
 * supplier"). Nothing in here knows a supplier's name, an account number or a date. Columns are
 * found by the words in their headers (HEADER_WORDS); a list whose headers say nothing this knows
 * asks a person once, and the answer is remembered on that supplier's account (the caller keeps it).
 * CED's portal download is the first fixture, never the rule.
 *
 * PURE: no database, no browser. The doors (Drop Paperwork, Organize, the paste box, a statement
 * PDF, a statement a model read off a scan) turn what they hold into an OpenList here; the page
 * reconciles it against the account's papers here; Apply writes what the plan says, and only after
 * a person presses it.
 *
 * THE RULES THAT DECIDE MONEY, each tested:
 *   · A paper open in the app and absent from the list is CLOSED only when it is dated on or before
 *     the list's date. One dated after it may simply be newer than the list, and stays open.
 *     A paper with no date at all stays open and is named: nothing proves it is older.
 *   · Nothing is closed from a list that may be partial. The supplier's own total or document
 *     count has to agree with the rows, or a person says "This Is The Whole Open List".
 *   · A list row the app lacks is ADDED as that supplier's paper, with its kind read from the
 *     type words and its job words kept raw (never matched to a job by machine).
 *   · A listed number already on ANOTHER supplier's account is never touched; it is named.
 *   · A payment or unapplied cash line is not a paper: it is counted in the list's total and said.
 */

// ── WHAT A LIST IS ─────────────────────────────────────────────────────────────────────────────

export const OPEN_LIST_FIELDS = [
  "reference",
  "type",
  "po",
  "invoiceDate",
  "dueDate",
  "amount",
  "openBalance",
  "discountAmount",
  "discountDate",
  "account",
] as const;
export type OpenListField = (typeof OPEN_LIST_FIELDS)[number];

/** Which column (0-based) holds each field. */
export type OpenListColumns = Partial<Record<OpenListField, number>>;

/** What a person chose once, kept on the supplier account so the next list from them just reads. */
export type RememberedColumns = {
  /** field → the header's own words, when the list has a header row. */
  byHeader?: Partial<Record<OpenListField, string>>;
  /** field → column index, for a list with no header row, and the width it had. */
  byIndex?: Partial<Record<OpenListField, number>>;
  width?: number;
};

export const FIELD_LABELS: Record<OpenListField, string> = {
  reference: "Paper Number",
  type: "Type",
  po: "PO Or Job",
  invoiceDate: "Paper Date",
  dueDate: "Due Date",
  amount: "Amount",
  openBalance: "Open Balance",
  discountAmount: "Discount",
  discountDate: "Discount Date",
  account: "Account Number",
};

export type SupplierPaperKind = "invoice" | "credit_memo" | "service_charge" | "statement";
export type OpenListRowKind = SupplierPaperKind | "payment";

export type OpenListRow = {
  reference: string;
  kind: OpenListRowKind;
  typeWords: string | null;
  po: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  /** The paper's original amount, when the list prints it. */
  amount: number | null;
  /** What is still open on it. Falls back to `amount` when the list prints no balance column. */
  openBalance: number;
  discountAmount: number | null;
  discountBy: string | null;
  accountNumber: string | null;
};

export type OpenListSource = "file" | "paste" | "statement" | "reader";

export type OpenList = {
  v: 1;
  from: OpenListSource;
  /** The file's name, or "Pasted list". */
  name: string;
  /** The day the list speaks for (YYYY-MM-DD). Papers dated after it may be newer than the list. */
  listDate: string | null;
  /** Where that date came from, so the card can say it. */
  listDateFrom: "printed" | "file" | "today" | "newest" | null;
  /** The account number the list itself prints (a column or the statement header). */
  accountNumber: string | null;
  /** The supplier account this list is for, once known; how it was known. */
  accountId?: string | null;
  accountFrom?: "number" | "papers" | "columns" | "person" | null;
  /** The supplier's own total, when the list prints one. */
  printedTotal: number | null;
  /** The supplier's own count of documents, when the list prints one. */
  printedCount: number | null;
  rows: OpenListRow[];
  /** Rows that did not read, said by line, never dropped. */
  skipped: { line: number; why: string }[];
  /** The header row's own words, for the column picker and for remembering. */
  header: string[];
  columns: OpenListColumns;
  /** The columns came from a person's pick (and are worth remembering on the account). */
  columnsBy?: "person" | null;
  /** A person pressed "This Is The Whole Open List". */
  wholeList?: boolean;
};

/** A list that could not be read as a list yet: the columns a person must point at. */
export type OpenListNeedsColumns = {
  v: 1;
  from: OpenListSource;
  name: string;
  listDate: string | null;
  listDateFrom: OpenList["listDateFrom"];
  /** The table as it came (capped), so the picker can show it and the answer can re-read it. */
  raw: string[][];
  header: string[];
  /** The row the header was found on, or -1 when there is none. */
  headerRow: number;
  /** What was found, as a starting point for the picker. */
  columns: OpenListColumns;
  missing: OpenListField[];
  /** Fields two columns both claimed. */
  unsure: OpenListField[];
  accountId?: string | null;
  accountFrom?: OpenList["accountFrom"];
};

// ── READING VALUES ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;
export const moneyCents = (n: number | null | undefined) => Math.round((Number(n) || 0) * 100);

/** "$1,062.18", "(82.10)", "-82.10", "82.10-", "82.10 CR" → a number; blank or words → null. */
export function readMoney(raw: unknown): number | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\s*(CR|CREDIT)$/i.test(s)) {
    negative = true;
    s = s.replace(/\s*(CR|CREDIT)$/i, "");
  }
  if (/-$/.test(s)) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/[$\s,]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s.startsWith("$")) s = s.slice(1);
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const n = r2(Number(s));
  if (!Number.isFinite(n)) return null;
  return negative && n !== 0 ? -n : n;
}

const pad = (n: number) => String(n).padStart(2, "0");
const validYmd = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

/**
 * "09/03/2026", "9/3/26", "09-03-26", "2026-09-03", "Sep 3, 2026" → "2026-09-03". An Excel serial
 * day (a date cell saved as its number, 46268) is read only where `serialOk` says the column is a
 * date column, so an amount can never become a date.
 */
export function readDate(raw: unknown, serialOk = false): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return validYmd(y, Number(m[1]), Number(m[2]));
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return validYmd(Number(m[3]), month, Number(m[2]));
  }
  if (serialOk && /^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 30000 && n < 80000) {
      const t = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);
      return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    }
  }
  return null;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * THE KIND FROM THE TYPE WORDS. A payment, cash received or unapplied cash is NOT a paper (it has
 * no goods on it); it is counted in the list's total and said, never added as a document. A
 * partial pay (CED's PP) is an invoice with part of it paid, so it is an invoice.
 */
export function kindFromTypeWords(words: string | null | undefined, openBalance: number): OpenListRowKind {
  const w = String(words ?? "").trim().toLowerCase();
  if (w) {
    if (/credit|\bcrm\b|\bcm\b|return|\brtn\b/.test(w)) return "credit_memo";
    if (/service|\bsvc\b|finance|interest|late\s*(fee|charge)|\bfc\b/.test(w)) return "service_charge";
    if (/payment|\bpmt\b|cash\s*rec|\bcsr\b|\bpai\b|unapplied|on\s*account|prepay|deposit|\bchk\b|\bcheck\b/.test(w)) return "payment";
    if (/statement/.test(w)) return "statement";
    if (/invoice|\binv\b|debit|\bdai\b|\bpp\b|partial|freight|\bfrt\b|\btax\b|\bdd\b|charge|bill/.test(w)) return "invoice";
  }
  return openBalance < 0 ? "credit_memo" : "invoice";
}

// ── FINDING THE COLUMNS ────────────────────────────────────────────────────────────────────────

/** A header cell, reduced to its words: "Reference #" → "reference", "Inv Amt" → "inv amt". */
export function headerKey(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/#/g, " ")
    .replace(/\bno\.?(?=\s|$)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The words suppliers put over each column, reduced by headerKey. EXACT matches only: "amount"
 * is the paper's amount, "open amount" is its balance, and a contains-match could not tell them
 * apart. A header nobody listed here goes to the column picker, once per supplier.
 */
export const HEADER_WORDS: Record<OpenListField, string[]> = {
  reference: [
    "reference", "ref", "invoice", "invoice number", "inv", "inv number", "document", "document number",
    "doc", "doc number", "number", "transaction", "transaction number", "trans", "bill", "bill number",
    "ticket", "ticket number", "item", "invoice id", "document id", "ref number", "reference number",
  ],
  type: ["type", "doc type", "document type", "transaction type", "trans type", "code", "invoice type", "kind"],
  po: [
    "po", "po number", "customer po", "cust po", "purchase order", "purchase order number", "job", "job name",
    "customer order", "job name customer order", "customer order number", "your po", "your order", "job number",
  ],
  invoiceDate: ["inv date", "invoice date", "date", "doc date", "document date", "trans date", "transaction date", "bill date", "posting date", "ship date"],
  dueDate: ["due date", "due", "net due date", "payment due", "date due", "due on"],
  amount: ["inv amt", "invoice amount", "amount", "original amount", "orig amt", "original", "total", "invoice total", "doc amount", "document amount", "charges", "amt", "inv amount"],
  openBalance: [
    "open balance", "balance", "balance due", "open amount", "open amt", "amount due", "remaining", "outstanding",
    "open", "amount remaining", "unpaid", "remaining balance", "amount open", "open bal", "bal due", "balance remaining",
  ],
  discountAmount: ["disc amt", "discount", "discount amount", "disc", "cash discount", "discount amt", "terms discount"],
  discountDate: ["disc date", "discount date", "discount by", "disc due date", "discount due", "discount due date"],
  account: ["account", "account number", "acct", "acct number", "customer number", "customer account", "account id"],
};

const WORD_TO_FIELD: Map<string, OpenListField> = (() => {
  const m = new Map<string, OpenListField>();
  for (const f of OPEN_LIST_FIELDS) for (const w of HEADER_WORDS[f]) if (!m.has(w)) m.set(w, f);
  return m;
})();

export type HeaderRead = { columns: OpenListColumns; unsure: OpenListField[] };

/** Map one header row. Two columns claiming one field is unsure, and the picker asks. */
export function readHeaderRow(cells: readonly string[]): HeaderRead {
  const columns: OpenListColumns = {};
  const unsure = new Set<OpenListField>();
  cells.forEach((cell, i) => {
    const field = WORD_TO_FIELD.get(headerKey(cell));
    if (!field) return;
    if (columns[field] !== undefined) unsure.add(field);
    else columns[field] = i;
  });
  return { columns, unsure: [...unsure] };
}

const hasRequired = (c: OpenListColumns) => c.reference !== undefined && (c.openBalance !== undefined || c.amount !== undefined);

export function missingRequired(c: OpenListColumns): OpenListField[] {
  const out: OpenListField[] = [];
  if (c.reference === undefined) out.push("reference");
  if (c.openBalance === undefined && c.amount === undefined) out.push("openBalance");
  return out;
}

/** The first row (of the first 15) that reads as a header: at least two fields, one of them money
 *  or the paper number. -1 when none does. */
export function findHeaderRow(table: readonly (readonly string[])[]): number {
  let best = -1;
  let bestScore = 1;
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const { columns } = readHeaderRow(table[i] ?? []);
    const found = Object.keys(columns).length;
    const anchored = columns.reference !== undefined || columns.openBalance !== undefined || columns.amount !== undefined;
    if (anchored && found > bestScore) {
      best = i;
      bestScore = found;
    }
  }
  // NO WORDS IT KNOWS, BUT A HEADER ALL THE SAME: a first row of words with no numbers in it, over
  // rows that have them. Kept as the header, so the column picker can show its names and remember
  // them for this supplier.
  if (best < 0 && table.length >= 2) {
    const first = (table[0] ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
    const wordsOnly = first.length >= 2 && first.every((c) => !/\d/.test(c));
    const dataBelow = (table[1] ?? []).some((c) => /\d/.test(String(c ?? "")));
    if (wordsOnly && dataBelow) return 0;
  }
  return best;
}

/** A remembered choice, applied to this table's header (or its width, for a headerless list). */
export function columnsFromRemembered(
  remembered: RememberedColumns | null | undefined,
  header: readonly string[],
  width: number,
): OpenListColumns | null {
  if (!remembered) return null;
  const out: OpenListColumns = {};
  if (remembered.byHeader && header.length) {
    const keys = header.map(headerKey);
    for (const f of OPEN_LIST_FIELDS) {
      const want = remembered.byHeader[f];
      if (!want) continue;
      const at = keys.indexOf(headerKey(want));
      if (at >= 0) out[f] = at;
    }
    if (hasRequired(out)) return out;
  }
  if (remembered.byIndex && remembered.width === width) {
    for (const f of OPEN_LIST_FIELDS) {
      const at = remembered.byIndex[f];
      if (typeof at === "number" && at >= 0 && at < width) out[f] = at;
    }
    if (hasRequired(out)) return out;
  }
  return null;
}

/** What to remember once a person has pointed at the columns. */
export function rememberColumns(columns: OpenListColumns, header: readonly string[], width: number): RememberedColumns {
  const byHeader: RememberedColumns["byHeader"] = {};
  const byIndex: RememberedColumns["byIndex"] = {};
  for (const f of OPEN_LIST_FIELDS) {
    const at = columns[f];
    if (typeof at !== "number") continue;
    byIndex[f] = at;
    const words = String(header[at] ?? "").trim();
    if (words) byHeader[f] = words;
  }
  return { ...(Object.keys(byHeader).length ? { byHeader } : {}), byIndex, width };
}

// ── A TABLE INTO A LIST ────────────────────────────────────────────────────────────────────────

const RAW_ROWS = 1000;
const RAW_CELL = 200;

/** The table as kept on the paper's row: capped, so a stray 50,000-row export cannot bloat it. */
export function capTable(table: readonly (readonly unknown[])[]): string[][] {
  return table.slice(0, RAW_ROWS).map((r) => (r ?? []).slice(0, 40).map((c) => String(c ?? "").slice(0, RAW_CELL)));
}

const cell = (row: readonly string[], at: number | undefined) => (at === undefined ? "" : String(row[at] ?? "").trim());
const looksLikeReference = (s: string) => /\d/.test(s) && s.length <= 40 && !/^total\b/i.test(s) && readDate(s) === null;

/** "Total Balance: $3,273.94", "11 documents": the supplier's own figures, wherever they sit. */
export function printedFigures(lines: readonly string[]): { total: number | null; count: number | null } {
  let total: number | null = null;
  let count: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? "");
    const t = /\b(?:total\s*(?:balance|due|open|amount\s*due|outstanding)?|balance\s*due|amount\s*due|total)\b[^0-9$(\-]*(\(?-?\$?\s*[\d,]+\.\d{2}\)?-?)/i.exec(line);
    if (t && total === null) total = readMoney(t[1]);
    else if (total === null && /^(?:total\s*(?:balance|due)|balance\s*due|amount\s*due|total due)\s*:?$/i.test(line.trim())) {
      const next = readMoney(String(lines[i + 1] ?? "").trim());
      if (next !== null) total = next;
    }
    const c = /\b(\d{1,5})\s+(?:open\s+)?(?:documents|docs|items|invoices|records|transactions)\b/i.exec(line);
    if (c && count === null) count = Number(c[1]);
  }
  return { total, count };
}

export type ReadListInput = {
  table: readonly (readonly string[])[];
  from: OpenListSource;
  name: string;
  listDate: string | null;
  listDateFrom: OpenList["listDateFrom"];
  /** A person's own column choice, or one remembered on the account. */
  columns?: OpenListColumns | null;
  /** The row the header sits on when `columns` is given (-1: no header row). */
  headerRow?: number;
  printedTotal?: number | null;
  printedCount?: number | null;
  accountNumber?: string | null;
};

/**
 * A table (rows of cells) into an OpenList, or the columns a person has to point at. Never
 * throws; every row that did not read is kept by line number with the reason.
 */
export function readOpenListTable(input: ReadListInput): { ok: true; list: OpenList } | { ok: false; needs: OpenListNeedsColumns } | { ok: false; error: string } {
  const table = capTable(input.table).filter((r) => r.some((c) => c.trim() !== ""));
  if (!table.length) return { ok: false, error: `${input.name} has no rows in it.` };
  let headerRow = input.headerRow ?? findHeaderRow(table);
  let columns: OpenListColumns | null = input.columns ?? null;
  let unsure: OpenListField[] = [];
  if (!columns) {
    if (headerRow < 0) {
      return {
        ok: false,
        needs: {
          v: 1, from: input.from, name: input.name, listDate: input.listDate, listDateFrom: input.listDateFrom,
          raw: table, header: [], headerRow: -1, columns: {}, missing: ["reference", "openBalance"], unsure: [],
        },
      };
    }
    const read = readHeaderRow(table[headerRow]);
    columns = read.columns;
    unsure = read.unsure;
  } else if (input.headerRow === undefined) {
    headerRow = findHeaderRow(table);
  }
  const header = headerRow >= 0 ? table[headerRow].map((c) => c.trim()) : [];
  const missing = missingRequired(columns);
  if (missing.length || unsure.includes("reference") || unsure.includes("openBalance") || (columns.openBalance === undefined && unsure.includes("amount"))) {
    return {
      ok: false,
      needs: {
        v: 1, from: input.from, name: input.name, listDate: input.listDate, listDateFrom: input.listDateFrom,
        raw: table, header, headerRow, columns, missing, unsure,
      },
    };
  }

  const rows: OpenListRow[] = [];
  const skipped: OpenList["skipped"] = [];
  const seen = new Map<string, OpenListRow>();
  const trailer: string[] = [];
  let accountNumber = input.accountNumber ?? null;
  const dateCols = new Set([columns.invoiceDate, columns.dueDate, columns.discountDate].filter((x): x is number => typeof x === "number"));
  for (let i = headerRow + 1; i < table.length; i++) {
    const row = table[i];
    const line = i + 1;
    const reference = cell(row, columns.reference);
    const openRaw = cell(row, columns.openBalance);
    const amountRaw = cell(row, columns.amount);
    if (!reference) {
      // A total row, a subtotal or a blank line in the middle: kept for the supplier's own figures.
      trailer.push(row.filter((c) => c.trim()).join(" "));
      continue;
    }
    if (!looksLikeReference(reference)) {
      trailer.push(row.filter((c) => c.trim()).join(" "));
      if (!/total|balance|count|page/i.test(reference)) skipped.push({ line, why: `"${reference.slice(0, 40)}" isn't a paper number.` });
      continue;
    }
    const amount = readMoney(amountRaw);
    const open = columns.openBalance !== undefined ? readMoney(openRaw) : amount;
    if (open === null) {
      skipped.push({ line, why: `${reference}: no open balance could be read${openRaw ? ` from "${openRaw.slice(0, 30)}"` : ""}.` });
      continue;
    }
    const typeWords = cell(row, columns.type) || null;
    const acct = cell(row, columns.account) || null;
    if (acct && !accountNumber) accountNumber = acct;
    const next: OpenListRow = {
      reference,
      kind: kindFromTypeWords(typeWords, open),
      typeWords,
      po: cell(row, columns.po) || null,
      invoiceDate: readDate(cell(row, columns.invoiceDate), dateCols.has(columns.invoiceDate ?? -1)),
      dueDate: readDate(cell(row, columns.dueDate), true),
      amount,
      openBalance: open,
      discountAmount: columns.discountAmount !== undefined ? readMoney(cell(row, columns.discountAmount)) : null,
      discountBy: readDate(cell(row, columns.discountDate), true),
      accountNumber: acct,
    };
    const key = normalizeDocNumber(reference);
    const twin = seen.get(key);
    if (twin) {
      // THE SAME NUMBER TWICE: the same figures is one paper printed twice; different figures is a
      // list that disagrees with itself, and neither is picked.
      if (moneyCents(twin.openBalance) !== moneyCents(next.openBalance)) {
        skipped.push({ line, why: `${reference} is on the list twice with two different balances; neither was used.` });
        const at = rows.indexOf(twin);
        if (at >= 0) rows.splice(at, 1);
      }
      continue;
    }
    seen.set(key, next);
    rows.push(next);
  }
  const printed = printedFigures([...table.slice(0, Math.max(headerRow, 0)).map((r) => r.join(" ")), ...trailer]);
  if (!rows.length) return { ok: false, error: `No papers could be read from ${input.name}.${skipped.length ? ` ${skipped.slice(0, 3).map((s) => s.why).join(" ")}` : ""}` };
  return {
    ok: true,
    list: {
      v: 1,
      from: input.from,
      name: input.name,
      listDate: input.listDate,
      listDateFrom: input.listDateFrom,
      accountNumber,
      printedTotal: input.printedTotal ?? printed.total,
      printedCount: input.printedCount ?? printed.count,
      rows,
      skipped,
      header,
      columns,
    },
  };
}

/** A pasted or text-file table: tabs, else commas, else two-or-more spaces. */
export function tableFromText(text: string, parseCsv: (t: string) => string[][]): string[][] {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const tabbed = lines.filter((l) => l.includes("\t")).length;
  if (tabbed >= 2) return lines.map((l) => l.split("\t")).filter((r) => r.some((c) => c.trim()));
  const commas = lines.filter((l) => l.split(",").length >= 3).length;
  if (commas >= 2) return parseCsv(text);
  return lines.map((l) => l.trim().split(/\s{2,}/)).filter((r) => r.some((c) => c.trim()));
}

// ── A STATEMENT'S TEXT (a PDF's text layer) ────────────────────────────────────────────────────

const DATE_TOKEN = /\b(\d{1,2}[/-]\d{1,2}[/-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})\b/g;
const MONEY_TOKEN = /\(\$?\s*[\d,]*\d\.\d{2}\)|-?\$?\s*[\d,]*\d\.\d{2}-?/g;

/** The labels a statement prints over its columns, as their own lines (a column-wise text dump).
 *  "Amount" is the paper's amount and "Balance" what is still open on it: a statement that prints
 *  both is read by its balance, and one that prints only an amount (CED's does) by that. */
const STATEMENT_LABELS: Record<string, OpenListField | "age" | "total" | "account" | "date" | "page"> = {
  reference: "reference",
  "reference number": "reference",
  invoice: "reference",
  "invoice number": "reference",
  "document number": "reference",
  code: "type",
  type: "type",
  "customer po": "po",
  po: "po",
  "po number": "po",
  "job name": "po",
  amount: "amount",
  "original amount": "amount",
  "invoice amount": "amount",
  balance: "openBalance",
  "open balance": "openBalance",
  "open amount": "openBalance",
  "amount due": "openBalance",
  "due date": "dueDate",
  date: "date",
  "invoice date": "invoiceDate",
  age: "age",
  "total due": "total",
  "balance due": "total",
  "total balance": "total",
  account: "account",
  "account number": "account",
  page: "page",
};

type Block = { label: string; values: string[] };

const moneyValues = (b: Block) => b.values.filter((v) => readMoney(v) !== null);

/**
 * A statement whose PDF text comes out one column at a time (CED's monthly statement does: every
 * label on its own line, then that column's values). The columns are zipped back into rows only
 * when the paper number and the money columns hold the same number of values. EVERY PAGE: each
 * page repeats the labels, so each block of paper numbers is zipped with its own page's columns and
 * the pages are put together; a page that can't be zipped is named, never dropped without a word.
 */
function statementFromColumns(lines: readonly string[]): {
  rows: string[][];
  header: string[];
  date: string | null;
  account: string | null;
  total: number | null;
  skipped: { line: number; why: string }[];
} | null {
  const blocks: (Block & { line: number })[] = [];
  let current: (Block & { line: number }) | null = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const key = headerKey(line);
    if (STATEMENT_LABELS[key]) {
      current = { label: STATEMENT_LABELS[key] as string, values: [], line: i + 1 };
      blocks.push(current);
    } else if (current) {
      current.values.push(line);
    }
  });
  const refAts = blocks.map((b, i) => (b.label === "reference" && b.values.some(looksLikeReference) ? i : -1)).filter((i) => i >= 0);
  if (!refAts.length) return null;
  const rows: string[][] = [];
  const skipped: { line: number; why: string }[] = [];
  let firstRefAt = -1;
  let firstDates: Block | undefined;
  let pageStart = 0;
  refAts.forEach((refAt, k) => {
    const ref = blocks[refAt];
    const values = ref.values.filter(looksLikeReference);
    const n = values.length;
    const pageEnd = k + 1 < refAts.length ? refAts[k + 1] : blocks.length;
    const after = blocks.slice(refAt + 1, pageEnd);
    // This page's money: its balance column when it prints one, else its amount column.
    const fits = (label: string) => after.find((b) => b.label === label && moneyValues(b).length >= n);
    const balance = fits("openBalance");
    const amount = fits("amount");
    const money = balance ?? amount;
    if (!money) {
      skipped.push({ line: ref.line, why: `${n === 1 ? "One paper" : `${n} papers`} under "Reference" (${values.slice(0, 2).join(", ")}${n > 2 ? "…" : ""}) had no balance beside ${n === 1 ? "it" : "them"} that could be read.` });
      pageStart = refAt + 1;
      return;
    }
    const opens = moneyValues(money).slice(0, n);
    const amounts = balance && amount ? moneyValues(amount).slice(0, n) : null;
    const before = blocks.slice(pageStart, refAt).reverse();
    const near = (label: string) => [...before, ...after].find((b) => b.label === label && b.values.length === n);
    const dates = near("date") ?? near("invoiceDate");
    const types = near("type");
    const pos = near("po");
    values.forEach((ref0, i) => rows.push([ref0, types?.values[i] ?? "", pos?.values[i] ?? "", dates?.values[i] ?? "", amounts?.[i] ?? "", opens[i]]));
    if (firstRefAt < 0) {
      firstRefAt = refAt;
      firstDates = dates;
    }
    pageStart = blocks.indexOf(money) + 1;
  });
  if (!rows.length) return null;
  // The statement's own date: a DATE label with one date under it, above the first table.
  const single = blocks.slice(0, firstRefAt).find((b) => (b.label === "date" || b.label === "invoiceDate") && b.values.length >= 1 && readDate(b.values[0]) && b !== firstDates);
  const acct = blocks.find((b) => b.label === "account" && b.values.length >= 1)?.values[0] ?? null;
  // Every page prints the balance due; the last one is the statement's own.
  const totalBlock = blocks.filter((b) => b.label === "total" && b.values.length >= 1).pop();
  return {
    rows,
    header: ["Reference", "Type", "PO", "Date", "Amount", "Open Balance"],
    date: single ? readDate(single.values[0]) : null,
    account: acct && /\d/.test(acct) ? acct.trim() : null,
    total: totalBlock ? readMoney(totalBlock.values[0]) : null,
    skipped,
  };
}

/**
 * A statement whose text keeps each row on one line: a paper number, its date and money on it. A
 * row with no date of its own is not a statement row (an invoice's item lines have a SKU, a
 * quantity and a price, and no date), so it is not read.
 */
function statementFromLines(lines: readonly string[]): { rows: string[][]; header: string[] } | null {
  let headerAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const words = headerKey(lines[i]);
    const hasRef = /\b(reference|invoice|document|ref|inv)\b/.test(words);
    const hasMoney = /\b(amount|balance|due|open|total)\b/.test(words);
    if (hasRef && hasMoney && words.split(" ").length >= 3 && !isLineItemHeader(lines[i])) {
      headerAt = i;
      break;
    }
  }
  if (headerAt < 0) return null;
  const rows: string[][] = [];
  for (const raw of lines.slice(headerAt + 1)) {
    const line = raw.trim();
    const moneys = [...line.matchAll(MONEY_TOKEN)].map((m) => m[0]);
    if (!moneys.length) continue;
    const dates = [...line.matchAll(DATE_TOKEN)].map((m) => m[0]);
    if (!dates.length) continue;
    let rest = line;
    for (const d of dates) rest = rest.replace(d, " ");
    for (const m of moneys) rest = rest.replace(m, " ");
    const tokens = rest.split(/\s+/).filter(Boolean);
    const ref = tokens.find((t) => /\d{4,}/.test(t) && looksLikeReference(t));
    if (!ref) continue;
    const words = tokens.filter((t) => t !== ref && /[A-Za-z]/.test(t)).join(" ");
    rows.push([ref, words, dates[0] ?? "", dates[1] ?? "", moneys.length > 1 ? moneys[0] : "", moneys[moneys.length - 1]]);
  }
  if (!rows.length) return null;
  return { rows, header: ["Reference", "Type", "Invoice Date", "Due Date", "Amount", "Open Balance"] };
}

/** "STATEMENT DATE 09/25/26", "Statement Date: Sep 25, 2026", "DATE\n09/25/26" near the top. */
function statementDate(lines: readonly string[]): string | null {
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const line = lines[i];
    const m = /^\s*(?:statement\s*date|as\s*of|date)\b\s*:?\s*(.+)$/i.exec(line);
    if (m) {
      const d = readDate(m[1].trim()) ?? readDate(m[1].trim().split(/\s+/)[0]);
      if (d) return d;
    }
  }
  return null;
}

/**
 * WHAT MAKES TEXT A STATEMENT: its own title or label on a line by itself ("STATEMENT", "Customer
 * Statement - Open Items", "Statement Date: 09/20/26", "Open Items"), never the bare word anywhere
 * (an invoice says "Net 10th following statement" and "remit with your statement").
 */
const STATEMENT_TITLE =
  /^(?:(?:customer|account|monthly|vendor|supplier|open item|open items)\s+)?statement(?:\s+of\s+account)?(?:\s+(?:open items|open invoices|date\b.*|of\b.*))?$|^statement\s+date\b|^(?:open items|open invoices|open item list|open items list|aged? (?:receivables|payables|balance)|aging(?: report| summary)?|account aging)$/;

/** An invoice's own item table: a quantity and a price (or description) over the same columns. */
const QTY_WORDS = /\b(qty|quantity|ordered|shipped|ship qty|order qty|b\s*o)\b/;
const PRICE_WORDS = /\b(price|unit|each|ext|extension|extended|description|sku|catalog)\b/;
function isLineItemHeader(line: string): boolean {
  const words = headerKey(line);
  return QTY_WORDS.test(words) && PRICE_WORDS.test(words);
}

/** Does this text read as a supplier statement or an open-items list at all? Its own title, and no
 *  invoice item table. */
export function looksLikeStatementText(text: string): boolean {
  const lines = String(text ?? "").slice(0, 4000).replace(/\r\n?/g, "\n").split("\n");
  if (lines.some(isLineItemHeader)) return false;
  return lines.slice(0, 80).some((l) => STATEMENT_TITLE.test(headerKey(l)));
}

/**
 * A statement PDF's text into an OpenList, or null when it doesn't read as one. The date is the
 * one it prints; when it prints none, the newest paper on it stands in, so nothing dated after
 * the newest listed paper can be closed by it.
 */
export function openListFromStatementText(text: string, name: string): OpenList | null {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const columns = statementFromColumns(lines);
  const byLines = columns ? null : statementFromLines(lines);
  const got = columns ?? byLines;
  if (!got) return null;
  const table = [got.header, ...got.rows];
  const printed = printedFigures(lines);
  const read = readOpenListTable({
    table,
    from: "statement",
    name,
    listDate: (columns?.date ?? null) || statementDate(lines),
    listDateFrom: "printed",
    printedTotal: columns?.total ?? printed.total,
    printedCount: printed.count,
    accountNumber: columns?.account ?? accountFromText(lines),
  });
  if (!read.ok) return null;
  const list = read.list;
  if (columns?.skipped.length) list.skipped = [...columns.skipped, ...list.skipped];
  if (!list.listDate) {
    const newest = list.rows.map((r) => r.invoiceDate).filter((d): d is string => !!d).sort().pop() ?? null;
    list.listDate = newest;
    list.listDateFrom = newest ? "newest" : null;
  }
  return list;
}

function accountFromText(lines: readonly string[]): string | null {
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const m = /\b(?:account|acct)\s*(?:number|no\.?|#)?\s*:?\s*([A-Z0-9][A-Z0-9-]{2,24})\b/i.exec(lines[i]);
    if (m && /\d/.test(m[1])) return m[1];
    if (/^(account|account number|acct)$/i.test(lines[i].trim())) {
      const next = String(lines[i + 1] ?? "").trim();
      if (/^[A-Z0-9][A-Z0-9-]{2,24}$/i.test(next) && /\d/.test(next)) return next;
    }
  }
  return null;
}

/**
 * WHAT THE READER (a model looking at a scanned statement) TRANSCRIBED, into an OpenList. The
 * model's rows are a transcription, so the list is complete only when they add up to the total
 * it read off the same paper, or a person says so after looking.
 */
export function openListFromReader(statement: unknown, name: string): OpenList | null {
  const s = statement && typeof statement === "object" ? (statement as Record<string, unknown>) : null;
  if (!s || !Array.isArray(s.lines) || !s.lines.length) return null;
  const table: string[][] = [["Reference", "Type", "PO", "Invoice Date", "Due Date", "Amount", "Open Balance", "Discount"]];
  for (const l of s.lines as Record<string, unknown>[]) {
    if (!l || typeof l !== "object") continue;
    table.push([l.reference, l.type, l.po, l.date, l.due_date, l.amount, l.open_balance ?? l.amount, l.discount].map((v) => (v === null || v === undefined ? "" : String(v))));
  }
  const date = readDate(s.date);
  const read = readOpenListTable({
    table,
    from: "reader",
    name,
    listDate: date,
    listDateFrom: date ? "printed" : null,
    printedTotal: readMoney(s.total_due),
    printedCount: null,
    accountNumber: s.account_number ? String(s.account_number).trim().slice(0, 40) || null : null,
  });
  if (!read.ok) return null;
  const list = read.list;
  if (!list.listDate) {
    const newest = list.rows.map((r) => r.invoiceDate).filter((d): d is string => !!d).sort().pop() ?? null;
    list.listDate = newest;
    list.listDateFrom = newest ? "newest" : null;
  }
  return list;
}

// ── RECONCILING A LIST AGAINST THE ACCOUNT'S PAPERS ────────────────────────────────────────────

/** One supplier paper as the app holds it (supplier_invoices). */
export type OpenListPaper = {
  id: string;
  invoiceNumber: string;
  kind: string;
  invoiceDate: string | null;
  dueDate: string | null;
  total: number;
  openBalance: number | null;
  closed: boolean;
  discountAmount: number | null;
  discountBy: string | null;
  jobNameRaw: string | null;
  supplierAccountId: string | null;
};

/** The columns Apply may write on a paper already here, and what Undo puts back. */
export type PaperFields = {
  open_balance?: number | null;
  closed?: boolean;
  discount_amount?: number | null;
  discount_by?: string | null;
  due_date?: string | null;
  supplier_account_id?: string | null;
};

export type PlanPaper = { id: string; number: string; date: string | null; open: number };
export type PlanUpdate = { id: string; number: string; prior: PaperFields; wrote: PaperFields; said: string };
export type PlanAdd = { number: string; row: OpenListRow };

export type OpenListPlan = {
  accountId: string;
  listDate: string | null;
  /** The last day a paper can be dated and still be marked paid by this list (closeCutoff). */
  closeBy: string | null;
  /** Open here, gone from the list, dated on or before `closeBy`: marked paid. */
  close: PlanPaper[];
  /** Open here, gone from the list, dated AFTER `closeBy`: the supplier may not have it yet. Left open. */
  keepNewer: PlanPaper[];
  /** Open here, gone from the list, with no date (or a list with none): nothing proves it is older. Left open. */
  keepUndated: PlanPaper[];
  /** Open here, gone from a list whose own total or count says it is missing papers: left open. */
  keepPartial: PlanPaper[];
  add: PlanAdd[];
  update: PlanUpdate[];
  same: string[];
  /** Listed numbers already on another supplier's account: never touched. */
  conflicts: { number: string; why: string }[];
  /** Payments and unapplied cash on the list: not papers. */
  payments: OpenListRow[];
  totals: {
    /** Open on this account in the app before, and after Apply (model B: what the supplier says). */
    before: number;
    after: number;
    closed: number;
    added: number;
    /** The list's own sums. */
    listPapers: number;
    listPayments: number;
    listTotal: number;
    listDiscount: number;
    listNet: number;
    /** `after` less the payments the list carries that the supplier hasn't applied to a paper yet. */
    afterNet: number;
  };
  /**
   * Whether the list is known to be the whole open list, and how. `overridable`: the list prints
   * no total and no count of its own, so a person's word is the only check there can be. When it
   * prints one and the rows disagree, no word overrides it: nothing is marked paid from it.
   */
  complete: { ok: boolean; how: "total" | "total_net" | "count" | "person" | null; said: string; overridable: boolean };
  /** Nothing would change. */
  nothing: boolean;
  fingerprint: string;
};

const sum = (ns: number[]) => r2(ns.reduce((a, b) => a + b, 0));
const openOf = (p: OpenListPaper) => (p.openBalance === null || p.openBalance === undefined ? r2(Number(p.total) || 0) : r2(Number(p.openBalance)));

/** A list row's key and a paper's key are the same function, so they can only meet exactly. */
export const referenceKey = (raw: string | null | undefined) => normalizeDocNumber(raw);

/** Money said the way a person reads it: $2,070.22, -$82.10. */
export function sayDollars(n: number): string {
  const v = Math.abs(r2(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${v}`;
}

/** Stable across server and browser: the plan's writes, hashed. A plan that changes between the
 *  preview and Apply (someone else closed a paper) has a different fingerprint, and Apply says so. */
export function fingerprintOf(parts: string[]): string {
  let h = 5381;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Days a supplier may take to post a paper it has already sent (its portal lags its email). */
export const POSTING_DAYS = 7;

const minusDays = (ymd: string, days: number) => {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
};

/**
 * THE LAST DAY A PAPER CAN BE DATED AND STILL BE MARKED PAID BY THIS LIST. A supplier's list is
 * only as new as the newest paper it carries: one the app already has from the emailed PDF may not
 * be posted on the supplier's side yet, and its absence from the list says nothing. So the day is
 * the newest dated paper on the list, or the list's own date less a week of posting, whichever is
 * later, and never after the list's date. A list whose rows carry no dates of their own proves no
 * paper older than anything, and closes nothing.
 */
export function closeCutoff(list: Pick<OpenList, "listDate" | "rows">): string | null {
  if (!list.listDate) return null;
  const dated = list.rows.filter((r) => r.kind !== "payment" && r.invoiceDate).map((r) => r.invoiceDate as string).sort();
  if (!dated.length) return null;
  const newest = dated[dated.length - 1];
  const allowance = minusDays(list.listDate, POSTING_DAYS);
  const by = newest > allowance ? newest : allowance;
  return by > list.listDate ? list.listDate : by;
}

export function reconcileOpenList(list: OpenList, papers: readonly OpenListPaper[], accountId: string): OpenListPlan {
  const listDate = list.listDate;
  const closeBy = closeCutoff(list);
  // One number can sit on more than one account (0354: unique per supplier account). The list's
  // own account's paper wins, then a paper on no account, then another supplier's; so the "another
  // supplier's account" line fires only when neither of the first two holds the number.
  const rank = (p: OpenListPaper) => (p.supplierAccountId === accountId ? 0 : p.supplierAccountId ? 2 : 1);
  const byKey = new Map<string, OpenListPaper>();
  for (const p of papers) {
    const k = referenceKey(p.invoiceNumber);
    const cur = k ? byKey.get(k) : undefined;
    if (k && (!cur || rank(p) < rank(cur))) byKey.set(k, p);
  }
  const listed = new Set<string>();
  const add: PlanAdd[] = [];
  const update: PlanUpdate[] = [];
  const same: string[] = [];
  const conflicts: OpenListPlan["conflicts"] = [];
  const payments: OpenListRow[] = [];

  for (const row of list.rows) {
    if (row.kind === "payment") {
      payments.push(row);
      continue;
    }
    const key = referenceKey(row.reference);
    listed.add(key);
    const paper = byKey.get(key);
    if (!paper) {
      add.push({ number: row.reference, row });
      continue;
    }
    if (paper.supplierAccountId && paper.supplierAccountId !== accountId) {
      conflicts.push({ number: paper.invoiceNumber, why: `${paper.invoiceNumber} is already on another supplier's account, so it was left as it is.` });
      continue;
    }
    const prior: PaperFields = {};
    const wrote: PaperFields = {};
    const saidParts: string[] = [];
    const open = row.openBalance;
    const closedNow = moneyCents(open) === 0;
    if (moneyCents(openOf(paper)) !== moneyCents(open) || paper.openBalance === null) {
      prior.open_balance = paper.openBalance;
      wrote.open_balance = open;
      saidParts.push(`open ${sayDollars(openOf(paper))} → ${sayDollars(open)}`);
    }
    if (paper.closed !== closedNow) {
      prior.closed = paper.closed;
      wrote.closed = closedNow;
      saidParts.push(closedNow ? "paid" : `open again (${list.name} still lists it)`);
    }
    if (row.discountAmount !== null && moneyCents(row.discountAmount) !== moneyCents(paper.discountAmount)) {
      prior.discount_amount = paper.discountAmount;
      wrote.discount_amount = row.discountAmount;
      saidParts.push(`discount ${sayDollars(row.discountAmount)}`);
    }
    if (row.discountBy && row.discountAmount !== null && row.discountBy !== paper.discountBy) {
      prior.discount_by = paper.discountBy;
      wrote.discount_by = row.discountBy;
      saidParts.push(`discount by ${row.discountBy}`);
    }
    if (!paper.supplierAccountId) {
      prior.supplier_account_id = null;
      wrote.supplier_account_id = accountId;
      saidParts.push("joins this account");
    }
    if (Object.keys(wrote).length) update.push({ id: paper.id, number: paper.invoiceNumber, prior, wrote, said: saidParts.join(", ") });
    else same.push(paper.invoiceNumber);
  }

  const listPapers = sum(list.rows.filter((r) => r.kind !== "payment").map((r) => r.openBalance));
  const listPayments = sum(payments.map((r) => r.openBalance));
  const listTotal = r2(listPapers + listPayments);
  const listDiscount = sum(list.rows.map((r) => r.discountAmount ?? 0));
  const listNet = r2(listTotal - listDiscount);
  const complete = completeness(list, listTotal, listNet, listDiscount);

  let close: PlanPaper[] = [];
  const keepNewer: PlanPaper[] = [];
  const keepUndated: PlanPaper[] = [];
  let keepPartial: PlanPaper[] = [];
  const onAccount = papers.filter((p) => p.supplierAccountId === accountId);
  for (const p of onAccount) {
    if (p.closed || listed.has(referenceKey(p.invoiceNumber))) continue;
    const said: PlanPaper = { id: p.id, number: p.invoiceNumber, date: p.invoiceDate, open: openOf(p) };
    if (!p.invoiceDate || !closeBy) keepUndated.push(said);
    else if (p.invoiceDate > closeBy) keepNewer.push(said);
    else close.push(said);
  }
  // A LIST ITS OWN FIGURES CALL SHORT marks nothing paid, and no one's word changes that: what it
  // would have closed is shown, left open.
  if (!complete.ok && !complete.overridable) {
    keepPartial = close;
    close = [];
  }
  const byDate = (a: PlanPaper, b: PlanPaper) => String(a.date ?? "").localeCompare(String(b.date ?? "")) || a.number.localeCompare(b.number);
  close.sort(byDate);
  keepNewer.sort(byDate);
  keepPartial.sort(byDate);

  // THE BALANCE AFTER, by simulation: every paper on the account (and every one joining it) with
  // what Apply would write, summed the way supplier-balance sums an open paper.
  const before = sum(onAccount.filter((p) => !p.closed).map(openOf));
  const after = (() => {
    const state = new Map<string, { open: number; closed: boolean; on: boolean }>();
    for (const p of papers) state.set(p.id, { open: openOf(p), closed: p.closed, on: p.supplierAccountId === accountId });
    for (const c of close) state.set(c.id, { open: 0, closed: true, on: true });
    for (const u of update) {
      const s = state.get(u.id)!;
      state.set(u.id, {
        open: u.wrote.open_balance !== undefined ? Number(u.wrote.open_balance) : s.open,
        closed: u.wrote.closed !== undefined ? u.wrote.closed : s.closed,
        on: s.on || u.wrote.supplier_account_id === accountId,
      });
    }
    let total = 0;
    for (const s of state.values()) if (s.on && !s.closed) total += s.open;
    for (const a of add) if (moneyCents(a.row.openBalance) !== 0) total += a.row.openBalance;
    return r2(total);
  })();

  const plan: Omit<OpenListPlan, "fingerprint"> = {
    accountId,
    listDate,
    closeBy,
    close,
    keepNewer,
    keepUndated,
    keepPartial,
    add,
    update,
    same,
    conflicts,
    payments,
    totals: {
      before,
      after,
      closed: sum(close.map((c) => c.open)),
      added: sum(add.map((a) => a.row.openBalance)),
      listPapers,
      listPayments,
      listTotal,
      listDiscount,
      listNet,
      afterNet: r2(after + listPayments),
    },
    complete,
    nothing: !close.length && !add.length && !update.length,
  };
  return {
    ...plan,
    fingerprint: fingerprintOf([
      accountId,
      ...close.map((c) => `c:${c.id}:${moneyCents(c.open)}`),
      ...add.map((a) => `a:${referenceKey(a.number)}:${moneyCents(a.row.openBalance)}`),
      ...update.map((u) => `u:${u.id}:${JSON.stringify(u.wrote)}:${JSON.stringify(u.prior)}`),
    ]),
  };
}

function completeness(list: OpenList, listTotal: number, listNet: number, listDiscount: number): OpenListPlan["complete"] {
  const skippedSaid = list.skipped.length ? ` ${list.skipped.length === 1 ? "One row" : `${list.skipped.length} rows`} didn't read.` : "";
  const noClose = " Nothing is marked paid from it; drop the whole list (every page) to bring the books in line.";
  if (list.printedTotal !== null) {
    if (moneyCents(list.printedTotal) === moneyCents(listTotal))
      return { ok: true, how: "total", said: `The rows add to the ${sayDollars(list.printedTotal)} the list prints.`, overridable: false };
    if (moneyCents(listDiscount) !== 0 && moneyCents(list.printedTotal) === moneyCents(listNet))
      return {
        ok: true,
        how: "total_net",
        said: `The rows add to ${sayDollars(listTotal)}; less ${sayDollars(listDiscount)} of discount that is the ${sayDollars(list.printedTotal)} the list prints.`,
        overridable: false,
      };
    // The supplier's own figure says papers are missing: no one's word overrides it.
    return {
      ok: false,
      how: null,
      said: `The rows add to ${sayDollars(listTotal)}, but the list prints ${sayDollars(list.printedTotal)}, so it is missing papers.${skippedSaid}${noClose}`,
      overridable: false,
    };
  }
  if (list.printedCount !== null) {
    if (list.printedCount === list.rows.length && !list.skipped.length)
      return { ok: true, how: "count", said: `All ${list.printedCount} papers the list counts were read.`, overridable: false };
    return {
      ok: false,
      how: null,
      said: `The list counts ${list.printedCount} papers, and ${list.rows.length} were read.${skippedSaid}${noClose}`,
      overridable: false,
    };
  }
  if (list.wholeList) return { ok: true, how: "person", said: "You said this is the whole open list.", overridable: true };
  return {
    ok: false,
    how: null,
    said: `The list doesn't print its own total, so it could be one page of several.${skippedSaid} If the supplier's own page shows ${sayDollars(listTotal)}${moneyCents(listDiscount) ? ` (or ${sayDollars(listNet)} after ${sayDollars(listDiscount)} of discount)` : ""}, it is the whole list.`,
    overridable: true,
  };
}

// ── WHAT THE CARD SAYS ─────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Sep 26" / "Sep 26, 2025" (the year only when it is not the current one). */
export function sayDay(ymd: string | null, today?: string | null): string {
  if (!ymd) return "no date";
  const d = new Date(`${ymd}T12:00:00Z`);
  const sameYear = today ? today.slice(0, 4) === ymd.slice(0, 4) : true;
  return d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * THE ONE SENTENCE: "CED's statement of Sep 26: 16 papers marked paid ($2,070.22), 3 new, balance
 * now $3,304.73." The account's own name, never a supplier baked in.
 */
export function planHeadline(plan: OpenListPlan, list: Pick<OpenList, "from">, supplier: string, today?: string | null): string {
  const what = list.from === "statement" || list.from === "reader" ? "statement" : "open list";
  const lead = `${possessive(supplier)} ${what} of ${sayDay(plan.listDate, today)}`;
  // THE SUPPLIER'S FIGURE: a payment it hasn't applied to a paper yet comes off the balance, and is said.
  const unapplied = plan.totals.listPayments;
  const balance = moneyCents(unapplied)
    ? `${sayDollars(plan.totals.afterNet)} after ${sayDollars(Math.abs(unapplied))} of payment ${String(supplier ?? "").trim() || "the supplier"} hasn't applied to a paper yet`
    : sayDollars(plan.totals.after);
  const partial = plan.keepPartial.length ? `, ${plural(plan.keepPartial.length, "paper", "papers")} it doesn't list left open (it is missing papers)` : "";
  if (plan.nothing) return `${lead}: ${plan.keepPartial.length ? `nothing to change${partial}` : "matches your books"}. Balance ${balance}.`;
  const parts: string[] = [];
  if (plan.close.length) parts.push(`${plural(plan.close.length, "paper", "papers")} marked paid (${sayDollars(plan.totals.closed)})`);
  if (plan.add.length) parts.push(`${plan.add.length} new`);
  if (plan.update.length) parts.push(`${plan.update.length} changed`);
  return `${lead}: ${parts.join(", ")}${partial}, balance now ${balance}.`;
}

/** "Tahoe Lumber's", "Consolidated Electrical Distributors'". */
export function possessive(name: string): string {
  const n = String(name ?? "").trim() || "The supplier";
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

/** The discount line, when the list carries discount: what the supplier's own "pay now" figure is. */
export function discountLine(plan: OpenListPlan): string | null {
  const d = plan.totals.listDiscount;
  if (!moneyCents(d)) return null;
  return `After ${sayDollars(d)} of prompt-pay discount on the list: ${sayDollars(r2(plan.totals.afterNet - d))}.`;
}

// ── WHAT THE PAPER'S ROW KEEPS ─────────────────────────────────────────────────────────────────

/** What Apply did, kept so Undo puts back exactly the values it replaced. */
export type OpenListApplied = {
  at: string;
  by: string | null;
  fingerprint: string;
  headline: string;
  /** Papers Apply added, and what it wrote on each (Undo removes one only while nothing is tied to
   *  it and it still says what Apply wrote). */
  added: { id: string; number: string; wrote?: PaperFields }[];
  /** Papers Apply changed: what they were, and what Apply wrote (Undo restores only a paper that
   *  still says what Apply wrote). */
  changed: { id: string; number: string; prior: PaperFields; wrote: PaperFields }[];
  /** True between claiming the row and finishing the writes. */
  pending?: boolean;
};

/** On organized_items.proposal.openList: the list (or the columns it still needs) and what Apply did. */
export type StoredOpenList = {
  list: OpenList | null;
  needs: OpenListNeedsColumns | null;
  applied?: OpenListApplied | null;
};

/**
 * THE CARD, AS THE PAGE HANDS IT TO THE ROW: worked out on the server every time the tray is shown
 * (so it is never stale), plain data only.
 */
export type OpenListView = {
  supplier: string | null;
  accountId: string | null;
  accountFrom: OpenList["accountFrom"];
  /** Every supplier account, for "Whose List Is This?". */
  accounts: { id: string; name: string }[];
  /** An account whose remembered column names read this list word for word: offered first in
   *  "Whose List Is This?", never chosen for the person. */
  suggestedAccountId?: string | null;
  /** The columns a person still has to point at. */
  needs: null | {
    header: string[];
    sample: string[][];
    headerRow: number;
    width: number;
    columns: OpenListColumns;
    missing: OpenListField[];
  };
  plan: null | {
    headline: string;
    discountLine: string | null;
    complete: { ok: boolean; said: string; overridable: boolean };
    fingerprint: string;
    nothing: boolean;
    closeBy: string | null;
    close: PlanPaper[];
    keepNewer: PlanPaper[];
    keepUndated: PlanPaper[];
    keepPartial: PlanPaper[];
    add: { number: string; kind: string; date: string | null; po: string | null; open: number }[];
    update: { number: string; said: string }[];
    conflicts: { number: string; why: string }[];
    payments: { reference: string; open: number }[];
    skipped: { line: number; why: string }[];
    before: number;
    after: number;
    /** `after` less the payments on the list the supplier hasn't applied yet. */
    afterNet: number;
    firstList: boolean;
  };
  dateSaid: string;
  /** Something that stops it, in words (no supplier account at all, a list that read nothing). */
  problem: string | null;
};

/** The card's own words for where the list's date came from. */
export function listDateSaid(list: Pick<OpenList, "listDate" | "listDateFrom">, today?: string | null): string {
  const day = sayDay(list.listDate, today);
  switch (list.listDateFrom) {
    case "printed":
      return `${day}, the date it prints`;
    case "file":
      return `${day}, the day the file was saved`;
    case "today":
      return `${day}, the day it came in`;
    case "newest":
      return `${day}, its newest paper (it prints no date)`;
    default:
      return day;
  }
}

/**
 * TEXT THAT IS A LIST: a statement's own text, else a table with a header this knows. `strict`
 * (the paste box and the CED door, which mostly see invoices) takes a table only when its header
 * row names a paper number and money; a dropped CSV is a list whatever it says.
 */
export function openListFromText(
  text: string,
  opts: { name: string; from: OpenListSource; listDate: string | null; listDateFrom: OpenList["listDateFrom"]; parseCsv: (t: string) => string[][]; strict: boolean },
): StoredOpenList | null {
  if (looksLikeStatementText(text)) {
    const list = openListFromStatementText(text, opts.name);
    if (list) return { list, needs: null };
  }
  // AN INVOICE'S ITEM TABLE (Qty, Price) is never a list of open papers, whatever its columns say.
  if (String(text ?? "").slice(0, 4000).split(/\r?\n/).some(isLineItemHeader)) return null;
  const table = tableFromText(text, opts.parseCsv);
  if (table.length < 2) return null;
  if (opts.strict) {
    const at = findHeaderRow(table);
    if (at < 0) return null;
    const { columns } = readHeaderRow(table[at]);
    if (columns.reference === undefined || (columns.openBalance === undefined && columns.amount === undefined)) return null;
  }
  const read = readOpenListTable({ table, from: opts.from, name: opts.name, listDate: opts.listDate, listDateFrom: opts.listDateFrom });
  if (read.ok) return { list: read.list, needs: null };
  if ("needs" in read) return opts.strict ? null : { list: null, needs: read.needs };
  return null;
}
