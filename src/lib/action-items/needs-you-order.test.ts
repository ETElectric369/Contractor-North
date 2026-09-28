import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIND_STREAM, STREAM_ORDER, sortActionItems, type ActionItem, type ActionKind } from "./types";

/**
 * NEEDS YOU'S ONE ORDER (Wave 1, NY-list): sorted ONCE, inside the build, so every reader reads one
 * order. Not done first; then money, leads, today, other; then urgency, high first; then when,
 * oldest first, with an undated row counting as today; ties keep the build's own order. The piles
 * roll up after it (piles.ts), each in its most pressing child's place.
 */
const TODAY = "2026-09-27";
let seq = 0;
const row = (kind: ActionKind, o: Partial<ActionItem> = {}): ActionItem => ({
  id: `r${++seq}`,
  kind,
  stream: KIND_STREAM[kind],
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
  it("the stream comes first: a money row at urgency 0 sorts above a today row at urgency 2", () => {
    const today2 = row("job_to_schedule", { urgency: 2 });
    const money0 = row("invoice_draft", { urgency: 0 });
    expect(ids([today2, money0])).toEqual([money0.id, today2.id]);
  });

  it("money, leads, today, other: the rank ends in other, not waiting", () => {
    expect(STREAM_ORDER).toEqual(["money", "leads", "today", "other"]);
    const other = row("contract_unsigned");
    const today = row("appointment");
    const lead = row("inquiry");
    const money = row("quote_accepted");
    expect(ids([other, today, lead, money])).toEqual([money.id, lead.id, today.id, other.id]);
  });

  it("within a stream: urgency high first, then oldest first", () => {
    const newer = row("invoice_overdue", { urgency: 1, when: "2026-09-20" });
    const older = row("invoice_overdue", { urgency: 1, when: "2026-08-01" });
    const urgent = row("invoice_overdue", { urgency: 2, when: "2026-09-25" });
    expect(ids([newer, older, urgent])).toEqual([urgent.id, older.id, newer.id]);
  });

  it("an undated row counts as today: after yesterday's, before tomorrow's", () => {
    const tomorrow = row("supplier_pay", { when: "2026-09-28" });
    const undated = row("supplier_paper", { when: null });
    const yesterday = row("invoice_draft", { when: "2026-09-26T18:00:00Z" });
    expect(ids([tomorrow, undated, yesterday])).toEqual([yesterday.id, undated.id, tomorrow.id]);
  });

  it("ties keep the build's own order (Supplier Bills, then Pay <Supplier>, where the build put them)", () => {
    const bills = row("supplier_paper", { urgency: 1, when: null });
    const pay = row("supplier_pay", { urgency: 1, when: null });
    const hours = row("time_stray", { urgency: 1, when: null });
    expect(ids([bills, pay])).toEqual([bills.id, pay.id]);
    expect(ids([pay, bills])).toEqual([pay.id, bills.id]);
    expect(ids([hours, row("appointment", { urgency: 0 })])[0]).toBe(hours.id);
  });

  it("a done row sinks below every open one, whatever its stream", () => {
    const doneMoney = row("quote_accepted", { urgency: 2, done: true });
    const other = row("lien_deadline", { urgency: 0 });
    expect(ids([doneMoney, other])).toEqual([other.id, doneMoney.id]);
  });

  it("never mutates the build's array", () => {
    const a = row("contract_unsigned");
    const b = row("quote_accepted");
    const input = [a, b];
    sortActionItems(input, TODAY);
    expect(input.map((i) => i.id)).toEqual([a.id, b.id]);
  });
});

describe("the build sorts once, at its return", () => {
  const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");

  it("query.ts sorts once, stamped with its streams, then rolls the piles up (a pile sits where its most pressing child sat)", () => {
    expect(query).toMatch(/const sorted = sortActionItems\(\s*folded\.now\.map\(\(it\) => \(\{ \.\.\.it, stream: KIND_STREAM\[it\.kind\] \}\)\),\s*todayStr,\s*\);/);
    expect(query).toContain("const now = rollUpPiles(sorted, { todayStr, isStaff, leadsOn, counts });");
    expect(query.match(/sortActionItems\(/g)).toHaveLength(1);
  });

  it("the list draws the server's order: action-list.tsx never sorts", () => {
    const list = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    expect(list).not.toMatch(/sortActionItems\(/);
    expect(list).not.toMatch(/import[^;]*sortActionItems/);
    expect(list).toContain("const visible = [...shown.filter((i) => !i.done), ...shown.filter((i) => i.done)];");
  });
});
