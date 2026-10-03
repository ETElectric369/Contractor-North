"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { parseCSV } from "@/lib/csv";
import { isSha256 } from "@/lib/content-hash";
import { requireStaff } from "@/lib/staff-guard";
import { reportError } from "@/lib/observe";
import { proposalOf, type PaperProposal } from "@/lib/paperwork";
import {
  OPEN_LIST_FIELDS,
  capTable,
  findHeaderRow,
  openListFromText,
  listReadFacts,
  pdfPagesSaid,
  pdfReadSaid,
  readHeaderRow,
  readOpenListTable,
  rememberColumns,
  type ReadFacts,
  type OpenListColumns,
  type StoredOpenList,
} from "@/lib/supplier-open-list";
import { downloadReadFacts, looksLikeBankTable, mayBeBankTable, noLinesSaid, notABankDownloadSaid, redactDigits, redactWordCells, unreadBankTable } from "@/lib/bank-download";
import { OWNER_SORTS_BANK, viewerSortsBank } from "@/lib/bank-viewer";
import { bankLine, bankTableTooLong, capBankTable, createBankPaper, readBankDownload } from "./bank-core";
import { applyOpenListCore, createOpenListPaper, loadAccounts, loadPapers, openListLine, orgToday, resolveAccount } from "./open-list-core";
import { fingerprintSeen } from "@/app/(app)/organize/paperwork-actions";
import { isMissingColumnError } from "@/app/(app)/organize/paperwork-core";

/**
 * A SUPPLIER'S OPEN LIST: THE DOORS (Erik, 2026-09-26: "we cant get too complicated for the user
 * so maybe we can fold all of these tools into the statement upload"). There is no button for this.
 * A list arrives through the doors paper already arrives through (Snap Or Note, Organize, the
 * paste box, a statement PDF) and waits under Needs You on Bills as ONE card. These are the card's buttons.
 */

type Result = { ok: boolean; error?: string; message?: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A LIST FILE (CSV, XLSX, a text table) the browser already read into rows, or pasted text. It
 * becomes a tray row and nothing else: no paper is changed until Apply.
 */
export async function addOpenList(input: {
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
   *
   * `checked`: what arithmetic already did to a read that needed it — a scanned statement is read by
   * a model and held against the statement's own printed totals before it ever gets here
   * (statement-scan.ts), so the report says what that check found instead of asking for it again.
   */
  pdf?: { pages: number; rows: number; checked?: string | null } | null;
  /** "bank": the caller promised a bank download, so anything else — a supplier's list included — is
   *  refused in plain words. NO DOOR PASSES IT TODAY: Reconcile's drop line takes either statement on
   *  purpose (Erik: "i want to upload my bank statement and supplier statement"), and this file tells
   *  them apart by what is in them. It is NOT what keeps a bank's file out of the supplier class:
   *  `unreadBankTable` does that below, for every door, whether or not anyone promised anything. */
  expect?: "bank" | null;
}): Promise<Result & { id?: string; already?: string; line?: string }> {
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
  // A CHECK IS ONLY EVER REPORTED AS A SENTENCE SOMEBODY WROTE, never as a flag this file interprets:
  // the one place that knows what was checked is the one place that says so (statement-scan.ts).
  const checked = typeof input?.pdf?.checked === "string" && input.pdf.checked.trim() ? input.pdf.checked.trim().slice(0, 600) : undefined;
  const pdf = pages > 0 && rawRows >= 0 ? { pages, rows: rawRows, ...(checked ? { checked } : {}) } : null;
  /** THE READ REPORT, where every door reaches it, for whichever card this becomes. */
  const withReport = (line: string, facts: ReadFacts) => (pdf ? `${line} ${pdfReadSaid(pdf, facts, today)}` : line);
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
      const read = readBankDownload(bankTable, name);
      if (!read) return { ok: false, error: `${name} reads like a bank download, but none of its lines did.` };
      // THE READ REPORT RIDES ON THE DOWNLOAD when something had to check the read: a scanned statement
      // is a model's transcription held against the paper's own printed figures, and the sentence that
      // says so (or says nothing could) belongs on the card where Apply is, not only in the line under
      // the button he dropped it at. A download carries none — it is arithmetic from end to end.
      const download = { ...read, name: redactDigits(name), ...(checked ? { readSaid: checked } : {}) };
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
      return { ok: true, id: placed.id, line: withReport(bankLine(download), downloadReadFacts(download)) };
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

async function waitingList(supabase: any, orgId: string, id: string) {
  const { data: item } = await supabase.from("organized_items").select("*").eq("id", id).eq("org_id", orgId).maybeSingle();
  if (!item) return { error: "That list isn't here any more." } as const;
  if (item.status !== "needs_review") return { error: "This list was already applied. Undo it first to change it." } as const;
  const p = proposalOf(item);
  const stored = p.openList as StoredOpenList | undefined;
  if (!stored) return { error: "This paper isn't a supplier's list." } as const;
  return { item, p, stored } as const;
}

async function saveStored(supabase: any, orgId: string, id: string, p: PaperProposal, stored: StoredOpenList): Promise<Result> {
  const { data: back, error } = await supabase
    .from("organized_items")
    .update({ proposal: { ...p, openList: stored } satisfies PaperProposal })
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("status", "needs_review")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!back?.length) return { ok: false, error: "Nothing was saved. The list was applied or removed from another screen." };
  revalidatePath("/bills");
  revalidatePath("/organize");
  return { ok: true };
}

/**
 * THE COLUMN PICKER'S ANSWER. The list is read again with the person's columns, and the choice is
 * remembered on the supplier's account (0351) so the next list from them just reads.
 */
export async function pickOpenListColumns(id: string, picked: OpenListColumns): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const got = await waitingList(ctx.supabase, ctx.orgId, id);
  if ("error" in got) return { ok: false, error: got.error };
  const needs = got.stored.needs;
  if (!needs) return { ok: false, error: "This list's columns are already known." };
  const width = Math.max(0, ...needs.raw.map((r) => r.length));
  const columns: OpenListColumns = {};
  for (const f of OPEN_LIST_FIELDS) {
    const at = (picked as Record<string, unknown>)?.[f];
    if (typeof at === "number" && Number.isInteger(at) && at >= 0 && at < width) columns[f] = at;
  }
  if (columns.reference === undefined) return { ok: false, error: "Pick the column that holds the paper numbers." };
  if (columns.openBalance === undefined && columns.amount === undefined) return { ok: false, error: "Pick the column that holds what is still owed." };
  const read = readOpenListTable({ table: needs.raw, from: needs.from, name: needs.name, listDate: needs.listDate, listDateFrom: needs.listDateFrom, columns, headerRow: needs.headerRow });
  if (!read.ok) return { ok: false, error: "error" in read ? read.error : "Those columns still don't read as a list. Check the paper number and amount columns." };
  const list = { ...read.list, columnsBy: "person" as const, accountId: needs.accountId ?? null, accountFrom: needs.accountFrom ?? null };
  const saved = await saveStored(ctx.supabase, ctx.orgId, id, got.p, { list, needs: null });
  if (!saved.ok) return saved;

  // THE READ REPORT THIS PATH OWED HIM. A PDF whose columns came here said only how many pages came off
  // it; now that a reader has read them, it says the rest — how many papers, over what dates, adding to
  // what, and the figure on his own paper to hold that against. The Reconcile page promises this line
  // for every PDF, and this was the one path that never said it.
  const report = needs.pdf ? ` ${pdfReadSaid(needs.pdf, listReadFacts(list), await orgToday(ctx.supabase, ctx.orgId))}` : "";
  // REMEMBER IT on the account the list belongs to, when that is known without guessing.
  const [accounts, loaded] = await Promise.all([loadAccounts(ctx.supabase, ctx.orgId), loadPapers(ctx.supabase, ctx.orgId)]);
  const who = resolveAccount(list, null, accounts, loaded.papers);
  if (!who) return { ok: true, message: `Read ${list.rows.length} papers.${report} Pick whose list it is, and these columns will be remembered for them.` };
  return { ok: true, message: `Read ${list.rows.length} papers.${report} ${await remember(ctx.supabase, ctx.orgId, who.id, rememberColumns(columns, needs.header, width))}` };
}

async function remember(supabase: any, orgId: string, accountId: string, rem: ReturnType<typeof rememberColumns>): Promise<string> {
  const { data, error } = await supabase.from("supplier_accounts").update({ open_list_columns: rem }).eq("id", accountId).eq("org_id", orgId).select("id, name");
  if (error) {
    if (!isMissingColumnError(error)) reportError("bills:openList.remember", error, { accountId });
    return isMissingColumnError(error)
      ? "These columns aren't remembered yet (that needs one database update), so the next list from them may ask again."
      : "These columns couldn't be remembered, so the next list from them may ask again.";
  }
  const account = ((data ?? []) as { name?: string }[])[0];
  return account ? `These columns are remembered for ${account.name}.` : "These columns couldn't be remembered, so the next list may ask again.";
}

/** WHOSE LIST IS THIS: a person's answer when nothing the list prints names the account. */
export async function pickOpenListAccount(id: string, accountId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const got = await waitingList(ctx.supabase, ctx.orgId, id);
  if ("error" in got) return { ok: false, error: got.error };
  const { data: account } = await ctx.supabase.from("supplier_accounts").select("id, name").eq("id", accountId).eq("org_id", ctx.orgId).maybeSingle();
  if (!account) return { ok: false, error: "Pick one of your supplier accounts." };
  const s = got.stored;
  const next: StoredOpenList = s.list
    ? { list: { ...s.list, accountId: String(account.id), accountFrom: "person" }, needs: null }
    : { list: null, needs: s.needs ? { ...s.needs, accountId: String(account.id), accountFrom: "person" } : null };
  const saved = await saveStored(ctx.supabase, ctx.orgId, id, got.p, next);
  if (!saved.ok) return saved;
  // A list read with a person's columns, now that its account is known: remember them there.
  if (s.list && s.list.columnsBy === "person" && s.list.header.length) {
    const width = s.list.header.length;
    const note = await remember(ctx.supabase, ctx.orgId, String(account.id), rememberColumns(s.list.columns, s.list.header, width));
    return { ok: true, message: `This is ${account.name}'s list. ${note}` };
  }
  return { ok: true, message: `This is ${account.name}'s list.` };
}

/** APPLY, once, as the card showed it. `wholeList`: the person said this is the whole open list. */
export async function applyOpenList(id: string, opts: { fingerprint: string; wholeList?: boolean }): Promise<Result & { stale?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const res = await applyOpenListCore(ctx.supabase, { orgId: ctx.orgId, userId: ctx.userId }, id, {
    fingerprint: String(opts?.fingerprint ?? ""),
    wholeList: opts?.wholeList === true,
  });
  revalidatePath("/bills");
  revalidatePath("/organize");
  revalidatePath("/planner"); // My Day's supplier cards and Pay By line read these same papers
  return res;
}
