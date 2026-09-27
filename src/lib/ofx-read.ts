/**
 * A BANK'S OFX / QFX / QBO DOWNLOAD, AS A TABLE (bank download, 2026-09-27).
 *
 * "Download for Quicken" (QFX), "for QuickBooks" (QBO) and plain OFX are one format: either the
 * old SGML shape (tags with no closing tag: <TRNAMT>-45.12) or OFX 2's XML. Each transaction is a
 * <STMTTRN> block; the account is <ACCTID>. This reads them into the SAME rows of cells a CSV
 * becomes, under a header the bank reader already knows, so there is one reader after this, not
 * two:
 *
 *   Account | Date | Description | Amount | Check | Id
 *
 * Id is the bank's own transaction id (FITID): the bank download's line key, so the same line in two
 * overlapping downloads is one line. Pure: text in, rows out, in the browser and in tests.
 */

export const OFX_HEADER = ["Account", "Date", "Description", "Amount", "Check", "Id"] as const;

export type OfxResult = { ok: true; rows: string[][] } | { ok: false; error: string };

/** Does this text look like an OFX file (by what is in it, whatever its name)? */
export function looksLikeOfx(text: string): boolean {
  const head = String(text ?? "").slice(0, 4000);
  return /OFXHEADER\s*[:=]/i.test(head) || /<OFX>/i.test(head) || /<\?OFX\b/i.test(head);
}

/** The value of one tag inside a block: SGML (<TAG>value, ended by the next tag or line) or XML. */
function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  if (!m) return null;
  const v = m[1]
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();
  return v || null;
}

/** "20260924120000.000[-7:MST]" → "2026-09-24". */
export function ofxDate(raw: string | null): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const [mo, d] = [Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Read an OFX/QFX/QBO file's transactions. Never throws. */
export function readOfx(text: string, name = "That file"): OfxResult {
  const src = String(text ?? "");
  if (!looksLikeOfx(src)) return { ok: false, error: `${name} isn't a bank download (OFX, QFX or QBO) inside. Download it again as CSV and drop that.` };
  // Every statement in the file (a checking and a card download can share one), each with its own
  // account; a transaction takes the account of the statement it sits in.
  const statements = src.split(/<\/?(?:STMTRS|CCSTMTRS)>/i);
  const rows: string[][] = [[...OFX_HEADER]];
  let account: string | null = null;
  for (const part of statements) {
    const acct = tag(part, "ACCTID");
    if (acct) account = acct;
    const blocks = part.split(/<STMTTRN>/i).slice(1);
    for (const raw of blocks) {
      const block = raw.split(/<\/STMTTRN>/i)[0];
      const date = ofxDate(tag(block, "DTPOSTED")) ?? ofxDate(tag(block, "DTUSER"));
      const amount = tag(block, "TRNAMT");
      if (!date || !amount) continue;
      const nameText = tag(block, "NAME") ?? tag(block, "PAYEEID") ?? "";
      const memo = tag(block, "MEMO") ?? "";
      const description = memo && !nameText.toLowerCase().includes(memo.toLowerCase()) ? `${nameText} ${memo}`.trim() : nameText || memo;
      rows.push([
        account ?? "",
        date,
        description || (tag(block, "TRNTYPE") ?? ""),
        amount.replace(/,/g, "."),
        tag(block, "CHECKNUM") ?? "",
        tag(block, "FITID") ?? "",
      ]);
    }
  }
  if (rows.length < 2) return { ok: false, error: `${name} has no transactions in it.` };
  return { ok: true, rows };
}
