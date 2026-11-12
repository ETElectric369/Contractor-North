import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GROUP_ORDER, KIND_GROUP, sortActionItems, type ActionItem, type ActionKind } from "./types";

/**
 * NEEDS YOU'S ONE ORDER: sorted ONCE, inside the build, so every reader reads one order. Not done
 * first; then NOW; then the four tiles in order; a Couldn't Check line leading its tile; SOON before
 * no mark; then when, oldest first, with an undated row counting as today; ties keep the build's own
 * order. The piles roll up after it (piles.ts), each in its most pressing child's place.
 */
const TODAY = "2026-09-27";
let seq = 0;
const row = (kind: ActionKind, o: Partial<ActionItem> = {}): ActionItem => ({
  id: `r${++seq}`,
  kind,
  group: KIND_GROUP[kind],
  title: `${kind} ${seq}`,
  when: null,
  urgency: 1,
  done: false,
  href: "/",
  affordances: ["open"],
  ...o,
});
const ids = (items: ActionItem[]) => sortActionItems(items, TODAY).map((i) => i.id);

describe("the one order", () => {
  it("NOW comes first: a NOW row in the last tile sorts above a SOON row in the first", () => {
    const soonPaid = row("invoice_draft", { level: "soon" });
    const nowBooks = row("supplier_pay", { level: "now" });
    expect(ids([soonPaid, nowBooks])).toEqual([nowBooks.id, soonPaid.id]);
  });

  it("then the four tiles: Get Paid, Win Work, Run the Jobs, Keep the Books", () => {
    expect(GROUP_ORDER).toEqual(["get_paid", "win_work", "run_jobs", "keep_books"]);
    const books = row("organize");
    const jobs = row("appointment");
    const win = row("inquiry");
    const paid = row("invoice_draft");
    expect(ids([books, jobs, win, paid])).toEqual([paid.id, win.id, jobs.id, books.id]);
  });

  it("the NOW rows keep the tile order among themselves", () => {
    const won = row("quote_accepted", { level: "now" });
    const late = row("invoice_overdue", { level: "now" });
    expect(ids([won, late])).toEqual([late.id, won.id]);
  });

  it("a Couldn't Check line leads its tile, above its SOON rows", () => {
    const soon = row("receipt_unbilled", { level: "soon", when: "2026-08-01" });
    const unread = row("receipt_unbilled", { id: "receipts-unread" });
    const paid = row("invoice_draft");
    expect(ids([soon, unread, paid])).toEqual([paid.id, unread.id, soon.id]);
  });

  it("within a tile: SOON before no mark, whatever the urgency, then oldest first", () => {
    const plainUrgent = row("invoice_draft", { urgency: 2, when: "2026-08-01" });
    const newer = row("invoice_draft", { level: "soon", when: "2026-09-20" });
    const older = row("invoice_overdue", { level: "soon", when: "2026-08-01" });
    expect(ids([plainUrgent, newer, older])).toEqual([older.id, newer.id, plainUrgent.id]);
  });

  it("urgency is no longer a key: two plain rows sort by their day alone", () => {
    const urgentNewer = row("quote_draft", { urgency: 2, when: "2026-09-20" });
    const calmOlder = row("quote_draft", { urgency: 0, when: "2026-09-01" });
    expect(ids([urgentNewer, calmOlder])).toEqual([calmOlder.id, urgentNewer.id]);
  });

  it("an undated row counts as today: after yesterday's, before tomorrow's", () => {
    const tomorrow = row("supplier_pay", { when: "2026-09-28" });
    const undated = row("supplier_paper", { when: null });
    const yesterday = row("stock_short", { when: "2026-09-26T18:00:00Z" });
    expect(ids([tomorrow, undated, yesterday])).toEqual([yesterday.id, undated.id, tomorrow.id]);
  });

  it("ties keep the build's own order (Supplier Bills, then Pay <Supplier>, where the build put them)", () => {
    const bills = row("supplier_paper", { when: null });
    const pay = row("supplier_pay", { when: null });
    expect(ids([bills, pay])).toEqual([bills.id, pay.id]);
    expect(ids([pay, bills])).toEqual([pay.id, bills.id]);
    const hours = row("time_stray", { when: null });
    const visit = row("appointment", { urgency: 0, when: null });
    expect(ids([hours, visit])).toEqual([hours.id, visit.id]);
  });

  it("the tile is read from the kind when a row was not stamped", () => {
    const bare = row("organize");
    delete (bare as Partial<ActionItem>).group;
    const paid = row("invoice_draft");
    expect(sortActionItems([bare, paid], TODAY).map((i) => i.id)).toEqual([paid.id, bare.id]);
  });

  it("a done row sinks below every open one, whatever its mark", () => {
    const doneNow = row("quote_accepted", { level: "now", done: true });
    const other = row("organize");
    expect(ids([doneNow, other])).toEqual([other.id, doneNow.id]);
  });

  it("never mutates the build's array", () => {
    const a = row("contract_unsigned");
    const b = row("quote_accepted", { level: "now" });
    const input = [a, b];
    sortActionItems(input, TODAY);
    expect(input.map((i) => i.id)).toEqual([a.id, b.id]);
  });
});

describe("the build sorts once, at its return", () => {
  const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");

  it("query.ts stamps each row's tile and mark once, sorts once, then rolls the piles up", () => {
    expect(query).toMatch(
      /const sorted = sortActionItems\(\s*folded\.now\.map\(\(it\) => \(\{ \.\.\.it, group: KIND_GROUP\[it\.kind\], level: levelOf\(it, \{ todayStr, tz \}\) \}\)\),\s*todayStr,\s*\);/,
    );
    // Every row, pile and child leaves through the tech's belt (needs-you-rule withoutMoneyForTech).
    expect(query).toContain("const now = rollUpPiles(sorted, { todayStr, isStaff, leadsOn, counts }).map((it) => withoutMoneyForTech(it, isStaff));");
    expect(query.match(/sortActionItems\(/g)).toHaveLength(1);
    expect(query.match(/levelOf\(/g)).toHaveLength(1);
  });

  it("the list draws the server's order: action-list.tsx never sorts", () => {
    const list = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    expect(list).not.toMatch(/sortActionItems\(/);
    expect(list).not.toMatch(/import[^;]*sortActionItems/);
    expect(list).toContain("const visible = [...shown.filter((i) => !i.done), ...shown.filter((i) => i.done)];");
  });

  it("no component of the Needs You folder sorts: no .sort(, toSorted or localeCompare", () => {
    const dir = join(process.cwd(), "src/components/action-items");
    for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !/\.test\./.test(n))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/\.sort\(|toSorted|localeCompare/);
    }
  });
});
