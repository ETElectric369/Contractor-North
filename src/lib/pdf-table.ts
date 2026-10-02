import { HEADER_WORDS, MONEY_CELL, findHeaderRow, isLineItemHeader, looksLikePaperNumber, readDate, readHeaderRow, readHeaderWith, readMoney, type OpenListColumns } from "@/lib/supplier-open-list";
import { BANK_WORDS, bankTableProof, findBankHeader, looksLikeBankTable } from "@/lib/bank-download";

/**
 * A PDF'S TABLE, FROM WHERE ITS MARKS SIT ON THE PAGE (the PDF statement reads, 2026-10-02).
 *
 * Erik: "i want to upload my bank statement and supplier statement, every item will either match or
 * need a category." A statement already works as CSV, Excel or OFX, and fails as the PDF his
 * supplier emails him — a PDF went down the single-paper path and was read as one receipt.
 *
 * EVERYTHING DOWNSTREAM OF A TABLE ALREADY EXISTS: supplier-open-list.ts reads a supplier's open
 * list out of a string[][] by its header words, bank-download.ts reads a bank's download out of
 * one, and addOpenList turns either into the card a person answers. The only missing piece was
 * PDF → string[][], and this is it.
 *
 * WHY POSITIONS AND NOT LINES. pdf-text.ts joins pdfjs's text runs into LINES and throws the
 * positions away. A statement is a TABLE: from joined text you cannot tell WHICH COLUMN an amount
 * sits in, and on a bank statement that is the difference between a withdrawal and a deposit. pdfjs
 * gives every run a transform (its x and y) and a width, so that is what this reads.
 *
 * PURE AND BROWSER-FREE ON PURPOSE: no pdfjs here, so every rule below is unit-tested against
 * invented marks with no PDF in the loop. The pdfjs loader stays in pdf-text.ts, where the buffer
 * copy, the isPdfBytes check, the never-throws contract and the "it is probably a scan" sentence
 * already live — one loader and one scan sentence for the whole app.
 */

/** One text run off a page: what it says, and where it sits. pdfjs: x = transform[4], y = transform[5]. */
export type PositionedItem = {
  str: string;
  /** Points from the LEFT edge of the page. */
  x: number;
  /** Points from the BOTTOM of the page: bigger is higher up. */
  y: number;
  /** How wide the run is, in points. The RIGHT edge is x + width, and money is right-aligned. */
  width: number;
  /** How tall the run is. The row tolerance is derived from it, never hardcoded. */
  height?: number;
  /** 0-based page. Two pages' marks share y values, so a row is a page AND a y, never a y alone. */
  page?: number;
};

export type TableOptions = {
  /** Rows kept, so a 400-page export cannot run a phone out of memory. */
  maxRows?: number;
};

const MAX_ROWS = 2000;
/** As many columns as capTable (supplier-open-list.ts) keeps on a row. Past that it is not a table. */
const MAX_COLUMNS = 40;
/** A mark with no width still has to land in a column, so it is given one point of its own. */
const MIN_WIDTH = 1;

type Mark = { str: string; x: number; right: number; y: number; page: number };

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The marks worth reading: text, with a place on a page. A run of only spaces is spacing, not a cell. */
function marksOf(items: readonly PositionedItem[] | null | undefined): { marks: Mark[]; height: number } {
  const marks: Mark[] = [];
  const heights: number[] = [];
  for (const it of items ?? []) {
    const str = typeof it?.str === "string" ? it.str.replace(/\s+/g, " ").trim() : "";
    if (!str) continue;
    const x = num(it?.x);
    const y = num(it?.y);
    if (x === null || y === null) continue;
    const w = num(it?.width);
    const h = num(it?.height);
    if (h !== null && h > 0) heights.push(h);
    const page = num(it?.page);
    marks.push({
      str,
      x,
      right: x + Math.max(w !== null && w > 0 ? w : 0, MIN_WIDTH),
      y,
      page: page === null ? 0 : Math.max(0, Math.trunc(page)),
    });
  }
  return { marks, height: median(heights) };
}

function median(ns: readonly number[]): number {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * ROWS BY WHERE THEY SIT, with the tolerance taken from the text's own height: half a line of type.
 * Hardcoding it (3 points, because one statement needed 3) is a number that fits one supplier's
 * paper and silently splits the next one's rows in two. A paper with no heights at all falls back
 * to two points, and says so here rather than pretending it measured something.
 */
function rowTolerance(height: number): number {
  return height > 0 ? Math.max(1, height / 2) : 2;
}

function rowsOf(marks: readonly Mark[], tol: number): Mark[][] {
  const sorted = [...marks].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const rows: Mark[][] = [];
  let row: Mark[] = [];
  let anchorY = 0;
  let anchorPage = -1;
  for (const m of sorted) {
    // Against the row's FIRST mark, never the one before it: comparing neighbours chains a whole
    // page of closely stacked lines into one row.
    if (!row.length || m.page !== anchorPage || Math.abs(m.y - anchorY) > tol) {
      if (row.length) rows.push(row);
      row = [m];
      anchorY = m.y;
      anchorPage = m.page;
    } else row.push(m);
  }
  if (row.length) rows.push(row);
  for (const r of rows) r.sort((a, b) => a.x - b.x || a.right - b.right);
  return rows;
}

/** `grid`: a column the repeating cells drew. A band without it is one lone mark's own stretch. */
type Band = { lo: number; hi: number; grid?: boolean };

function mergeBands(spans: readonly Band[]): Band[] {
  const sorted = [...spans].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: Band[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    // Overlap merges; touching edge to edge does not. Two columns whose ink ends and begins at the
    // same point are still two columns.
    if (last && s.lo < last.hi) last.hi = Math.max(last.hi, s.hi);
    else out.push({ lo: s.lo, hi: s.hi });
  }
  return out;
}

/** A point of slop: the same words at the same size land on the same edge to better than a point. */
const EDGE_TOL = 1;
/** Three rows agreeing on an edge is a column. Two is what any page hands out by accident. */
const COLUMN_ROWS = 3;

/**
 * AN ALIGNMENT EDGE: a left or right edge that THREE OR MORE ROWS put a mark on. Every column of a
 * statement has one — ten dates begin at the same x, ten amounts END at the same x — and a title, an
 * address line and an aging footer label have none, because nothing else on the page lines up with
 * them.
 *
 * WHY THREE AND NOT TWO. Two edges meeting is a coincidence a page hands out freely: the supplier's
 * own address line ended at x150, an aging footer label began at x150, and those two rows made an
 * "edge" in the middle of the REFERENCE column — which disqualified every reference on the paper from
 * drawing its own column and merged REFERENCE and CUSTOMER PO# into one. Three rows agreeing is a
 * column; two is the page being a page.
 *
 * WHY WITHIN ONE PAGE AND NOT ACROSS THE PAPER. The address block is reprinted on every page, so on a
 * three-page statement that same x150 coincidence reached three rows and did the damage anyway. Three
 * rows of ONE page is what a column means; the same line three times on three pages is one line.
 *
 * BOTH EDGES, NOT THE LEFT ONE. On a real statement OPEN AMOUNT is printed at x420 and its amounts
 * land at x466: money is RIGHT-aligned, so its column is known by x + width and not by x at all.
 */
function alignmentEdges(rows: readonly Mark[][]): number[] {
  const pages = new Map<number, Mark[][]>();
  for (const r of rows) {
    const page = r[0]?.page ?? 0;
    const list = pages.get(page);
    if (list) list.push(r);
    else pages.set(page, [r]);
  }
  const edges = new Set<number>();
  for (const pageRows of pages.values()) {
    const points: { at: number; row: number }[] = [];
    pageRows.forEach((r, i) => {
      for (const m of r) {
        points.push({ at: m.x, row: i });
        points.push({ at: m.right, row: i });
      }
    });
    points.sort((a, b) => a.at - b.at);
    const groups: { at: number; rows: Set<number> }[] = [];
    for (const p of points) {
      const last = groups[groups.length - 1];
      // Against the group's FIRST point, so a long smear of near-misses cannot chain into one edge.
      if (last && p.at - last.at <= EDGE_TOL) last.rows.add(p.row);
      else groups.push({ at: p.at, rows: new Set([p.row]) });
    }
    for (const g of groups) if (g.rows.size >= COLUMN_ROWS) edges.add(g.at);
  }
  return [...edges];
}

/**
 * A ROW'S MARKS AS THE WORDS A READER SEES: runs closer together than about two spaces are one word,
 * so "OPEN" and "AMOUNT" printed as two runs are the one heading OPEN AMOUNT and not two columns.
 */
function wordGroups(row: readonly Mark[], height: number): { str: string; x: number; right: number }[] {
  const near = (height > 0 ? height : 8) * 1.5;
  const out: { str: string; x: number; right: number }[] = [];
  for (const m of row) {
    const last = out[out.length - 1];
    if (last && m.x - last.right <= near) {
      last.str = `${last.str} ${m.str}`.replace(/\s+/g, " ");
      last.right = Math.max(last.right, m.right);
    } else out.push({ str: m.str, x: m.x, right: m.right });
  }
  return out;
}

/** Is this one word a column heading one of the readers KNOWS? ("Open Amount" yes, "AGE" no.) */
function knownHeading(word: string): boolean {
  const supplier = readHeaderWith([word], HEADER_WORDS).columns;
  const bank = readHeaderWith([word], BANK_WORDS).columns;
  return Object.keys(supplier).length > 0 || Object.keys(bank).length > 0;
}

/**
 * The row whose words one of the readers recognises as COLUMN HEADINGS, each word with whether that
 * reader knows it. The known ones are what the grid is checked against: a paper's own "AGE" or "ORIG
 * AMOUNT" is nobody's word, and whether it shares a cell with its neighbour decides nothing.
 */
function headingRow(rows: readonly Mark[][], height: number): { x: number; right: number; known: boolean }[] | null {
  for (const row of rows) {
    const groups = wordGroups(row, height);
    if (groups.length < 3) continue;
    if (!readsAsHeading(groups.map((g) => g.str))) continue;
    return groups.map((g) => ({ x: g.x, right: g.right, known: knownHeading(g.str) }));
  }
  return null;
}

/**
 * THE GRID IS DRAWN BY THE MARKS THAT DO NOT SWALLOW ANOTHER COLUMN'S EDGE, AND BY NOTHING ELSE.
 *
 * A column cannot be found by clustering every mark that overlaps another: a statement's address
 * block, its title and its aging footer each sit across several columns at once, and one "TOTAL DUE"
 * printed over the gutter between DATE and CODE merges those two columns for the whole paper. So a
 * mark draws a column only when nothing else's alignment edge falls INSIDE it. Ten dates of the same
 * width swallow nothing and draw the date column; "ADC ELECTRIC INC" across the top swallows the
 * date column's two edges and the code column's, and draws nothing.
 *
 * It is one idea and not a count, so it holds on a one-page statement with four papers on it as well
 * as on a thirty-page one — a rule that said "few enough rows cross here" would turn on how much
 * furniture the page happened to carry.
 *
 * AND IT MUST STAND ON AN ALIGNMENT EDGE OF ITS OWN. The aging footer is two rows of its own — five
 * labels and five figures, each figure right-aligned under its label — so those two rows line up with
 * each other and nothing else; a rule that stopped at "swallows nothing" would let PAST DUE 61 - 90
 * draw a column across the gutter between DISCOUNT and OPEN AMOUNT, the OPEN AMOUNT heading would
 * overlap the footer's band further than its own amounts', and the heading and its figures would end
 * up in two columns.
 *
 * WHEN NOTHING REPEATS THREE TIMES there is no grid to find in the rows, and the HEADING ROW's own
 * edges are used instead — see bandsOf below, which checks its work against that row.
 */
function gridOf(edges: readonly number[], all: readonly Mark[], height: number): Band[] {
  const swallows = (m: Mark) => edges.some((at) => at > m.x + EDGE_TOL && at < m.right - EDGE_TOL);
  const standsOn = (m: Mark) => edges.some((at) => Math.abs(at - m.x) <= EDGE_TOL || Math.abs(at - m.right) <= EDGE_TOL);
  const spanOf = (m: Mark) => ({ lo: m.x, hi: m.right });
  // ONE CELL pdfjs HAPPENED TO EMIT IN TWO RUNS IS STILL ONE COLUMN: bands closer together than a
  // space are one band. No printed column gutter is narrower than a space, so nothing real is lost,
  // and "7741" and "-2203118" cannot become two columns with the second one shifting every value
  // after it.
  const gutter = (height > 0 ? height : 8) * 0.3;
  const kept = all.filter((m) => !swallows(m));
  const drawing = kept.filter(standsOn);
  const bands = joinTight(mergeBands((drawing.length ? drawing : kept).map(spanOf)), gutter);
  // A MARK THAT FITS NO COLUMN GETS ONE OF ITS OWN, rather than being pushed into the nearest one. A
  // supplier's DISCOUNT column may carry one figure on the whole statement, and pushing that figure
  // into OPEN AMOUNT next door is an amount under the wrong heading — the one failure this whole file
  // exists to prevent. An extra, mostly empty column costs nothing: the readers downstream find their
  // columns by the header row's own position, so a column every row leaves blank changes no answer.
  const orphans = all.filter((m) => !bands.some((b) => m.x < b.hi && b.lo < m.right));
  for (const b of bands) b.grid = true;
  const extra = joinTight(mergeBands(orphans.map(spanOf)), gutter);
  return [...bands, ...extra].sort((a, b) => a.lo - b.lo);
}

/**
 * THE GRID IS CHECKED AGAINST THE HEADING ROW, AND THE HEADING ROW WINS (the short statement, 2026-10-02).
 *
 * A statement with ONE or TWO open papers on it has no column that three rows of a page agree on, so
 * the only edges left are coincidences — an address line's left x, a footer label's right edge — and
 * the money columns, whose right edges only two rows share, draw nothing at all. Every money mark then
 * falls through as an orphan, the orphans merge, and DISCOUNT, OPEN AMOUNT and ORIG AMOUNT arrive as
 * ONE cell. The statement read as no list, the PDF went down the single-paper path with nothing said
 * about its table, and Reconcile refused it with "nothing on them reads as a statement" — which was
 * false: it had a column of paper numbers and a column of amounts. A small contractor's month with two
 * open invoices is an ordinary month, not an edge case.
 *
 * THE TEST IS THE PAPER'S OWN HEADINGS: every heading the readers KNOW must land in a column of its
 * own. Two of them in one cell means the grid is wrong, whatever drew it — and then the heading row,
 * which IS a column grid the paper printed itself, draws the grid instead. Only words a reader knows
 * count, so one heading pdfjs happened to split into two wide-apart runs decides nothing.
 *
 * IT IS A SECOND PASS AND NOT THE FIRST, because on a statement with rows enough to measure, the rows'
 * own edges are the better measure: money is right-aligned and lands 20 points past the right edge of
 * the heading over it, so a grid built from heading edges alone has to find each amount by overlap. A
 * page whose headings already separate is left exactly as it was.
 */
function bandsOf(rows: readonly Mark[][], all: readonly Mark[], height: number): Band[] {
  if (!all.length) return [];
  const bands = gridOf(alignmentEdges(rows), all, height);
  const heading = headingRow(rows, height);
  if (!heading || headingsSplit(bands, heading)) return bands;
  const seeded = gridOf(
    heading.flatMap((g) => [g.x, g.right]),
    all,
    height,
  );
  return seeded.length ? seeded : bands;
}

/** Does every heading a reader knows land in a column of its own? Two in one cell is a wrong grid. */
function headingsSplit(bands: readonly Band[], heading: readonly { x: number; right: number; known: boolean }[]): boolean {
  const seen = new Set<number>();
  for (const g of heading) {
    if (!g.known) continue;
    const at = bandFor(bands, { str: "", x: g.x, right: g.right, y: 0, page: 0 });
    if (seen.has(at)) return false;
    seen.add(at);
  }
  return true;
}

function joinTight(bands: readonly Band[], gutter: number): Band[] {
  const out: Band[] = [];
  for (const b of bands) {
    const last = out[out.length - 1];
    if (last && b.lo - last.hi < gutter) last.hi = Math.max(last.hi, b.hi);
    else out.push({ lo: b.lo, hi: b.hi });
  }
  return out;
}

/**
 * THE COLUMN A MARK BELONGS TO: of the columns the grid drew, the one it overlaps most. A mark over a
 * real column goes in that column even when some lone label's band overlaps it further — that is how
 * the OPEN AMOUNT heading stays over its own amounts instead of joining the aging footer's stretch.
 * Only a mark over no real column at all falls back to the lone bands, and then to the nearest.
 */
function bandFor(bands: readonly Band[], m: Mark): number {
  const pick = (only: boolean) => {
    let best = -1;
    let bestOverlap = 0;
    for (let i = 0; i < bands.length; i++) {
      if (only && !bands[i].grid) continue;
      const overlap = Math.min(m.right, bands[i].hi) - Math.max(m.x, bands[i].lo);
      if (overlap > bestOverlap) {
        best = i;
        bestOverlap = overlap;
      }
    }
    return best;
  };
  const onGrid = pick(true);
  if (onGrid >= 0) return onGrid;
  const anywhere = pick(false);
  if (anywhere >= 0) return anywhere;
  const mid = (m.x + m.right) / 2;
  let nearest = 0;
  let distance = Infinity;
  for (let i = 0; i < bands.length; i++) {
    const d = Math.abs((bands[i].lo + bands[i].hi) / 2 - mid);
    if (d < distance) {
      nearest = i;
      distance = d;
    }
  }
  return nearest;
}

/**
 * ONE CELL'S WORDS. A gap wider than about half a space is a space; anything tighter is one word
 * pdfjs happened to emit in two runs, and "1,062" + ".18" joined with a space is read as two tokens
 * and no longer as $1,062.18.
 */
function cellText(marks: readonly Mark[], height: number): string {
  const space = (height > 0 ? height : 8) * 0.14;
  let out = "";
  let end: number | null = null;
  for (const m of marks) {
    if (end !== null && m.x - end > space) out += " ";
    out += m.str;
    end = m.right;
  }
  return out.replace(/\s+/g, " ").trim();
}

const DATE_IN = /\b\d{1,2}[/-]\d{1,2}[/-](?:\d{4}|\d{2})\b|\b\d{4}-\d{2}-\d{2}\b/;
const MONEY_IN = /\(?-?\$?\s?[\d,]*\d\.\d{2}\)?-?/;

/**
 * A WRAPPED DESCRIPTION IS PART OF THE ROW ABOVE IT, NOT A ROW OF ITS OWN. A long supplier name or
 * job reference wraps onto a second line, and that line carries no date and no amount — just words,
 * in one column, under a row that had several. Left alone it becomes a row with no paper number on
 * it, and the words are lost. This is a rule and not a special case: ANY lone cell of words with no
 * day and no money in it, under a row that has more than one cell, joins that row's same cell.
 *
 * AND IT IS THE ROW ABOVE IT, NOT THE LAST ROW ANYWHERE ON THE PAGE — see linePitch and the join
 * itself in tableFromPositionedItems. A rule with no vertical reach joined "Page 1 of 3" at the foot
 * of the page, and "PAYMENTS AND CREDITS" 80 points under the last paper, onto that paper's REFERENCE
 * cell: "7741-2209002 PAYMENTS AND CREDITS", accepted with nothing reported, matching no bill the app
 * holds, so the card proposed adding a duplicate paper and called the real one missing.
 */
function isContinuation(cells: readonly string[]): number | null {
  let at = -1;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    if (at >= 0) return null;
    at = i;
  }
  if (at < 0) return null;
  const text = cells[at];
  if (!/[A-Za-z]{2}/.test(text)) return null;
  if (DATE_IN.test(text) || readDate(text) !== null) return null;
  if (MONEY_IN.test(text) || readMoney(text) !== null) return null;
  return at;
}

const filled = (cells: readonly string[]) => cells.filter((c) => c !== "").length;

/**
 * THE PAGE'S OWN LINE PITCH: the median gap from one row to the next, within a page. A wrapped
 * description sits ONE line under the row it belongs to; a page-number footer sits six hundred points
 * under it, and an aging footer forty. Measured off the paper rather than hardcoded, because a number
 * that fits one supplier's leading silently joins the next supplier's footer onto his last paper.
 */
function linePitch(rows: readonly Mark[][], height: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const above = rows[i - 1][0];
    const here = rows[i][0];
    if (!above || !here || above.page !== here.page) continue;
    const gap = above.y - here.y;
    if (gap > 0) gaps.push(gap);
  }
  const m = median(gaps);
  return m > 0 ? m : (height > 0 ? height : 8) * 1.5;
}

/**
 * COULD THIS ROW BE A LINE OF THE STATEMENT? A day in one cell, or a figure in one. Page furniture — a
 * heading row, an address block, a page title, a remit-to block — carries neither.
 *
 * It is what the repeated-page-furniture rule is allowed to drop. The rule used to drop ANY row a
 * later page repeated cell for cell, and a card statement that charged the same fuel station the same
 * amount twice in one week — page 1's last line and page 2's first — lost the second purchase. It was
 * not counted and not listed as skipped: the report's row count is measured AFTER the drop, so only
 * the total disagreeing with his own paper could reveal it, which is the worst outcome this path has.
 */
function carriesALine(cells: readonly string[]): boolean {
  return cells.some((c) => {
    const v = c.trim();
    if (!v) return false;
    return MONEY_CELL.test(v) || DATE_IN.test(v) || readDate(v) !== null;
  });
}

/**
 * A PDF'S PAGES AS ONE TABLE: rows by where they sit, columns by the bands that repeat, every cell
 * in its own column with the empty ones kept. An empty cell IS information — a row that drops it
 * shifts every value after it one column left, which on a statement means an amount landing under
 * the wrong heading.
 *
 * REPEATED PAGE FURNITURE: page two of a statement reprints the heading row and the address block,
 * and three header rows and three address blocks must not arrive as if they were papers. THE RULE:
 * a row on a later page that is an EXACT repeat (cell for cell) of a row already seen on an EARLIER
 * page is dropped, AND ONLY WHEN IT COULD NOT BE A LINE — no day in it and no figure (carriesALine).
 * The readers downstream find their own header row, so one copy of it is all they need, and a
 * within-page repeat is kept untouched.
 *
 * WHY THE SECOND HALF OF THAT RULE. Without it, a row that really was a line went silently missing: a
 * card statement that charged the same fuel station the same amount twice in one week, page 1's last
 * line and page 2's first, read one purchase short with nothing counted and nothing listed as skipped.
 * The row count in the read report is `table.length`, measured after this function has already
 * dropped the row, and nothing in ReadFacts can carry "a row was removed" — so the loss could only
 * ever surface as a total that disagreed with his own paper. A heading row, an address line and a page
 * title carry neither a day nor a figure, so nothing this rule exists for is lost by narrowing it.
 */
export function tableFromPositionedItems(items: readonly PositionedItem[] | null | undefined, opts?: TableOptions): string[][] {
  const { marks, height } = marksOf(items);
  if (!marks.length) return [];
  const rows = rowsOf(marks, rowTolerance(height));
  const bands = bandsOf(rows, marks, height);
  // MORE COLUMNS THAN ANYTHING DOWNSTREAM KEEPS IS NO TABLE AT ALL. capTable (supplier-open-list.ts)
  // keeps 40 columns per row, so handing back 60 would quietly lose the rightmost ones — and the
  // rightmost column of a statement is its balance. A page that scatters into that many columns is
  // prose, not a grid: it reads as nothing, and the paper goes down the single-paper path where the
  // doors already say what to do with it.
  if (!bands.length || bands.length > MAX_COLUMNS) return [];
  const cap = Math.max(1, Math.min(opts?.maxRows ?? MAX_ROWS, MAX_ROWS));

  // A wrapped line sits one pitch under its row; anything further down the page is not its tail.
  const reach = linePitch(rows, height) * 1.5;

  const out: string[][] = [];
  const pages: number[] = [];
  const ys: number[] = [];
  const seen = new Map<string, number>();
  for (const row of rows) {
    const buckets: Mark[][] = bands.map(() => []);
    for (const m of row) buckets[bandFor(bands, m)].push(m);
    const cells = buckets.map((b) => cellText(b, height));
    if (!filled(cells)) continue;
    const page = row[0].page;
    const y = row[0].y;
    const key = cells.join("\u0001");
    const first = seen.get(key);
    if (first !== undefined && first < page && !carriesALine(cells)) continue;
    if (first === undefined) seen.set(key, page);

    const at = isContinuation(cells);
    const prev = out[out.length - 1];
    // THE ROW DIRECTLY ABOVE IT, ON THE SAME PAGE, WITHIN ONE LINE PITCH, AND NEVER INTO A CELL THAT
    // ALREADY HOLDS A DAY OR A FIGURE. Each of those three is a failure that shipped: a footer 650
    // points below glued "Page 1 of 3" onto a paper number; a section title 40 points below glued
    // "DAILY BALANCE SUMMARY" onto a deposit's date, and that $1,875.50 deposit was skipped; and a
    // line that lands in the amount column turns "275.40" into "275.40 Page 1 of 3", which drops the
    // paper out of the total altogether.
    const near = prev && pages[pages.length - 1] === page && ys[ys.length - 1] - y <= reach;
    if (at !== null && prev && near && filled(prev) > 1 && !carriesALine([prev[at]])) {
      prev[at] = prev[at] ? `${prev[at]} ${cells[at]}` : cells[at];
      continue;
    }
    out.push(cells);
    pages.push(page);
    ys.push(y);
    if (out.length >= cap) break;
  }
  return out;
}

/** How far down a PDF's pages the heading row is looked for. */
const HEADING_SCAN = 200;
/** As far as findHeaderRow and findBankHeader look for a heading row themselves. */
const READER_REACH = 15;

/** A row that reads as a row of COLUMN HEADINGS, by the words the readers already know: a supplier's
 *  (two fields, one of them the paper number or the money) or a bank's (a day, a description, money). */
function readsAsHeading(cells: readonly string[]): boolean {
  const { columns } = readHeaderRow(cells);
  const found = Object.keys(columns).length;
  if (found >= 2 && (columns.reference !== undefined || columns.openBalance !== undefined || columns.amount !== undefined)) return true;
  return findBankHeader([cells]) !== null;
}

/**
 * THE TABLE FROM ITS HEADING ROW DOWN, WHEN THE HEADING IS OUT OF THE READERS' OWN REACH.
 *
 * findHeaderRow and findBankHeader each look at the first 15 rows only — written for a download, where
 * the heading is row 0. On a PDF every y-line of the letterhead, the remit-to block, the customer's
 * address, the account box and the supplier's message is a row, and sixteen of them is an ordinary
 * letterhead: the heading landed at row 16, both readers answered "no heading", the whole statement
 * read as no list, and the PDF went down the single-paper path with nothing said about its table.
 *
 * AND ONLY WHEN IT IS OUT OF REACH. Inside 15 rows the readers find it themselves and every row above
 * it stays where it is, because readOpenListTable reads the supplier's own printed total off the rows
 * ABOVE the heading (printedFigures) — and that total is the one cross-check the completeness question
 * has. Cropping a paper that did not need cropping would buy a heading and sell the proof.
 */
function fromHeading(table: readonly (readonly string[])[]): string[][] {
  const rows = (table ?? []).map((r) => (r ?? []).map((c) => String(c ?? "")));
  let at = -1;
  for (let i = 0; i < Math.min(rows.length, HEADING_SCAN); i++) {
    if (readsAsHeading(rows[i])) {
      at = i;
      break;
    }
  }
  return at < READER_REACH ? rows : rows.slice(at);
}

/**
 * DOES THE REFERENCE COLUMN HOLD PAPER NUMBERS, WITH MONEY BESIDE THEM? Asked of the VALUES, because
 * the heading words alone cannot tell a supplier's open list from an invoice or a proposal.
 *
 * A painter's proposal printing ITEM | DESCRIPTION | AMOUNT over "Interior 1", "Exterior 2" and
 * "Trim 3" read as three open papers for $12,200 of work nobody had billed. An invoice printing
 * INVOICE NO. | INVOICE DATE | TERMS | AMOUNT DUE over its own labour lines read as a one-paper list
 * with four rows reported as "isn't a paper number" — and either way the paper itself was never filed.
 *
 * THE LINE: at least half of what sits under the paper-number column, with money beside it, IS a paper
 * number. A statement's own aging footer puts one label row under that column, so "every row" would
 * turn away an ordinary statement; an invoice's item lines put four or five words there, so half is a
 * line neither a proposal nor an invoice gets near.
 */
function mostlyPapers(table: readonly (readonly string[])[], at: number, columns: OpenListColumns): boolean {
  const ref = columns.reference;
  if (ref === undefined) return false;
  const moneyAt = [columns.openBalance, columns.amount].filter((i): i is number => typeof i === "number");
  let papers = 0;
  let candidates = 0;
  for (let i = Math.max(at, 0) + 1; i < table.length; i++) {
    const row = table[i] ?? [];
    const v = String(row[ref] ?? "").trim();
    if (!v) continue;
    candidates++;
    if (looksLikePaperNumber(v) && moneyAt.some((j) => readMoney(String(row[j] ?? "")) !== null)) papers++;
  }
  return papers > 0 && papers * 2 >= candidates;
}

/**
 * IS THIS PDF A STATEMENT, OR IS IT ONE PAPER? Asked of the readers that already exist:
 * bank-download.ts's `looksLikeBankTable` and `bankTableProof` for a bank's download, and
 * supplier-open-list.ts's `findHeaderRow`/`readHeaderRow` plus its own paper-number test for a
 * supplier's open list. A table nothing recognises is not a list, and the PDF goes down the
 * single-paper path it goes down today — an invoice, a job plan and a deed must all behave exactly as
 * they did.
 *
 * ONE FUNCTION, BOTH DOORS, AND IT HANDS BACK THE ROWS IT ANSWERED ABOUT. Snap Or Note and Reconcile's
 * statement line ask this one question, so a PDF that reads as a list at one door reads as a list at
 * the other; and because the answer carries the rows (cropped to the heading row when the letterhead
 * put it out of the readers' reach), a door cannot ask the question of one table and then read a
 * different one.
 *
 * THE INVOICE GUARD IS ASKED BEFORE EITHER ANSWER. It used to sit under the bank answer, where it
 * could never run: a date, a description and an amount is the shape of a card statement AND of a
 * subcontractor's time-and-materials invoice, so `looksLikeBankTable` said "bank" and returned before
 * the guard whose whole job was to say "that is an invoice's own item table".
 */
export function tableReadsAsList(table: readonly (readonly string[])[]): { as: "bank" | "supplier"; rows: string[][] } | null {
  if (!table?.length) return null;
  const rows = fromHeading(table);
  if (!rows.length) return null;
  // AN INVOICE'S OWN ITEM TABLE IS NEVER A LIST OF OPEN PAPERS, whatever its columns say: "ITEM" is
  // one of the words a paper number goes by, "AMOUNT" is money, and HOURS and RATE over three dated
  // lines are a date, a description and an amount. The same guard the paste door already uses (a
  // quantity and a price over the same columns), asked once, above both answers.
  if (rows.some((r) => isLineItemHeader(r.join(" ")))) return null;
  const at = findHeaderRow(rows);
  const header = at >= 0 ? readHeaderRow(rows[at] ?? []).columns : {};
  // A BANK'S STATEMENT NEEDS THE PROOF ONLY A STATEMENT CARRIES (bankTableProof): a heading only a
  // bank prints, a running balance, or money that went out. Without it an invoice's three labour lines
  // became three DEPOSITS on a bank card — the owner's own money, invented — and an office hand who
  // does not sort the bank was refused in the owner's name and could not file a vendor's invoice at all.
  if (looksLikeBankTable(rows, header.reference !== undefined) && bankTableProof(rows)) return { as: "bank", rows };
  if (at < 0) return null;
  // The same two columns readOpenListTable requires before it will read a list at all. Anything
  // short of them would land on the column picker, and a person pointing at the columns of an
  // invoice he meant to file as an invoice is a dead end dressed as a question.
  if (header.reference === undefined) return null;
  if (header.openBalance === undefined && header.amount === undefined) return null;
  if (!mostlyPapers(rows, at, header)) return null;
  return { as: "supplier", rows };
}
