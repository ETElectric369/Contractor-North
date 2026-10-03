"use server";

import { requireStaff } from "@/lib/staff-guard";
import { reportError } from "@/lib/observe";
import { getAnthropic } from "@/lib/anthropic";
import { aiSpendExceeded, modelFor, recordAiUsage } from "@/lib/ai-cost";
import { parseAiJson } from "@/lib/ai-json";
import { isSha256 } from "@/lib/content-hash";
import { isPdfBytes } from "@/lib/pdf-text";
import { OWNER_SORTS_BANK, viewerSortsBank } from "@/lib/bank-viewer";
import {
  SCAN_KIND_SYSTEM,
  SCAN_LINES_SYSTEM,
  SCAN_MAX_BYTES,
  SCAN_MAX_TOKENS,
  SCAN_MORE_CALLS,
  checkScanTotals,
  notABankScanSaid,
  readScannedBank,
  scanCheckSaid,
  scanKindFrom,
  scanMoreAsked,
  scanRefusalSaid,
  scanTruncatedSaid,
  type ScanLine,
} from "@/lib/statement-scan";
import { addOpenList } from "./open-list-actions";
import { fingerprintSeen } from "@/app/(app)/organize/paperwork-actions";

/**
 * THE SCANNED STATEMENT READS (2026-10-02).
 *
 * His bank prints a statement whose transaction table is an IMAGE. The text lane (cn-v1049) reads
 * every PDF that carries a table and refuses this one correctly; what is left is a month of his money
 * that only a reader looking at the pages can get. The owner, on why the cost is worth it: "The
 * readers everywhere else seemed to do a pretty great job with my handwriting and super fine print
 * with a shitty picture so the pennies make it worth it exponentially for this part more than
 * anything."
 *
 * A MODEL READ IS A PROPOSAL, NEVER A WRITE (organize/actions.ts, around line 121: an earlier version
 * filed what the model matched "with no person looking at either"). So this action writes NO money and
 * NO bank line. It produces exactly what a CSV of the same statement would produce — the same
 * string[][], through the same `addOpenList`, onto the same bank card, where every line shows its
 * proposed answer and nothing happens until a person presses Apply.
 *
 * AND THE ARITHMETIC JUDGES THE READ. Before any of it is even proposed, the statement's own printed
 * figures are held against the lines, to the cent, in code (statement-scan.ts `checkScanTotals`). A
 * check that disagrees means nothing is added and the refusal names which check and by how much. A
 * paper that prints no totals cannot be checked, and then the card SAYS that nothing checked it —
 * never silence, never a confident empty answer.
 *
 * TWO LOOKS, CHEAP THEN CAREFUL:
 *   1. WHAT IS THIS PAPER (modelFor("classify")). A scan cannot be sniffed for words — July's file has
 *      no text on it at all — so the only honest answer comes from looking. A receipt, an invoice or a
 *      plan is sent straight back to the + button, which is the door for one paper, for the price of
 *      the cheapest call we make.
 *   2. THE LINES (modelFor("reasoning")). Reading forty money lines off a photograph of fine print is
 *      the product's actual magic, not a classification: this is the one place in this lane where
 *      being right matters more than being cheap, and the owner said so in as many words. The gate
 *      below is what makes a model's answer safe to look at; it is not an excuse to read badly.
 */

type Result = { ok: boolean; error?: string; id?: string; line?: string; already?: string };

/**
 * WHAT A READ THAT COULD NOT HAPPEN SAYS. One action, then the fallback if that one fails — a sequence,
 * never a menu of doors to choose between (Erik: "i dont want people to have to jump on a merry go
 * round to do shit"). The paper is never lost: the + button keeps it whatever the reader is doing.
 */
const READER_SILENT = (name: string) => `${name} couldn't be read just now. Drop it again — and if it still won't read, add it with the + button at the top, which keeps it as a paper.`;

export async function readStatementScan(input: {
  name: string;
  /** The PDF itself. The browser already has the bytes (it tried the text lane on them). */
  base64: string;
  pages: number;
  sha256?: string | null;
  listDate?: string | null;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet, so there is nowhere to put this." };
  const name = String(input?.name ?? "").trim().slice(0, 200) || "Statement";

  /**
   * WHO MAY, ASKED ONCE, OF THE ONE FUNCTION (0286/0363/0365, bank-viewer.ts). A bank statement is the
   * owner's draw and his personal spending line by line, so it is owner money and the same rule holds
   * it everywhere: the drop door is only drawn for this viewer, `addOpenList` asks again before it
   * stores a download, and the database holds the row to viewer_sorts_bank(). It is asked HERE as well
   * because the next thing this does is spend real money on a read it would then have to throw away.
   * The condition itself is never re-derived — that is the two-doors defect this repo keeps paying for.
   */
  if (!(await viewerSortsBank(ctx.supabase, ctx.userId))) return { ok: false, error: `${name}: ${OWNER_SORTS_BANK}` };
  if (await aiSpendExceeded(ctx.orgId)) {
    return { ok: false, error: `${name} wasn't read: this month's AI allowance is used up, and it resets with the month. Add it with the + button at the top and it is kept as a paper until then.` };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(String(input?.base64 ?? ""), "base64");
  } catch {
    return { ok: false, error: `${name} didn't arrive in one piece. Drop it again.` };
  }
  if (!bytes.length || !isPdfBytes(new Uint8Array(bytes))) return { ok: false, error: `${name} isn't a PDF inside, whatever its name says.` };
  if (bytes.length > SCAN_MAX_BYTES) return { ok: false, error: `${name} is more than the reader can look at. Save just the statement pages as their own PDF and drop that.` };

  // ALREADY IN, BEFORE A PENNY IS SPENT: the same file read twice is the same statement, and the card
  // it made the first time is where the answer already is.
  const sha = isSha256(input?.sha256) ? String(input.sha256) : null;
  if (sha) {
    const seen = await fingerprintSeen(sha);
    if (seen.seen) return { ok: false, already: seen.seen, error: `${name}: ${seen.seen}` };
  }

  const pages = Math.max(1, Math.trunc(Number(input?.pages) || 1));
  const client = getAnthropic();
  // THE PAGES, RENDERED VISUALLY BY THE API. This is the same document block the paper reader sends
  // (organize/actions.ts), which is what reads his handwriting today — there is no second OCR here.
  const paper: any = { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } };

  // ── THE CHEAP LOOK ──────────────────────────────────────────────────────────────────────────
  let kind: ReturnType<typeof scanKindFrom>;
  try {
    const model = modelFor("classify");
    const msg = await client.messages.create({
      model,
      max_tokens: 300,
      system: SCAN_KIND_SYSTEM,
      messages: [{ role: "user", content: [paper, { type: "text", text: `Filename: ${name}. What is this paper?` }] }],
    });
    // METER THE MODEL THAT RAN (0162), never the constant: costOf prices from this string.
    void recordAiUsage({ orgId: ctx.orgId, model: (msg as { model?: string }).model ?? model, surface: "statement-scan-kind", usage: msg.usage as never });
    const text = msg.content.find((b) => b.type === "text") as { text: string } | undefined;
    kind = scanKindFrom(await parseAiJson(client, text?.text ?? "", ctx.orgId));
  } catch (e) {
    reportError("bills:statementScan.kind", e, { name });
    return { ok: false, error: READER_SILENT(name) };
  }
  if (kind.kind !== "bank_statement") return { ok: false, error: notABankScanSaid(name, kind.kind, kind.what) };

  // ── THE CAREFUL LOOK ────────────────────────────────────────────────────────────────────────
  /**
   * LENGTH IS HANDLED, AND A CUT-OFF ANSWER IS NEVER QUIETLY SHORT. 16,000 tokens holds about 250
   * transaction lines; past that the API says so (stop_reason "max_tokens") and the read CONTINUES
   * from its last line in the same conversation, which still holds the pages. Still cut off after
   * SCAN_MORE_CALLS and nothing is written at all: a short list that looks complete is worse than no
   * list, because the totals would then disagree and read like a bad parse instead of a cut one.
   */
  const model = modelFor("reasoning");
  const turns: any[] = [{ role: "user", content: [paper, { type: "text", text: `Filename: ${name}. Transcribe every transaction line and the statement's own control figures.` }] }];
  const lines: ScanLine[] = [];
  let read: ReturnType<typeof readScannedBank> | null = null;
  let table: string[][] = [];
  let returned = 0;
  let cut = false;
  try {
    for (let pass = 0; pass <= SCAN_MORE_CALLS; pass++) {
      const msg = await client.messages.create({
        model,
        max_tokens: SCAN_MAX_TOKENS,
        system: SCAN_LINES_SYSTEM,
        messages: turns,
      });
      void recordAiUsage({ orgId: ctx.orgId, model: (msg as { model?: string }).model ?? model, surface: "statement-scan", usage: msg.usage as never });
      const raw = (msg.content.find((b) => b.type === "text") as { text: string } | undefined)?.text ?? "";
      cut = msg.stop_reason === "max_tokens";
      // A CUT-OFF ANSWER IS NOT VALID JSON, so it is repaired exactly as every other reply is
      // (ai-json.ts), and a repair that itself ran out of room throws rather than closing the arrays
      // over an amputation. Either way `cut` is what decides, not how the text happened to parse.
      const got = readScannedBank(await parseAiJson(client, raw, ctx.orgId));
      // THE FIRST PASS OWNS THE CONTROL FIGURES AND THE TABLE'S HEAD; a continuation only adds lines.
      // The asked-for JSON puts those figures BEFORE "lines" on purpose: an answer cut off mid-list
      // still carries the figures that judge it, so length can never quietly disarm the gate.
      if (!read) {
        read = got;
        table = got.table;
      } else {
        table = [...table, ...got.table.slice(1)];
      }
      returned += got.returned;
      const before = lines.length;
      for (const l of got.lines) lines.push({ ...l, at: returned - got.returned + l.at });
      if (!cut) break;
      if (pass === SCAN_MORE_CALLS) break;
      const last = lines[lines.length - 1] ?? null;
      // NOTHING CAME BACK AND IT WAS STILL CUT OFF: asking again would only burn the same tokens.
      if (lines.length === before && !got.returned) break;
      // THE ANSWER SO FAR, TRIMMED: the API refuses an assistant turn that is empty or ends in
      // whitespace, and a cut-off answer often does — that would turn a long statement into an error
      // about message formatting rather than the continuation it is.
      const said = raw.trim();
      if (!said) break;
      turns.push({ role: "assistant", content: said }, { role: "user", content: scanMoreAsked(last ? { date: last.date, description: last.description } : null) });
    }
  } catch (e) {
    reportError("bills:statementScan.lines", e, { name });
    // AN ANSWER TOO BIG TO EVEN REPAIR IS A LENGTH PROBLEM, and it is said as one: ai-json.ts throws
    // that rather than closing the open arrays over an amputation, and "the reader didn't answer"
    // would send him off looking for the wrong thing.
    if (/too large to repair/i.test(String((e as { message?: string })?.message ?? ""))) return { ok: false, error: scanTruncatedSaid(name, lines.length) };
    return { ok: false, error: READER_SILENT(name) };
  }
  if (!read) return { ok: false, error: READER_SILENT(name) };
  if (cut) return { ok: false, error: scanTruncatedSaid(name, lines.length) };
  if (!lines.length) {
    // A CONFIDENT EMPTY ANSWER IS THE WORST OUTCOME HERE, so it is never a card.
    return { ok: false, error: `${name} reads as a bank statement, but the reader got no transaction lines off it. Nothing was added — drop it again, or add it with the + button at the top to keep it as a paper.` };
  }

  // ── THE GATE ────────────────────────────────────────────────────────────────────────────────
  const check = checkScanTotals(lines, read.controls);
  if (!check.pass) return { ok: false, error: scanRefusalSaid(name, check) };

  /**
   * ONE DESTINATION, THE ONE THE CSV USES. The rows go through `addOpenList`, which recognises
   * Withdrawal and Deposit as a bank's own words, cuts every run of 6+ digits out of a description
   * (cleanDescription → redactDigits, so migration 0363's CHECK can never be the thing that notices an
   * account number), asks `viewerSortsBank` again before it stores anything, and makes the one bank
   * card. `expect: "bank"` is the belt: a read this action vouched for as a bank statement can never
   * become a supplier's list, which is a class of paper the whole office may read.
   *
   * `rows` IS WHAT THE READER HANDED BACK, not the lines that survived: the read report then says "43
   * rows on them, 41 lines", and the two rows that didn't read are named by line with their reason.
   */
  return addOpenList({
    name,
    sha256: sha,
    table,
    listDate: input?.listDate ?? null,
    source: "bills_drop",
    expect: "bank",
    pdf: { pages, rows: returned, checked: scanCheckSaid(check) },
  });
}
