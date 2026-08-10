/**
 * Minimal CSV parser — handles quoted fields, escaped quotes (""), embedded commas, and
 * CRLF. Returns rows of string cells with fully-blank rows dropped. The one parser the CSV
 * imports (price list, kits, customers) share so they can't diverge on quoting edge cases.
 *
 * ── THE INCH MARK (cn-v696) ─────────────────────────────────────────────────────────────────
 *
 * A quote only OPENS A FIELD when it is that field's first character. That is RFC 4180, and the
 * old version got it wrong: any `"` anywhere flipped the parser into quote mode.
 *
 * That is not an edge case in this business — it is the single most common character in a trade
 * parts list. `4" RND LS(650/800/1000)`. `1/2" EMT`. `2x6x12'`. Erik's CED import carries dozens.
 * And the failure is not a mangled cell: once quote mode is on, the very next comma and every
 * newline after it are swallowed as content, so THE ENTIRE REST OF THE FILE collapses into one
 * field of one row. A 152-line import silently becomes a 1-line import.
 *
 * Three rows in ET Electric's live price list are the survivors of exactly this — the ones where
 * a later stray `"` happened to close the quote again and let parsing resume, leaving the columns
 * shifted one to the left: `unit` holding "36.730", "25.690", "44.910" (those are prices), and the
 * description still carrying the quote that opened the mess. Whatever fell between them never
 * arrived at all, and nothing anywhere said so.
 *
 * A `"` that is not at the start of a field is now literal content, which is the only reading that
 * can be right: there is no other thing it could mean.
 */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    }
    // OPENS ONLY AT FIELD START (cur is still empty). Anywhere else it is an inch mark.
    else if (c === '"' && cur === "") inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (c !== "\r") cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** Parse a CSV to objects keyed by its (lowercased, trimmed) header row; values trimmed. */
export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
}
