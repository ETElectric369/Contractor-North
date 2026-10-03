import "server-only";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { parseCSV } from "@/lib/csv";
import { isSha256 } from "@/lib/content-hash";
import { requireStaff } from "@/lib/staff-guard";
import {
  capTable,
  findHeaderRow,
  listReadFacts,
  openListFromText,
  pdfPagesSaid,
  pdfReadSaid,
  readHeaderRow,
  readOpenListTable,
  type ReadFacts,
  type StoredOpenList,
} from "@/lib/supplier-open-list";
import { downloadReadFacts, looksLikeBankTable, mayBeBankTable, noLinesSaid, notABankDownloadSaid, redactDigits, redactWordCells, unreadBankTable } from "@/lib/bank-download";
import { OWNER_SORTS_BANK, viewerSortsBank } from "@/lib/bank-viewer";
// THE STATEMENT'S OWN PRINTED FIGURES, as the one verification takes them. Only server code hands
// them over, and only ever as FIGURES: the sentence about them is composed where they are checked.
import { type ScanControls } from "@/lib/statement-verify";
import { bankLine, bankTableTooLong, capBankTable, createBankPaper, readBankDownload } from "./bank-core";
import { createOpenListPaper, openListLine, orgToday } from "./open-list-core";
import { fingerprintSeen } from "@/app/(app)/organize/paperwork-actions";

/**
 * BRINGING A LIST OR A DOWNLOAD IN, ON THE SERVER AND NOT AS A DOOR (2026-10-02).
 *
 * This is the body of `addOpenList`, moved out of open-list-actions.ts for ONE reason: nothing a
 * browser sends may become the sentence that says what arithmetic checked a read.
 *
 * A "use server" EXPORT IS A PUBLIC POST ENDPOINT (report-client-error.ts says so in as many words;
 * schedule/actions.ts keeps a function unexported for exactly this reason). While the read report's
 * "checked" sentence was a field of the exported action's own argument, any signed-in staffer who may
 * sort the bank could hand it a table of their own making along with "Held against the statement's own
 * printed figures: the money going out, the money coming in and the balance from end to end agree to
 * the cent" — and the bank card prints that beside Apply as the product's own word on the read. The
 * card shows no totals to hold it against, Apply never reads it, and nothing downstream could tell.
 * That is a false assurance about money, on the one path whose whole contract is that it NEVER CLAIMS
 * WHAT IT DID NOT CHECK (statement-verify.ts).
 *
 * NOW NO CALLER HANDS A SENTENCE AT ALL. The second argument carries only FACTS a caller is entitled to
 * know — how it read the file, and the control figures it copied off the paper — and the one
 * verification composes the sentence itself, from the lines that landed (bank-download.ts
 * `readBankTable`). A caller cannot assert anything; it can only say what it read and be judged.
 *
 * Not a "use server" module: `import "server-only"` is what keeps it off a client bundle.
 */

type Result = { ok: boolean; error?: string; message?: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** What any door may hand in. There is no `checked` on it, on purpose: see the note above. */
export type AddOpenListInput = {
  name: string;
  sha256?: string | null;
  table?: string[][] | null;
  text?: string | null;
  /** The day the file was saved (the browser's lastModified), or null for today. */
  listDate?: string | null;
  source?: "bills_drop" | "organize";
  /**
   * THE PDF THESE ROWS WERE LIFTED OFF: its pages, and how many rows the table had before any of them
   * were read. A statement that came in as a PDF was PARSED, not downloaded, so the card's line says
   * what came off the paper and he holds it against the total his own statement prints (pdfReadSaid).
   */
  pdf?: { pages: number; rows: number } | null;
  /** "bank": the caller promised a bank download, so anything else — a supplier's list included — is
   *  refused in plain words. NO DOOR PASSES IT TODAY: Reconcile's drop line takes either statement on
   *  purpose (Erik: "i want to upload my bank statement and supplier statement"), and this file tells
   *  them apart by what is in them. It is NOT what keeps a bank's file out of the supplier class:
   *  `unreadBankTable` does that below, for every door, whether or not anyone promised anything. */
  expect?: "bank" | null;
};

/**
 * WHAT ONLY SERVER CODE MAY SAY ABOUT A READ. Facts, never an assurance: the sentence is composed by
 * the one verification from the lines that actually landed.
 */
export type AddOpenListRead = {
  /** A model looked at the pages (statement-scan-actions.ts), so the report says so in plain words and
   *  a read its own arithmetic disagrees with never became a card at all. */
  scanned?: boolean;
  /** The statement's own printed control figures, copied off the paper by whoever read it. */
  controls?: ScanControls | null;
};

/**
 * A LIST FILE (CSV, XLSX, a text table) the browser already read into rows, or pasted text. It
 * becomes a tray row and nothing else: no paper is changed until Apply.
 */
export async function addOpenListCore(
  input: AddOpenListInput,
  trusted?: AddOpenListRead | null,
): Promise<Result & { id?: string; already?: string; line?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet, so there is nowhere to put this." };
  const name = String(input?.name ?? "").trim().slice(0, 200) || "Supplier list";
  const today = await orgToday(ctx.supabase, ctx.orgId);
  // A date from the future is a clock that's wrong, not a list from tomorrow.
  const given = YMD.test(String(input?.listDate ?? "")) && String(input.listDate) <= today ? String(input.listDate) : null;
  const listDate = given ?? today;
  const listDateFrom = given ? ("file" as const) : ("today" as const);
  const pages = Math.trunc(Number(input?.pdf?.pages));
  const rawRows = Math.trunc(Number(input?.pdf?.rows));
  /**
   * HOW THIS FILE WAS READ, and it is this file that decides, from what it was handed rather than from
   * anybody's word for it: a model looked at it, a PDF's own text gave it up, or it is the file's own
   * rows. The one verification names it in the read report so a person knows how hard to look — one
   * short clause, after the fact, with nothing to decide (NO MERRY-GO-ROUND).
   */
  const bankRead = { source: trusted?.scanned ? ("picture" as const) : pages > 0 ? ("page" as const) : ("rows" as const), controls: trusted?.controls ?? null };
  const pdf = pages > 0 && rawRows >= 0 ? { pages, rows: rawRows } : null;
  /** THE READ REPORT, where every door reaches it, for whichever card this becomes. */
  const withReport = (line: string, facts: ReadFacts, checked?: string | null) => {
    // A VERIFIED READ SAYS WHAT THE ARITHMETIC FOUND, in place of asking a person to do it himself.
    // On a PDF it goes INSIDE the one read report (pdfReadSaid), beside the pages and rows it is about;
    // with no PDF there is no such report, so the sentence is the line's own tail. Never both: one
    // summary, which is the whole rule about this sentence.
    const report = pdf ? pdfReadSaid({ ...pdf, ...(checked ? { checked } : {}) }, facts, today) : checked;
    return report ? `${line} ${report}` : line;
  };
  /** A PDF whose columns go to the picker has no reader's figures yet, and the pages are still facts. */
  const withPages = (line: string) => (pdf ? `${line} ${pdfPagesSaid(pdf)}` : line);

  let stored: StoredOpenList | null = null;
  let sha: string | null = isSha256(input?.sha256) ? String(input.sha256) : null;
  // A BANK'S DOWNLOAD comes in by the same doors (Erik, 2026-09-27): recognised by its own header
  // (a day, a description, money in and out), it becomes one bank card instead of a supplier's list.
  if (Array.isArray(input?.table)) {
    const bankTable = capBankTable(input.table);
    const at = findHeaderRow(bankTable);
    const supplierRef = at >= 0 && readHeaderRow(bankTable[at] ?? []).columns.reference !== undefined;
    if (looksLikeBankTable(bankTable, supplierRef)) {
      // THE OWNER'S MONEY (0286, bank-viewer): only whoever sorts the bank may bring a download in.
      // An office viewer the owner turned off is told so in words; the database holds the same line
      // (0365: a bank download in the tray is viewer_sorts_bank()'s only).
      if (!(await viewerSortsBank(ctx.supabase, ctx.userId))) return { ok: false, error: `${name}: ${OWNER_SORTS_BANK}` };
      const tooLong = bankTableTooLong(input.table, name);
      if (tooLong) return { ok: false, error: tooLong };
      // THE FILE'S NAME IS KEPT REDACTED like every line ("Export_000123456789.csv" keeps ••6789):
      // it is the card's title. The reader sees it whole only to take an account's last 4 from it.
      const read = readBankDownload(bankTable, name, bankRead);
      if (!read) return { ok: false, error: `${name} reads like a bank download, but none of its lines did.` };
      // THE READ REPORT RIDES ON THE DOWNLOAD, for every source and not just a scan: the reader itself
      // walked the running balance the file prints and held the lines to whatever figures came with
      // them, and the sentence that says what it found (or says nothing could) belongs on the card where
      // Apply is, not only in the line under the button he dropped it at. `readBankTable` put it there;
      // nothing here composes one, so no door can print an assurance of its own making.
      const download = { ...read, name: redactDigits(name) };
      if (!download.lines.length) return { ok: false, error: noLinesSaid(download, name) };
      if (sha) {
        const seen = await fingerprintSeen(sha);
        if (seen.seen) return { ok: false, already: seen.seen, error: `${name}: ${seen.seen}` };
      }
      const placed = await createBankPaper(ctx.supabase, {
        userId: ctx.userId,
        name: download.name,
        download,
        sha256: sha,
        source: input?.source === "organize" ? "organize" : "bills_drop",
      });
      if ("duplicate" in placed) {
        const again = sha ? await fingerprintSeen(sha) : { seen: null };
        return { ok: false, already: again.seen ?? "Already In.", error: `${name}: ${again.seen ?? "Already In."}` };
      }
      if ("error" in placed) return { ok: false, error: `${name} wasn't added. ${placed.error}` };
      revalidatePath("/bills");
      revalidatePath("/organize");
      revalidatePath("/planner");
      return { ok: true, id: placed.id, line: withReport(bankLine(download), downloadReadFacts(download), download.readSaid) };
    }
    // A BANK'S TABLE THAT DIDN'T READ AS ONE IS REFUSED HERE, AT EVERY DOOR, rather than kept as a
    // supplier's list waiting for its columns. That class of paper is the whole office's to read
    // (0365 holds proposal.openList to is_org_staff(); a bank download it holds to
    // viewer_sorts_bank(), the owner's own switch), and the card prints four of its lines as a
    // sample — so storing the owner's draw and his dentist there hands them to an office hand the
    // owner switched off, and hides it behind a gate that only hides the button. The rule lives in
    // ONE function (unreadBankTable) rather than on the door, because the door cannot tell the two
    // files apart and every door reaches this one.
    //
    // `expect: "bank"` lands on the same sentence: a door that promised a bank download and got
    // something else is asking the same question and gets the same answer.
    if (unreadBankTable(bankTable, at, supplierRef) || input?.expect === "bank") return { ok: false, error: notABankDownloadSaid(name) };
  }
  if (input?.expect === "bank") return { ok: false, error: `${name} doesn't read as a bank download. Download it as CSV, Excel or OFX/QFX and drop that. Nothing was added.` };
  if (Array.isArray(input?.table)) {
    const table = capTable(input.table);
    const read = readOpenListTable({ table, from: "file", name, listDate, listDateFrom });
    if (read.ok) stored = { list: read.list, needs: null };
    else if ("needs" in read) {
      // A BANK'S FILE THAT DIDN'T READ AS ONE waits for its columns with no long number in it.
      // THE PDF'S PAGES RIDE ALONG: once the columns are picked there is no other way back to them, and
      // the read report is owed on this path most of all — it is where the parse is least verified.
      const needs = { ...read.needs, pdf };
      const hasRef = needs.headerRow >= 0 && readHeaderRow(needs.raw[needs.headerRow] ?? []).columns.reference !== undefined;
      stored = mayBeBankTable(needs.raw, needs.headerRow, hasRef)
        ? { list: null, needs: { ...needs, raw: redactWordCells(needs.raw), header: needs.header.map((h) => redactDigits(h)) } }
        : { list: null, needs };
    } else return { ok: false, error: read.error };
  } else if (typeof input?.text === "string" && input.text.trim()) {
    const text = input.text.slice(0, 500_000);
    stored = openListFromText(text, { name, from: "paste", listDate, listDateFrom, parseCsv: parseCSV, strict: false });
    if (!sha) sha = createHash("sha256").update(text).digest("hex");
    if (!stored) return { ok: false, error: `${name} doesn't read as a list of papers. It needs a column of paper numbers and a column of amounts.` };
  } else {
    return { ok: false, error: `${name} had nothing in it to read.` };
  }

  if (sha) {
    const seen = await fingerprintSeen(sha);
    if (seen.seen) return { ok: false, already: seen.seen, error: `${name}: ${seen.seen}` };
  }
  const placed = await createOpenListPaper(ctx.supabase, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    name,
    stored,
    sha256: sha,
    fileUrl: null,
    source: input?.source === "organize" ? "organize" : "bills_drop",
  });
  if ("duplicate" in placed) {
    const again = sha ? await fingerprintSeen(sha) : { seen: null };
    return { ok: false, already: again.seen ?? "Already In.", error: `${name}: ${again.seen ?? "Already In."}` };
  }
  if ("error" in placed) return { ok: false, error: `${name} wasn't added. ${placed.error}` };
  revalidatePath("/bills");
  revalidatePath("/organize");
  return { ok: true, id: placed.id, line: stored.list ? withReport(openListLine(stored), listReadFacts(stored.list)) : withPages(openListLine(stored)) };
}
