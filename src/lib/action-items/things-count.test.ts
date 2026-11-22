import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AFFORDANCES, KIND_GROUP, sortActionItems, type ActionItem, type ActionKind } from "./types";
import { levelOf, summarize, thingsOf, withPlus } from "./needs-you-rule";
import { rollUpPiles } from "./piles";
import { AGING_KINDS, OLDER_AFTER_DAYS, agesOut, isOlder, splitKeptCount } from "./older";
import { needsYouWithoutCarried } from "@/lib/schedule/carried-over";

/**
 * EVERY NEEDS YOU NUMBER COUNTS THINGS, AND OLD ROWS STEP ASIDE (cn-v1175, lane COUNT).
 *
 * The owner, on My Day: "it says 3 above and there are a bunch down there so how is this number getting
 * calculated?" The tile said 3 over eight rows, because a pile counted as one. His two picks: every
 * Needs You number counts THINGS; an unanswered visit, write-up or unsent draft stops being counted after
 * 30 days and moves to a grey Older fold, still listed with its buttons; a new lead never ages out.
 * Dates are handed in; every name is a stand-in.
 */

const TODAY = "2026-11-21";
const TZ = "America/Los_Angeles";
const ago = (n: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

type Raw = Omit<ActionItem, "group">;
const raw = (kind: ActionKind, id: string, o: Partial<Raw> = {}): Raw => ({
  id,
  kind,
  title: `${kind} ${id}`,
  when: null,
  urgency: 0,
  done: false,
  href: `/x/${id}`,
  affordances: AFFORDANCES[kind],
  ...o,
});

/** What the build does at its end: stamp, sort, roll the piles, split the Older fold off. */
function build(rows: Raw[], facts: Partial<Parameters<typeof rollUpPiles>[1]> = {}) {
  const sorted = sortActionItems(
    rows.map((it) => ({ ...it, group: KIND_GROUP[it.kind], level: levelOf(it, { todayStr: TODAY, tz: TZ }) })),
    TODAY,
  );
  const rolled = rollUpPiles(sorted, { todayStr: TODAY, isStaff: true, ...facts });
  return { now: rolled.filter((r) => !r.older), older: rolled.filter((r) => !!r.older) };
}

describe("thingsOf: a pile is its count, any other row is one", () => {
  const pile = (count: number, capped: boolean) =>
    ({ pile: { name: "visits_to_close_out", label: "Visits to Close Out", count, capped, listHref: null, listLabel: null, verb: "Close Out" } }) as Pick<ActionItem, "pile">;
  it.each([
    ["a plain row", {}, { n: 1, plus: false }],
    ["a pile of five", pile(5, false), { n: 5, plus: false }],
    ["a pile whose exact count is past what it drew", pile(83, false), { n: 83, plus: false }],
    ["a capped pile", pile(50, true), { n: 50, plus: true }],
  ] as const)("%s", (_name, row, want) => {
    expect(thingsOf(row as Pick<ActionItem, "pile">)).toEqual(want);
  });
  it("a number with its floor", () => {
    expect(withPlus(50, true)).toBe("50+");
    expect(withPlus(8, false)).toBe("8");
  });
});

describe("OLDER: one pure rule, dated by argument", () => {
  it("only a visit to close out, an inspection to write up and an unsent draft age out", () => {
    expect([...AGING_KINDS].sort()).toEqual(["appointment", "inspection_writeup", "quote_draft"]);
    for (const k of Object.keys(AFFORDANCES) as ActionKind[]) expect(agesOut(k), k).toBe(AGING_KINDS.includes(k));
    expect(OLDER_AFTER_DAYS).toBe(30);
  });

  it.each([
    ["a visit 29 days ago", "appointment", `${ago(29)}T17:00:00Z`, false],
    ["a visit 30 days ago", "appointment", `${ago(30)}T17:00:00Z`, true],
    ["a write-up 45 days ago", "inspection_writeup", `${ago(45)}T16:00:00Z`, true],
    ["a draft written 31 days ago", "quote_draft", `${ago(31)}T20:00:00Z`, true],
    ["a draft written 3 days ago", "quote_draft", `${ago(3)}T20:00:00Z`, false],
    ["a new lead 90 days old never ages out", "inquiry", ago(90), false],
    ["a late invoice never ages out", "invoice_overdue", ago(90), false],
    ["a job needing a day never ages out", "job_to_schedule", ago(90), false],
    ["no day is never older", "appointment", null, false],
  ] as const)("%s", (_name, kind, day, want) => {
    expect(isOlder(kind, day, { todayStr: TODAY, tz: TZ })).toBe(want);
  });

  it("the day is the company's: 2026-10-23 at 5:30 PM in the company's zone is 29 days, not 30", () => {
    // 2026-10-24T00:30Z is still the 23rd at 5:30 PM Pacific.
    expect(isOlder("appointment", "2026-10-24T00:30:00Z", { todayStr: TODAY, tz: TZ })).toBe(false);
    expect(isOlder("appointment", "2026-10-22T17:00:00Z", { todayStr: TODAY, tz: TZ })).toBe(true);
  });
});

describe("splitKeptCount: a short read leaves the right half short", () => {
  const read = (n: number, count?: number) => ({ data: Array.from({ length: n }), count });
  it.each([
    ["nothing short, both halves under the draw", read(30, 30), { fresh: 10, older: 12 }, 50, "oldestFirst", false, { fresh: {}, older: {} }],
    ["nothing short, the board half kept more than it draws", read(120, 120), { fresh: 70, older: 20 }, 50, "oldestFirst", false, { fresh: { total: 70 }, older: {} }],
    ["oldest first, cut inside the fresh rows: only the board half is short", read(200, 260), { fresh: 40, older: 90 }, 50, "oldestFirst", false, { fresh: { capped: true }, older: { total: 90 } }],
    ["oldest first, every row read was older: both halves short", read(200, 260), { fresh: 0, older: 150 }, 50, "oldestFirst", true, { fresh: { capped: true }, older: { capped: true } }],
    ["newest first, cut inside the older rows: only the older half is short", read(100, 140), { fresh: 12, older: 60 }, null, "newestFirst", true, { fresh: {}, older: { capped: true } }],
    ["newest first, every row read was fresh: both halves short", read(100, 140), { fresh: 90, older: 0 }, null, "newestFirst", false, { fresh: { capped: true }, older: { capped: true } }],
  ] as const)("%s", (_name, r, kept, drawn, order, edge, want) => {
    expect(splitKeptCount(r, kept, drawn, order, edge)).toEqual(want);
  });
});

describe("one fixture: badge = header = the tiles plus Act Today, and the Older fold counts in none of them", () => {
  // The owner's screen, rebuilt: five visits to close out (two of them older), one job on hold, two jobs
  // needing a day, three drafts (one older), one lead, three late invoices thirty days past (NOW).
  const rows: Raw[] = [
    raw("appointment", "appt-1", { when: `${ago(2)}T17:00:00Z` }),
    raw("appointment", "appt-2", { when: `${ago(5)}T17:00:00Z` }),
    raw("appointment", "appt-3", { when: `${ago(9)}T17:00:00Z` }),
    raw("appointment", "appt-4", { when: `${ago(40)}T17:00:00Z`, older: true }),
    raw("appointment", "appt-5", { when: `${ago(61)}T17:00:00Z`, older: true }),
    raw("job_on_hold", "onhold-j1", { since: ago(4) }),
    raw("job_to_schedule", "j-900", { since: ago(6) }),
    raw("job_to_schedule", "j-901", { since: ago(8) }),
    raw("quote_draft", "qdraft-1", { when: ago(4), amount: 1200 }),
    raw("quote_draft", "qdraft-2", { when: ago(12), amount: 800 }),
    raw("quote_draft", "qdraft-3", { when: ago(44), amount: 300, older: true }),
    raw("inquiry", "lead-1", { since: ago(1), clock: ago(1) }),
    raw("invoice_overdue", "inv-1", { when: ago(40), urgency: 2, amount: 500 }),
    raw("invoice_overdue", "inv-2", { when: ago(35), urgency: 2, amount: 700 }),
    raw("invoice_overdue", "inv-3", { when: ago(31), urgency: 2, amount: 900 }),
  ];
  const { now, older } = build(rows, { leadsOn: true, counts: { estimates_not_sent: {}, visits_to_close_out: {} }, olderCounts: {} });
  const s = summarize(now, { isStaff: true });

  it("each number, said", () => {
    // Act Today: a pile of three late invoices.
    expect(s.now).toBe(3);
    // Sales: two drafts and one lead. Operations: three visits, one hold, two jobs. Get Paid and
    // Bookkeeping: nothing but the strip's invoices, which are never counted in a tile.
    expect(s.tiles.map((t) => [t.group, t.count])).toEqual([
      ["get_paid", 0],
      ["win_work", 3],
      ["run_jobs", 6],
      ["keep_books", 0],
    ]);
    expect(s.total).toBe(12);
    expect(s.now + s.soon + s.more).toBe(s.total);
    expect(s.tiles.reduce((n, t) => n + t.count, 0) + s.now).toBe(s.total);
    // Older (3): two visits and a draft, in their own piles, none on the board.
    expect(older.map((r) => r.id).sort()).toEqual(["pile:visits_to_close_out:older", "qdraft-3"]);
    expect(older.reduce((n, r) => n + thingsOf(r).n, 0)).toBe(3);
    expect(now.some((r) => r.older || (r.children ?? []).some((c) => c.older))).toBe(false);
  });

  it("the badge is that same total: getActionItemsCount reads summarize over the build's Now list", () => {
    const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    expect(query).toContain("return summarize((await getActionItems(ctx)).now, { isStaff: ctx.isStaff }).total;");
    // The board's header and tiles read the same function over the same list (action-list.tsx).
    const list = readFileSync(join(process.cwd(), "src/components/action-items/action-list.tsx"), "utf8");
    expect(list).toContain("const summary = summarize(");
    expect(list).not.toMatch(/\.length\s*\}\s*\/>/);
  });

  it("a pile whose half is older keeps its own facts: the board's pile is never inflated by the fold's", () => {
    const visits = Array.from({ length: 3 }, (_, i) => raw("appointment", `v${i}`, { when: `${ago(40 + i)}T17:00:00Z`, older: true }));
    const fresh = [raw("appointment", "f1", { when: `${ago(1)}T17:00:00Z` }), raw("appointment", "f2", { when: `${ago(2)}T17:00:00Z` })];
    const b = build([...visits, ...fresh], { counts: { visits_to_close_out: {} }, olderCounts: { visits_to_close_out: { capped: true } } });
    expect(b.now.map((r) => r.pile && [r.id, r.pile.count, r.pile.capped])).toEqual([["pile:visits_to_close_out", 2, false]]);
    expect(b.older.map((r) => r.pile && [r.id, r.pile.count, r.pile.capped])).toEqual([["pile:visits_to_close_out:older", 3, true]]);
  });
});

describe("a carried-over job is cut BEFORE the roll-up (C2)", () => {
  it("inside a pile of jobs needing a day, the carried job leaves the pile and the count", () => {
    const jobs = [raw("job_to_schedule", "j-900", { since: ago(3) }), raw("job_to_schedule", "j-901", { since: ago(9) }), raw("job_to_schedule", "j-902", { since: ago(12) })];
    const cut = needsYouWithoutCarried(jobs, new Set(["j-900"]));
    const { now } = build(cut, { counts: { jobs_needing_a_day: {} } });
    expect(now).toHaveLength(1);
    expect(now[0].pile?.count).toBe(2);
    expect(now[0].children?.map((c) => c.id)).toEqual(["j-902", "j-901"]);
    expect(summarize(now, { isStaff: true }).total).toBe(2);
  });

  it("the build does it, and the page no longer cuts its own copy", () => {
    const query = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    const cutAt = query.indexOf("needsYouWithoutCarried(items, carried)");
    expect(cutAt).toBeGreaterThan(0);
    expect(cutAt).toBeLessThan(query.indexOf("rollUpPiles(sorted"));
    const page = readFileSync(join(process.cwd(), "src/app/(app)/planner/page.tsx"), "utf8");
    expect(page).not.toContain("needsYouWithoutCarried(");
  });
});
