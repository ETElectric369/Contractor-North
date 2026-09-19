"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { requireStaff } from "@/lib/staff-guard";
import { parseCedDocuments, type CedInvoice } from "@/lib/ced-invoice-parse";
// sayMoney lives in payroll-math because payroll needed it first. Pure string formatting with no
// payroll in it, and a second copy here would drift the moment one of them learned about cents.
import { sayMoney } from "@/lib/payroll-math";

/**
 * LOADING THE SUPPLIER'S OWN INVOICES, SO NEXT MONTH HE DOES NOT NEED ME (Erik, 2026-09-19; 0273).
 *
 * Tonight Erik got into his CED payment portal and downloaded every document on the account. I
 * read all forty-seven by hand and loaded them, and what they said was that the app had been
 * confidently wrong about money for four months: $5,421.55 of "unpaid" bills were settled weeks
 * ago, $1,765.72 of purchases were in his books nowhere at all, and two of his bills were never
 * bills but STATEMENTS covering two invoices each.
 *
 * That reconciliation is done. This is so that next month is a paste rather than a night: he
 * downloads the same documents, drops them in here, and the ledger catches up on its own.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * RE-IMPORTING THE SAME DOWNLOAD CHANGES NOTHING, and that is the property the whole file is
 * built around. He will re-download overlapping months - anybody would - and an importer that
 * doubled a $2,950.17 invoice because it saw it twice would be a worse bug than the one this
 * wave is fixing. So every document is keyed on (org_id, invoice_number), the unique index
 * migration 0273 put there, and a document already on file is compared field by field: if the
 * paper says nothing new, NOTHING IS WRITTEN AT ALL. Not a no-op update, not a touched
 * timestamp - no write.
 *
 * WHAT A RE-IMPORT MAY NEVER DO, in order of how much it would cost him:
 *
 *   1. NEVER OVERWRITE A JOB A PERSON SET. `job_id` is not in any patch in this file. CED prints
 *      a job name and it is a gift, but his same road reads "5659 RHODESIA", "561 RHODESIA",
 *      "5661 RHODESIA" and "5659 RODESSIA" and he has FIVE jobs on it. The raw name is stored;
 *      only a person resolves it, and re-reading the paper must never undo that.
 *   2. NEVER RE-OPEN A SETTLED DOCUMENT. The supplier's "***PAID IN FULL***" stamp can CLOSE a
 *      document here. The absence of that stamp closes nothing and opens nothing, because a PDF
 *      downloaded in June cannot know what was paid in September. The rule is one-way on purpose.
 *   3. NEVER TOUCH LINES THAT ARE ALREADY THERE. Line items are written once, when a document
 *      first arrives with none. They are his contract prices; re-parsing them into the same rows
 *      would at best be pointless and at worst renumber something a person had corrected.
 *
 * NOTHING SILENT. Every write comes back with `.select("id")` and a zero-row result is a refusal
 * said out loud, because a zero-row write is a 204 and a 204 reads exactly like success. Every
 * document that refused is named, one by one: "some of them failed" is not a sentence anybody can
 * act on, and the one in question is usually the one with the money on it.
 *
 * ORG_ID RIDES ON EVERY INSERT. Migration 0273 created these three tables without the `set_org_id`
 * trigger the older tables got in 0004, and all three org_id columns are `not null` - an insert
 * that leaves org_id to the database fails outright. Same as 0270's tables; same handoff note.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * THIS READS TEXT, NOT PDFs, AND SAYS SO RATHER THAN PRETENDING.
 *
 * There is no server-side PDF text extractor wired up in this app. `pdfjs-dist` is in
 * package.json, but it is used in ONE place and that place is the browser (print/pdf-preview/
 * viewer.tsx); nothing on the server has ever imported it, it is not in `serverExternalPackages`
 * in next.config.ts, and every other server-side "read a PDF" in this tree hands the file to a
 * language model instead. A language model is exactly the wrong instrument for an invoice total:
 * the whole point of ced-invoice-parse.ts is arithmetic that either reconciles or refuses.
 *
 * So this takes text. A PDF handed to it is refused BY NAME with the sentence that says what to do
 * instead, and the fix - extracting the text in the BROWSER with the pdfjs-dist already installed,
 * the way the print preview already does - is a change to the card, which is not this file. See
 * the handoff note. `files` takes `{ name, text }` precisely so that the day the card extracts, it
 * has somewhere to send what it read with no change here.
 */

/** Cents, so a fraction of a penny can never ride into a balance. */
const money = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;
const cents = (n: unknown): number => Math.round((Number(n) || 0) * 100);

/** One document as the screen names it back to him. */
export interface ImportedDocument {
  invoiceNumber: string;
  kind: string;
  total: number;
  jobNameRaw: string | null;
  /** Which file it was read out of, so a figure on screen can be traced to a document. */
  sourceFile: string | null;
}

export interface SupplierImportResult {
  ok: boolean;
  error?: string;
  /** The sentence the SERVER writes, because only it knows what actually landed in the database. */
  message?: string;
  /** Documents written for the first time. */
  landed: ImportedDocument[];
  /** Documents already on file that the paper told us something new about. */
  updated: ImportedDocument[];
  /** Documents already on file, identical. Named as well as counted: "nothing happened" with no
   *  list is indistinguishable from "nothing worked". */
  unchanged: ImportedDocument[];
  /** Every document that would not read, with the check that failed. Never swallowed. */
  refused: { invoiceNumber: string | null; error: string }[];
}

/** The four empty lists every refusal still has to carry, so a caller never has to guard them. */
const empty = (): Pick<SupplierImportResult, "landed" | "updated" | "unchanged" | "refused"> => ({
  landed: [],
  updated: [],
  unchanged: [],
  refused: [],
});

const said = (invoice: CedInvoice, sourceFile: string | null): ImportedDocument => ({
  invoiceNumber: invoice.invoiceNumber,
  kind: invoice.kind,
  total: money(invoice.total),
  jobNameRaw: invoice.jobNameRaw,
  sourceFile,
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "A, B and C" - a list read the way a person says it out loud. */
function sayList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A PDF, whatever its name says. The magic number is checked as well as the extension because he
 *  renames files ("85 Whit.pdf") and because a file picker will hand over whatever he picked. */
const looksLikePdf = (name: string, text: string): boolean =>
  /\.pdf$/i.test(String(name ?? "").trim()) || String(text ?? "").slice(0, 8).includes("%PDF-");

/**
 * The org this staffer belongs to, or the sentence to refuse with. A profile with no org_id cannot
 * write any of 0273's tables (org_id is not null, and RLS checks it), and "nothing happened" with
 * no reason given is the silence this app is not allowed to make.
 */
function orgOf(ctx: { orgId: string | null }): { orgId: string } | { error: string } {
  if (!ctx.orgId) {
    return {
      error:
        "Your sign-in isn't attached to a company yet, so there is nowhere to file these. Ask an owner to check your account.",
    };
  }
  return { orgId: ctx.orgId };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE IMPORT
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SupplierImportInput {
  /** Text pasted straight out of a PDF viewer. One document or forty; both work. */
  text?: string | null;
  /** Files whose text has already been read. `text` is the FILE'S TEXT, not its bytes. */
  files?: { name: string; text: string }[] | null;
}

export async function importCedInvoices(input: SupplierImportInput): Promise<SupplierImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error, ...empty() };
  const org = orgOf(ctx);
  if ("error" in org) return { ok: false, error: org.error, ...empty() };
  const supabase = ctx.supabase;

  // ── WHAT WE WERE GIVEN ─────────────────────────────────────────────────────────────────────
  const sources: { name: string | null; text: string }[] = [];
  const refused: SupplierImportResult["refused"] = [];

  const pasted = String(input?.text ?? "").trim();
  if (pasted) sources.push({ name: null, text: pasted });

  for (const file of input?.files ?? []) {
    const name = String(file?.name ?? "").trim() || "a file with no name";
    const text = String(file?.text ?? "");
    if (looksLikePdf(name, text)) {
      // NOT A DEAD END: it names the file and it names the way forward. Feeding a PDF's bytes to
      // the parser would come back "no CED invoice number found", which is true of the bytes and
      // a lie about the document.
      refused.push({
        invoiceNumber: null,
        error: `${name} is a PDF, and this reads text. Open it, select all, and paste it into the box instead.`,
      });
      continue;
    }
    if (!text.trim()) {
      refused.push({ invoiceNumber: null, error: `${name} had no text in it.` });
      continue;
    }
    sources.push({ name, text });
  }

  if (!sources.length && !refused.length) {
    return {
      ok: false,
      error: "Paste the text of a CED invoice first, or pick the files you downloaded from the portal.",
      ...empty(),
    };
  }

  // ── READ THEM ──────────────────────────────────────────────────────────────────────────────
  // One downloaded PDF is routinely several invoices - his 07-11 file holds four - so every source
  // is read for ALL the documents in it.
  const parsed = new Map<string, { invoice: CedInvoice; sourceFile: string | null }>();
  for (const source of sources) {
    const results = parseCedDocuments(source.text);
    if (!results.length) {
      refused.push({
        invoiceNumber: null,
        error: `${source.name ?? "That text"} has no CED invoice number in it, so there was nothing to read.`,
      });
      continue;
    }
    for (const result of results) {
      if (!result.ok) {
        refused.push({ invoiceNumber: result.invoiceNumber, error: result.error });
        continue;
      }
      const already = parsed.get(result.invoice.invoiceNumber);
      if (already) {
        // THE SAME DOCUMENT IN TWO FILES IS NORMAL and is not worth a word - he re-downloads
        // overlapping months. The same NUMBER carrying two different totals is not normal, and
        // silently keeping one of them would be picking which figure he believes for him.
        if (cents(already.invoice.total) !== cents(result.invoice.total)) {
          refused.push({
            invoiceNumber: result.invoice.invoiceNumber,
            error: `${result.invoice.invoiceNumber}: this import holds it twice with two different totals, ${sayMoney(money(already.invoice.total))} and ${sayMoney(money(result.invoice.total))}. Nothing was written for it.`,
          });
          parsed.delete(result.invoice.invoiceNumber);
        }
        continue;
      }
      parsed.set(result.invoice.invoiceNumber, { invoice: result.invoice, sourceFile: source.name });
    }
  }

  if (!parsed.size) {
    return {
      ok: false,
      error: refused.length
        ? `Nothing could be read. ${sayList(refused.map((r) => r.error))}`
        : "Nothing in that looked like a CED invoice.",
      ...empty(),
      refused,
    };
  }

  const numbers = [...parsed.keys()];

  // ── WHICH SUPPLIER ACCOUNT THESE BELONG TO ────────────────────────────────────────────────
  // Matched on the ACCOUNT NUMBER printed on the invoice (TR-34426), falling back to the branch
  // code in the invoice number (8802-1103832). Both are identifiers the supplier printed, not
  // guesses about a spelling - the fuzzy matching in supplier-identity.ts is for receipt text,
  // and a fuzzy match here would file somebody else's money onto his account.
  const { data: accountRows } = await supabase
    .from("supplier_accounts")
    .select("id, name, account_number, branch_code")
    .eq("org_id", org.orgId)
    .limit(500);
  const byAccountNumber = new Map<string, { id: string; name: string }>();
  const byBranch = new Map<string, { id: string; name: string }>();
  for (const a of (accountRows ?? []) as { id: string; name: string; account_number: string | null; branch_code: string | null }[]) {
    const key = String(a.account_number ?? "").trim().toLowerCase();
    if (key) byAccountNumber.set(key, { id: String(a.id), name: String(a.name ?? "") });
    const branch = String(a.branch_code ?? "").trim().toLowerCase();
    if (branch && !byBranch.has(branch)) byBranch.set(branch, { id: String(a.id), name: String(a.name ?? "") });
  }
  const accountFor = (invoice: CedInvoice): { id: string; name: string } | null => {
    const number = String(invoice.accountNumber ?? "").trim().toLowerCase();
    if (number && byAccountNumber.has(number)) return byAccountNumber.get(number) ?? null;
    const branch = invoice.invoiceNumber.split("-")[0]?.trim().toLowerCase() ?? "";
    if (branch && byBranch.has(branch)) return byBranch.get(branch) ?? null;
    return null;
  };

  // ── WHAT IS ALREADY ON FILE ────────────────────────────────────────────────────────────────
  type ExistingRow = {
    id: string;
    invoice_number: string;
    kind: string | null;
    invoice_date: string | null;
    job_name_raw: string | null;
    job_id: string | null;
    supplier_account_id: string | null;
    merchandise: number | null;
    tax: number | null;
    shipping: number | null;
    total: number | null;
    discount_amount: number | null;
    discount_by: string | null;
    open_balance: number | null;
    closed: boolean | null;
    source_file: string | null;
  };
  const { data: existingRows, error: readErr } = await supabase
    .from("supplier_invoices")
    .select(
      "id, invoice_number, kind, invoice_date, job_name_raw, job_id, supplier_account_id, merchandise, tax, shipping, total, discount_amount, discount_by, open_balance, closed, source_file",
    )
    .eq("org_id", org.orgId)
    .in("invoice_number", numbers)
    .limit(2000);
  if (readErr) {
    return {
      ok: false,
      error: `Couldn't check what's already on file, so nothing was imported. ${dbError(readErr)}`,
      ...empty(),
      refused,
    };
  }
  const existing = new Map<string, ExistingRow>();
  for (const row of (existingRows ?? []) as ExistingRow[]) existing.set(String(row.invoice_number), row);

  // Which of those already carry their line items. A document is given lines ONCE.
  const existingIds = [...existing.values()].map((r) => String(r.id));
  const hasLines = new Set<string>();
  if (existingIds.length) {
    const { data: lineRows } = await supabase
      .from("supplier_invoice_lines")
      .select("supplier_invoice_id")
      .eq("org_id", org.orgId)
      .in("supplier_invoice_id", existingIds)
      .limit(5000);
    for (const l of (lineRows ?? []) as { supplier_invoice_id: string }[]) hasLines.add(String(l.supplier_invoice_id));
  }

  // ── WRITE ──────────────────────────────────────────────────────────────────────────────────
  const landed: ImportedDocument[] = [];
  const updated: ImportedDocument[] = [];
  const unchanged: ImportedDocument[] = [];
  /** supplier_invoice_id → the lines to write under it, once we know its id. */
  const linesToWrite: { invoiceId: string; invoice: CedInvoice }[] = [];

  // The new ones go in as ONE insert. Forty-seven separate round trips from a phone on a job site
  // is the latency class audit v921 was about, and a partial failure halfway down that list would
  // leave him with a ledger nobody could reason about.
  const fresh = [...parsed.values()].filter((p) => !existing.has(p.invoice.invoiceNumber));
  if (fresh.length) {
    const rows = fresh.map(({ invoice, sourceFile }) => ({
      org_id: org.orgId,
      supplier_account_id: accountFor(invoice)?.id ?? null,
      invoice_number: invoice.invoiceNumber,
      kind: invoice.kind,
      invoice_date: invoice.invoiceDate,
      job_name_raw: invoice.jobNameRaw,
      merchandise: invoice.merchandise,
      tax: invoice.tax,
      shipping: invoice.shipping,
      total: money(invoice.total),
      discount_amount: invoice.discountAmount,
      discount_by: invoice.discountBy,
      // WHAT THE SUPPLIER SAYS IS STILL OWED. A document CED has stamped paid comes in settled; a
      // document it has not comes in open for its full total. The lean is deliberate and it is the
      // same lean supplier-balance.ts takes: a figure that might be too big gets argued with on
      // screen, and a figure that is quietly too small gets trusted.
      closed: invoice.paidInFull,
      open_balance: invoice.paidInFull ? 0 : money(invoice.total),
      source_file: sourceFile,
      created_by: ctx.userId,
    }));
    const { data: inserted, error: insErr } = await supabase
      .from("supplier_invoices")
      .insert(rows)
      .select("id, invoice_number");
    if (insErr) {
      // TWO IMPORTS AT ONCE. Both read "not on file", both insert, and the unique index on
      // (org_id, invoice_number) refuses the second batch whole - which is the index doing exactly
      // its job. Saying "try it again" is the truth: the second run finds them already there and
      // writes nothing, because that is what this importer does with a document it already holds.
      const duplicate = /duplicate key value/i.test(String((insErr as { message?: string }).message ?? ""));
      return {
        ok: false,
        error: duplicate
          ? "Nothing was imported: some of these are already on file. Import it again and they will be read as already here."
          : `Nothing was imported. ${dbError(insErr)}`,
        ...empty(),
        refused,
      };
    }
    // SILENT-WRITE LAW. RLS makes a refused insert a zero-row 204, which reads exactly like
    // success; anything that did not come back did not land, and is said so by name.
    const back = new Map(((inserted ?? []) as { id: string; invoice_number: string }[]).map((r) => [String(r.invoice_number), String(r.id)]));
    if (back.size !== fresh.length) {
      reportError("bills:importCedInvoices", new Error("supplier invoice insert wrote fewer rows than asked"), {
        asked: fresh.length,
        wrote: back.size,
      });
    }
    for (const { invoice, sourceFile } of fresh) {
      const id = back.get(invoice.invoiceNumber);
      if (!id) {
        refused.push({
          invoiceNumber: invoice.invoiceNumber,
          error: `${invoice.invoiceNumber} didn't save, so it is not on file. Try the import again.`,
        });
        continue;
      }
      landed.push(said(invoice, sourceFile));
      if (invoice.lines.length) linesToWrite.push({ invoiceId: id, invoice });
    }
  }

  // The ones already on file: written only where the paper says something the row does not.
  for (const { invoice, sourceFile } of parsed.values()) {
    const row = existing.get(invoice.invoiceNumber);
    if (!row) continue;

    const patch: Record<string, unknown> = {};
    const setIfDifferent = (column: string, value: unknown, current: unknown) => {
      if (value === null || value === undefined) return; // the paper is silent; the row keeps what it has
      if (String(current ?? "") !== String(value)) patch[column] = value;
    };
    setIfDifferent("kind", invoice.kind, row.kind);
    setIfDifferent("invoice_date", invoice.invoiceDate, row.invoice_date);
    setIfDifferent("job_name_raw", invoice.jobNameRaw, row.job_name_raw);
    setIfDifferent("discount_by", invoice.discountBy, row.discount_by);
    setIfDifferent("source_file", sourceFile, row.source_file);
    for (const [column, value, current] of [
      ["merchandise", invoice.merchandise, row.merchandise],
      ["tax", invoice.tax, row.tax],
      ["shipping", invoice.shipping, row.shipping],
      ["total", money(invoice.total), row.total],
      ["discount_amount", invoice.discountAmount, row.discount_amount],
    ] as [string, number | null, number | null][]) {
      if (value === null) continue;
      if (cents(current) !== cents(value) || current === null) patch[column] = value;
    }
    // An account the row does not have yet. Never MOVED: a document filed onto an account by hand
    // stays there.
    if (!row.supplier_account_id) {
      const account = accountFor(invoice);
      if (account) patch.supplier_account_id = account.id;
    }
    // ONE-WAY, AND THIS IS THE RULE WORTH READING TWICE. The stamp on the paper can close a
    // document. The absence of a stamp says nothing at all - a PDF downloaded in June has no
    // opinion about a cheque written in September - so it never re-opens one. Re-opening nine
    // settled bills on a re-import would put $5,583.87 back on a balance he had just cleared.
    if (invoice.paidInFull && row.closed !== true) {
      patch.closed = true;
      patch.open_balance = 0;
    } else if (row.closed !== true && (row.open_balance === null || row.open_balance === undefined)) {
      patch.open_balance = money(invoice.total);
    }
    // `job_id` IS ABSENT FROM THIS PATCH ON PURPOSE. See the header: a person resolved it, and a
    // re-read of the same paper must never undo that.

    if (!Object.keys(patch).length) {
      unchanged.push(said(invoice, sourceFile));
      if (!hasLines.has(String(row.id)) && invoice.lines.length) linesToWrite.push({ invoiceId: String(row.id), invoice });
      continue;
    }

    let write = supabase.from("supplier_invoices").update(patch).eq("id", row.id);
    write = write.eq("org_id", org.orgId); // a rule at one read path is a convention, not a boundary (0173)
    const { data: wrote, error: updErr } = await write.select("id");
    if (updErr) {
      refused.push({ invoiceNumber: invoice.invoiceNumber, error: `${invoice.invoiceNumber} didn't update. ${dbError(updErr)}` });
      continue;
    }
    if (!wrote?.length) {
      reportError("bills:importCedInvoices", new Error("supplier invoice update wrote no rows"), {
        invoiceNumber: invoice.invoiceNumber,
      });
      refused.push({
        invoiceNumber: invoice.invoiceNumber,
        error: `${invoice.invoiceNumber} didn't update, so it still says what it said before. Reload and try again.`,
      });
      continue;
    }
    updated.push(said(invoice, sourceFile));
    if (!hasLines.has(String(row.id)) && invoice.lines.length) linesToWrite.push({ invoiceId: String(row.id), invoice });
  }

  // ── THE LINE ITEMS, AT HIS REAL CONTRACT PRICES ────────────────────────────────────────────
  // Worth more than the reconciliation, and written ONCE per document: these are the supplier's
  // own file, with the product code, the quantity shipped, the price and the unit that price is
  // per. `per_unit` is the column that stops 55 feet of 6/3 at $4,321.03 per M being read as a
  // four thousand dollar reel.
  const lineRows = linesToWrite.flatMap(({ invoiceId, invoice }) =>
    invoice.lines.map((line) => ({
      org_id: org.orgId,
      supplier_invoice_id: invoiceId,
      product_code: line.productCode,
      part_number: line.partNumber,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      per_unit: line.perUnit,
      extension: line.extension,
      sort_order: line.sortOrder,
    })),
  );
  let linesWritten = 0;
  let linesRefused = false;
  if (lineRows.length) {
    const { data: insertedLines, error: lineErr } = await supabase
      .from("supplier_invoice_lines")
      .insert(lineRows)
      .select("id");
    if (lineErr || !insertedLines?.length) {
      // THE DOCUMENTS ARE IN AND THEIR TOTALS ARE RIGHT. Losing the lines costs him the detail,
      // not the money, so this is reported rather than rolled back - and it is reported, not
      // swallowed, because a document showing a total with no lines under it would otherwise be
      // a mystery with no cause on screen.
      linesRefused = true;
      reportError("bills:importCedInvoices", lineErr ?? new Error("supplier invoice lines insert wrote no rows"), {
        rows: lineRows.length,
      });
    } else {
      linesWritten = insertedLines.length;
      // SILENT-WRITE LAW, the partial case. A row RLS refused comes back as no row rather than an
      // error, so a count that does not match what we asked for is the only signal there is.
      if (linesWritten !== lineRows.length) {
        linesRefused = true;
        reportError("bills:importCedInvoices", new Error("supplier invoice lines insert wrote fewer rows than asked"), {
          asked: lineRows.length,
          wrote: linesWritten,
        });
      }
    }
  }

  revalidatePath("/bills");

  // ── WHAT HAPPENED, IN THE SERVER'S OWN WORDS ───────────────────────────────────────────────
  const parts: string[] = [];
  if (landed.length) parts.push(plural(landed.length, "document is new", "documents are new"));
  if (updated.length) parts.push(plural(updated.length, "was already here and changed", "were already here and changed"));
  if (unchanged.length) parts.push(plural(unchanged.length, "was already here, unchanged", "were already here, unchanged"));
  const landedTotal = money(landed.reduce((sum, d) => sum + d.total, 0));
  const detail: string[] = [];
  if (landed.length) detail.push(`The new ones come to ${sayMoney(landedTotal)}.`);
  if (linesWritten) detail.push(`${plural(linesWritten, "line item", "line items")} came in at their contract prices.`);
  if (linesRefused) {
    detail.push(
      "Some line items didn't save, so those documents show a total with less under it than the paper has. The totals themselves are right.",
    );
  }
  const unfiled = landed.filter((d) => {
    const p = parsed.get(d.invoiceNumber);
    return p ? !accountFor(p.invoice) : false;
  });
  if (unfiled.length) {
    detail.push(
      `${plural(unfiled.length, "of them is", "of them are")} not on a supplier account yet, because no account here has the account number printed on them. Make the account and they will join it.`,
    );
  }
  if (refused.length) {
    detail.push(`${plural(refused.length, "document was refused", "documents were refused")}: ${sayList(refused.map((r) => r.error))}`);
  }

  return {
    ok: true,
    message: `Read ${plural(parsed.size, "document", "documents")}. ${parts.length ? `${sayList(parts)}.` : ""} ${detail.join(" ")}`.replace(/\s+/g, " ").trim(),
    landed,
    updated,
    unchanged,
    refused,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DOOR ON THE PAGE
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How much of the summary is allowed into the URL. Long enough for every refusal on a normal
 *  night, short enough that no browser truncates it into half a sentence. */
const SUMMARY_LIMIT = 900;

/**
 * THE IMPORT BOX ON /bills, POSTED THE WAY THE REST OF THIS APP POSTS A SERVER FORM.
 *
 * The bills page is a server component and the supplier card is somebody else's file, so this is a
 * plain <form action={...}>: it works with no JavaScript, it works on the first paint, and it
 * works on a phone with one thumb. The result comes back the way settings/page.tsx already brings
 * a Stripe or QuickBooks result back - a redirect carrying the sentence, rendered as a banner -
 * because NOTHING SILENT applies just as hard to an import that read nothing as to one that read
 * forty-seven.
 */
export async function importCedInvoicesFromForm(formData: FormData): Promise<void> {
  const text = String(formData.get("text") ?? "");

  // A file input posts File objects. Their TEXT is read here; a PDF is refused by name rather than
  // having its bytes fed to a parser that would then report "no invoice number found", which is
  // true of the bytes and a lie about the document.
  const files: { name: string; text: string }[] = [];
  for (const entry of formData.getAll("files")) {
    if (typeof entry === "string") continue;
    const file = entry as File;
    if (!file || !file.size) continue;
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      files.push({ name: file.name, text: "" }); // looksLikePdf refuses it, by name
      continue;
    }
    try {
      files.push({ name: file.name, text: await file.text() });
    } catch {
      files.push({ name: file.name, text: "" });
    }
  }

  const result = await importCedInvoices({ text, files });
  const summary = (result.ok ? result.message ?? "Imported." : result.error ?? "Nothing was imported.").slice(0, SUMMARY_LIMIT);
  // redirect() throws to unwind, so it is the last thing that happens and it is never inside a try.
  redirect(`/bills?import=${encodeURIComponent(summary)}&importOk=${result.ok ? "1" : "0"}#ced-import`);
}
