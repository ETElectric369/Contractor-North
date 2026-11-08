import { describe, expect, it, vi } from "vitest";
import {
  buyLineName,
  buyLineWords,
  buyMaterials,
  buyMaterialsCounts,
  buyMaterialsTitle,
  ASK_LINE_MAX,
  askLine,
  checklistGroups,
  isOpenToBuy,
  newestListPerJob,
  openToBuyCount,
  tickBuyLine,
  tickWord,
  toBuyWords,
  type BuyLineTickPorts,
  type BuyMaterialsInput,
} from "./materials-checklist";
import { jobTaskTally } from "./job-tasks";

/**
 * THE JOB'S MATERIALS LIST IS A CHECKLIST (Erik, 2026-09-27): open lines on top, checked lines in one
 * Bought fold, the badge counts only what's left to buy, and those open lines are ONE live task.
 * Since 2026-11-07 ("show the materials as sub items right there on that screen") the row carries the
 * open lines themselves, and a tap on one is one tick's round trip (tickBuyLine).
 */
const line = (id: string, over: { purchased?: boolean; is_tool?: boolean } = {}) => ({ id, purchased: false, is_tool: false, ...over });

// A list the way the job's editor gets it (sort_order): two tools, four materials, three checked.
const LIST = [
  line("wire"),
  line("drill", { is_tool: true }),
  line("boxes", { purchased: true }),
  line("plates"),
  line("ladder", { is_tool: true, purchased: true }),
  line("breaker", { purchased: true }),
];

// The way the job page reads the list (TECH_ITEM_COLUMNS): the words, the count, the unit and the slot,
// handed over OUT of order so the lib's own ordering is what the tests see.
const full = (id: string, description: string, quantity: number | string | null, unit: string | null, sort_order: number | null, over: { purchased?: boolean; is_tool?: boolean; list_id?: string | null } = {}): BuyMaterialsInput => ({
  id,
  list_id: "L1",
  description,
  quantity,
  unit,
  sort_order,
  purchased: false,
  is_tool: false,
  ...over,
});
const LINES: BuyMaterialsInput[] = [
  full("m3", "Single-Gang Boxes", "12", "ea", 3),
  full("m1", "12/2 Romex", 250, "ft", 1),
  full("t1", "Hammer Drill", 1, "ea", 0, { is_tool: true }),
  full("m4", "Cover Plates", 6, "ea", null),
  full("m2", "Wire Nuts", 2.0, "ea", 2),
  full("b1", "Breaker 20 A", 1, "ea", 1, { purchased: true }),
  full("m5", "Anchors", 0, "ea", null),
];

describe("what a line means", () => {
  it("open to buy: not checked and not a tool (a tool comes from the shop)", () => {
    expect(isOpenToBuy(line("a"))).toBe(true);
    expect(isOpenToBuy(line("a", { purchased: true }))).toBe(false);
    expect(isOpenToBuy(line("a", { is_tool: true }))).toBe(false);
    expect(isOpenToBuy({})).toBe(true); // a line with neither column set is a new, unchecked line
  });

  it("the badge is the open count, never the list's size; nothing open = 0 = no badge", () => {
    expect(openToBuyCount(LIST)).toBe(2);
    expect(openToBuyCount([])).toBe(0);
    expect(openToBuyCount(null)).toBe(0);
    expect(openToBuyCount([line("a", { purchased: true }), line("t", { is_tool: true })])).toBe(0);
  });
});

describe("the checklist's grouping", () => {
  it("tools to grab, then materials to buy, then every checked line in Bought, each in list order", () => {
    const g = checklistGroups(LIST);
    expect(g.tools.map((i) => i.id)).toEqual(["drill"]);
    expect(g.toBuy.map((i) => i.id)).toEqual(["wire", "plates"]);
    expect(g.bought.map((i) => i.id)).toEqual(["boxes", "ladder", "breaker"]);
  });

  it("unchecking a line brings it back up, in its own place", () => {
    const back = LIST.map((i) => (i.id === "boxes" ? { ...i, purchased: false } : i));
    const g = checklistGroups(back);
    expect(g.toBuy.map((i) => i.id)).toEqual(["wire", "boxes", "plates"]);
    expect(g.bought.map((i) => i.id)).toEqual(["ladder", "breaker"]);
  });

  it("never loses or doubles a line", () => {
    const g = checklistGroups(LIST);
    expect(g.tools.length + g.toBuy.length + g.bought.length).toBe(LIST.length);
  });
});

describe("the live Buy Materials row", () => {
  it("open while anything is left to buy, with the count in its words", () => {
    const row = buyMaterials(LIST);
    expect(row).toMatchObject({ open: 2 });
    expect(row!.lines.map((l) => l.id)).toEqual(["wire", "plates"]);
    expect(buyMaterialsTitle(row!)).toBe("Buy Materials · 2 Open");
    expect(buyMaterialsCounts(row)).toEqual({ total: 1, done: 0, open: 1 });
  });

  it("done once everything to buy is bought: it reads All Bought and counts as one done task", () => {
    const row = buyMaterials(LIST.map((i) => ({ ...i, purchased: true })));
    expect(row).toEqual({ open: 0, lines: [] });
    expect(buyMaterialsTitle(row!)).toBe("Buy Materials · All Bought");
    expect(buyMaterialsCounts(row)).toEqual({ total: 1, done: 1, open: 0 });
  });

  it("no row at all for an empty list, or a list of tools only", () => {
    expect(buyMaterials([])).toBeNull();
    expect(buyMaterials(null)).toBeNull();
    expect(buyMaterials([line("drill", { is_tool: true })])).toBeNull();
    expect(buyMaterialsCounts(null)).toEqual({ total: 0, done: 0, open: 0 });
  });

  it("a new line on a finished list reopens it", () => {
    const done = LIST.map((i) => ({ ...i, purchased: true }));
    const row = buyMaterials([...done, line("new one")]);
    expect(row).toMatchObject({ open: 1 });
    expect(row!.lines.map((l) => l.id)).toEqual(["new one"]);
  });
});

describe("the row inside the job's task count (jobTaskTally)", () => {
  const tasks = [{ status: "open" }, { status: "open" }, { status: "done" }];

  it("counts as ONE open task while anything is left to buy: the Tasks badge and 'X of Y done' agree", () => {
    expect(jobTaskTally(tasks, { open: 5, lines: [] })).toEqual({ total: 4, done: 1, open: 3 });
    // The lines the row carries since 2026-11-07 change nothing here: the row is still ONE task.
    expect(jobTaskTally(tasks, buyMaterials(LINES)!)).toEqual({ total: 4, done: 1, open: 3 });
  });

  it("counts as one done task once all bought, so 'X of Y done' never shrinks when the buying is done", () => {
    expect(jobTaskTally(tasks, { open: 0, lines: [] })).toEqual({ total: 4, done: 2, open: 2 });
  });

  it("adds nothing when there is nothing to buy", () => {
    expect(jobTaskTally(tasks, null)).toEqual({ total: 3, done: 1, open: 2 });
    expect(jobTaskTally([], null)).toEqual({ total: 0, done: 0, open: 0 });
  });
});

describe("the plain words under a list", () => {
  it("says what is left, or that nothing is", () => {
    expect(toBuyWords(3)).toBe("3 to buy");
    expect(toBuyWords(0)).toBe("Nothing left to buy");
  });
});

describe("what a tick means, said", () => {
  it("a tool is got from the shop, never bought; a material is bought", () => {
    expect(tickWord({ is_tool: true })).toBe("Got");
    expect(tickWord({ is_tool: false })).toBe("Bought");
    expect(tickWord({})).toBe("Bought");
  });
});

describe("the job's list, among every list on a set of jobs", () => {
  const L = (id: string, job_id: string | null, created_at: string) => ({ id, job_id, created_at });

  it("the newest per job, whatever order the rows come in", () => {
    const rows = [L("a", "j1", "2026-09-01T00:00:00Z"), L("b", "j1", "2026-09-20T00:00:00Z"), L("c", "j2", "2026-09-05T00:00:00Z")];
    for (const order of [rows, [...rows].reverse()]) {
      const m = newestListPerJob(order);
      expect(m.get("j1")?.id).toBe("b");
      expect(m.get("j2")?.id).toBe("c");
      expect(m.size).toBe(2);
    }
  });

  it("a created_at tie goes to the higher id (canonicalListIdForJob's order), and a list with no job is skipped", () => {
    const t = "2026-09-20T00:00:00Z";
    expect(newestListPerJob([L("a1", "j1", t), L("b2", "j1", t)]).get("j1")?.id).toBe("b2");
    expect(newestListPerJob([L("b2", "j1", t), L("a1", "j1", t)]).get("j1")?.id).toBe("b2");
    expect(newestListPerJob([L("x", null, t)]).size).toBe(0);
    expect(newestListPerJob(null).size).toBe(0);
  });
});

describe("a Tell the Office ask, as a line", () => {
  it("a short ask is the line, folded onto one line", () => {
    expect(askLine("  Two 3-gang faceplates \n need them tomorrow ")).toBe("Two 3-gang faceplates need them tomorrow");
  });

  it("a long one is cut to a line's length, at a word, and marked", () => {
    const long = "Need two 3-gang faceplates and a box of wire nuts for the kitchen, plus the 12-2 won't reach the far wall so bring another 250 ft roll by tomorrow morning please";
    const line = askLine(long);
    expect(line.length).toBeLessThanOrEqual(ASK_LINE_MAX);
    expect(line.endsWith("…")).toBe(true);
    expect(long.startsWith(line.slice(0, -1))).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/\s$/);
    // No word near the end: a hard cut, still within the length.
    expect(askLine("x".repeat(500))).toBe(`${"x".repeat(ASK_LINE_MAX - 1)}…`);
  });
});

describe("the open lines ride the row (Erik, 2026-11-07: the materials as sub items right there)", () => {
  it("carries every open line to buy, in the list's order (sort_order, a line with none last, then the words)", () => {
    const row = buyMaterials(LINES)!;
    expect(row.open).toBe(5);
    expect(row.lines.map((l) => l.id)).toEqual(["m1", "m2", "m3", "m5", "m4"]);
    expect(row.lines[0]).toEqual({ id: "m1", list_id: "L1", description: "12/2 Romex", quantity: 250, unit: "ft" });
    // A numeric that arrived as a string is a number on the line.
    expect(row.lines[2]).toEqual({ id: "m3", list_id: "L1", description: "Single-Gang Boxes", quantity: 12, unit: "ea" });
  });

  it("never a tool (grabbed from the shop) and never a bought line: the same rule as the count", () => {
    const ids = buyMaterials(LINES)!.lines.map((l) => l.id);
    expect(ids).not.toContain("t1");
    expect(ids).not.toContain("b1");
    for (const list of [LINES, LIST, [full("x", "One", 1, "ea", 0)], [full("x", "One", 1, "ea", 0, { purchased: true }), full("t", "Tool", 1, "ea", 0, { is_tool: true })]]) {
      const row = buyMaterials(list);
      expect(row?.open ?? 0).toBe(openToBuyCount(list));
    }
  });

  it("the order is the lib's, not the read's", () => {
    const a = buyMaterials(LINES)!.lines.map((l) => l.id);
    const b = buyMaterials([...LINES].reverse())!.lines.map((l) => l.id);
    expect(b).toEqual(a);
  });

  it("a line read without an id is counted but not drawn (My Day's Now card reads only purchased and is_tool)", () => {
    const row = buyMaterials([{ purchased: false, is_tool: false }, { purchased: false, is_tool: false }, { purchased: true, is_tool: false }])!;
    expect(row.open).toBe(2);
    expect(row.lines).toEqual([]);
    expect(buyMaterialsTitle(row)).toBe("Buy Materials · 2 Open");
    expect(buyMaterialsCounts(row)).toEqual({ total: 1, done: 0, open: 1 });
  });

  it("the row's own words and count are what they were: one task, open or done", () => {
    const row = buyMaterials(LINES)!;
    expect(buyMaterialsTitle(row)).toBe("Buy Materials · 5 Open");
    expect(buyMaterialsCounts(row)).toEqual({ total: 1, done: 0, open: 1 });
    const done = buyMaterials(LINES.map((l) => ({ ...l, purchased: true })))!;
    expect(done).toEqual({ open: 0, lines: [] });
    expect(buyMaterialsTitle(done)).toBe("Buy Materials · All Bought");
  });

  it("a missing or blank quantity is null on the line, a blank list id null", () => {
    const row = buyMaterials([full("q", "Staples", null, "box", 0, { list_id: null }), full("e", "Tape", "", "roll", 1), full("w", "Odd", "lots", "ea", 2)])!;
    expect(row.lines.map((l) => [l.id, l.quantity, l.list_id])).toEqual([
      ["q", null, null],
      ["e", null, "L1"],
      ["w", null, "L1"],
    ]);
  });
});

describe("a sub-row's words", () => {
  it("the description, the count the way a person says it, and the unit: never a trailing .00", () => {
    expect(buyLineWords({ description: "12/2 Romex", quantity: 250, unit: "ft" })).toBe("12/2 Romex · 250 ft");
    expect(buyLineWords({ description: "Wire Nuts", quantity: 2, unit: "ea" })).toBe("Wire Nuts · 2 ea");
    expect(buyLineWords({ description: "Wire Nuts", quantity: 2.0, unit: "ea" })).toBe("Wire Nuts · 2 ea");
    expect(buyLineWords({ description: "Conduit", quantity: 12.5, unit: "ft" })).toBe("Conduit · 12.5 ft");
  });

  it("no count (null or 0): the description alone; no unit: the count alone", () => {
    expect(buyLineWords({ description: "Wire Nuts", quantity: null, unit: "ea" })).toBe("Wire Nuts");
    expect(buyLineWords({ description: "Wire Nuts", quantity: 0, unit: "ea" })).toBe("Wire Nuts");
    expect(buyLineWords({ description: "Wire Nuts", quantity: 2, unit: null })).toBe("Wire Nuts · 2");
    expect(buyLineWords({ description: "Wire Nuts", quantity: 2, unit: "  " })).toBe("Wire Nuts · 2");
  });

  it("the words are the list's own, trimmed, never re-cased; a line with no description is its count", () => {
    expect(buyLineWords({ description: "  wire nuts, the red ones ", quantity: 2, unit: "ea" })).toBe("wire nuts, the red ones · 2 ea");
    expect(buyLineWords({ description: null, quantity: 2, unit: "ea" })).toBe("2 ea");
    expect(buyLineWords({ description: "", quantity: null, unit: null })).toBe("");
  });

  it("what a tick names: the description, or the whole line when there is none, so nothing is ever 'Bought: '", () => {
    expect(buyLineName({ description: "12/2 Romex", quantity: 250, unit: "ft" })).toBe("12/2 Romex");
    expect(buyLineName({ description: "  ", quantity: 2, unit: "ea" })).toBe("2 ea");
  });
});

describe("a sub-row's tap: one tick's round trip (tickBuyLine), the write handed in", () => {
  const LINE = { id: "m1", list_id: "L1" };
  const WORDS = { ticked: "Bought: 12/2 Romex", undo: "Undo", failed: "Could not update.", offline: "Couldn't reach the server. Try again." };
  const ports = (write: BuyLineTickPorts["write"]) => ({ write: vi.fn(write), show: vi.fn(), say: vi.fn(), refresh: vi.fn(), words: WORDS });
  const undoOf = (p: ReturnType<typeof ports>) => p.say.mock.calls[0][2] as { label: string; onClick: () => void };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("a tick that lands: struck first, the editor's write with (id, list, true), the sentence with its Undo, the page re-read", async () => {
    const p = ports(async () => ({ ok: true }));
    await expect(tickBuyLine(LINE, true, p)).resolves.toBe(true);
    expect(p.write).toHaveBeenCalledTimes(1);
    expect(p.write).toHaveBeenCalledWith("m1", "L1", true);
    expect(p.show.mock.calls).toEqual([[true]]);
    expect(p.show.mock.invocationCallOrder[0]).toBeLessThan(p.write.mock.invocationCallOrder[0]);
    expect(p.say).toHaveBeenCalledTimes(1);
    expect(p.say.mock.calls[0][0]).toBe("Bought: 12/2 Romex");
    expect(p.say.mock.calls[0][1]).toBe("success");
    expect(undoOf(p).label).toBe("Undo");
    expect(p.refresh).toHaveBeenCalledTimes(1);
  });

  it("its Undo is the same round trip the other way, quiet when it lands", async () => {
    const p = ports(async () => ({ ok: true }));
    await tickBuyLine(LINE, true, p);
    undoOf(p).onClick();
    await flush();
    expect(p.write).toHaveBeenLastCalledWith("m1", "L1", false);
    expect(p.show.mock.calls).toEqual([[true], [false]]);
    expect(p.say).toHaveBeenCalledTimes(1);
    expect(p.refresh).toHaveBeenCalledTimes(2);
  });

  it("a refusal puts the line back and says the write's own sentence; nothing is re-read", async () => {
    const p = ports(async () => ({ ok: false, error: "You don't have permission to change this list." }));
    await expect(tickBuyLine(LINE, true, p)).resolves.toBe(false);
    expect(p.show.mock.calls).toEqual([[true], [false]]);
    expect(p.say.mock.calls).toEqual([["You don't have permission to change this list.", "error"]]);
    expect(p.refresh).not.toHaveBeenCalled();
  });

  it("a refusal with no words says the plain one; a server it couldn't reach says so", async () => {
    const quiet = ports(async () => ({ ok: false }));
    await tickBuyLine(LINE, true, quiet);
    expect(quiet.say.mock.calls).toEqual([["Could not update.", "error"]]);
    const down = ports(async () => {
      throw new Error("fetch failed");
    });
    await expect(tickBuyLine(LINE, true, down)).resolves.toBe(false);
    expect(down.show.mock.calls).toEqual([[true], [false]]);
    expect(down.say.mock.calls).toEqual([["Couldn't reach the server. Try again.", "error"]]);
  });

  it("an Undo the server refuses leaves the line struck and says why", async () => {
    let n = 0;
    const p = ports(async () => (++n === 1 ? { ok: true } : { ok: false, error: "Signed out." }));
    await tickBuyLine(LINE, true, p);
    undoOf(p).onClick();
    await flush();
    expect(p.show.mock.calls).toEqual([[true], [false], [true]]);
    expect(p.say.mock.calls[1]).toEqual(["Signed out.", "error"]);
    expect(p.refresh).toHaveBeenCalledTimes(1);
  });

  it("a line read without a list id still writes (the row is found by its id; the list id only names a page to re-read)", async () => {
    const p = ports(async () => ({ ok: true }));
    await tickBuyLine({ id: "m9", list_id: null }, true, p);
    expect(p.write).toHaveBeenCalledWith("m9", "", true);
  });
});
