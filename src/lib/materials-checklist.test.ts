import { describe, expect, it } from "vitest";
import {
  buyMaterials,
  buyMaterialsCounts,
  buyMaterialsTitle,
  checklistGroups,
  isOpenToBuy,
  openToBuyCount,
  toBuyWords,
} from "./materials-checklist";
import { jobTaskTally } from "./job-tasks";

/**
 * THE JOB'S MATERIALS LIST IS A CHECKLIST (Erik, 2026-09-27): open lines on top, checked lines in one
 * Bought fold, the badge counts only what's left to buy, and those open lines are ONE live task.
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
    expect(row).toEqual({ open: 2 });
    expect(buyMaterialsTitle(row!)).toBe("Buy Materials · 2 Open");
    expect(buyMaterialsCounts(row)).toEqual({ total: 1, done: 0, open: 1 });
  });

  it("done once everything to buy is bought: it reads All Bought and counts as one done task", () => {
    const row = buyMaterials(LIST.map((i) => ({ ...i, purchased: true })));
    expect(row).toEqual({ open: 0 });
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
    expect(buyMaterials([...done, line("new one")])).toEqual({ open: 1 });
  });
});

describe("the row inside the job's task count (jobTaskTally)", () => {
  const tasks = [{ status: "open" }, { status: "open" }, { status: "done" }];

  it("counts as ONE open task while anything is left to buy: the Tasks badge and 'X of Y done' agree", () => {
    expect(jobTaskTally(tasks, { open: 5 })).toEqual({ total: 4, done: 1, open: 3 });
  });

  it("counts as one done task once all bought, so 'X of Y done' never shrinks when the buying is done", () => {
    expect(jobTaskTally(tasks, { open: 0 })).toEqual({ total: 4, done: 2, open: 2 });
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
