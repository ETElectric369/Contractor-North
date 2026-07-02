import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { rankSix, SIX_SLOTS, OVERDUE_AUTO_CAP, type SixRankTask } from "@/lib/six-rank";
import { KIND_STREAM, AFFORDANCES } from "@/lib/action-items/types";

// THE BADGE INVARIANT (src/lib/action-items/types.ts): a number on chrome =
// distinct items needing a HUMAN DECISION TODAY that the app cannot defer,
// shown where the deciding happens, display-capped at 9+. No count may be the
// length of an unbounded or undated set. These tests pin the law two ways:
// structurally (the task feeder stays deleted — the "19 badge" can't come back
// by accident) and functionally (the six-slot rank that replaced it).

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

describe("badge economy: the inbox is decisions-only (the task feeder stays dead)", () => {
  const querySrc = src("lib/action-items/query.ts");

  it("never emits kind 'task' or 'work_order' — the feeder and its projection are deleted", () => {
    // Structural: the union must not query tasks at all, nor project the kinds.
    expect(querySrc).not.toContain('.from("tasks")');
    expect(querySrc).not.toContain('kind: "task"');
    expect(querySrc).not.toContain('kind: "work_order"');
  });

  it("no feeder counts an undated set as due-now (the due-now-forever cut is gone)", () => {
    // The old arm `due_date.is.null,due_date.lte.<today>` made every undated
    // task a permanent badge resident. No feeder may resurrect it.
    expect(querySrc).not.toContain("due_date.is.null");
  });

  it("the badge count stays derived from the list (the never-disagree doctrine)", () => {
    expect(querySrc).toContain("(await getActionItems(ctx)).length");
  });

  it("keeps task/work_order in the verb grammar (dispatch + the six's sheet reuse them)", () => {
    // Amendment 6: the KINDS survive even though the feeder died — dispatch.ts
    // resolve() maps (task|work_order, verb) onto the action registry, and the
    // six-slot card's "…" sheet drives snooze/complete through that grammar.
    expect(KIND_STREAM.task).toBeDefined();
    expect(KIND_STREAM.work_order).toBeDefined();
    expect(AFFORDANCES.task).toContain("snooze");
    expect(AFFORDANCES.task).toContain("do");
    expect(AFFORDANCES.work_order).toContain("do");
  });

  it("the dock's chrome badge display-caps at 9+", () => {
    const dockSrc = src("components/app-shell/dock.tsx");
    expect(dockSrc).toContain('badge > 9 ? "9+" : badge');
  });

  it("the morning digest dropped the undated-tasks arm and ranks with THE shared six", () => {
    const digestSrc = src("lib/action-items/digest.ts");
    expect(digestSrc).not.toContain("due_date.is.null");
    // The phone's morning number/read-back must come from the same rank as the
    // planner's six — a parallel cut would drift (phone says 18, app says 4).
    expect(digestSrc).toContain('from "@/lib/six-rank"');
    expect(digestSrc).toContain("rankSix(");
  });
});

// ── rankSix: pinned > fresh-overdue (cap 3) > due-today > on-site > flagged ──

const TODAY = "2026-07-02";
let seq = 0;
const task = (over: Partial<SixRankTask> = {}): SixRankTask => ({
  id: `t${++seq}`,
  status: "open",
  priority: 0,
  due_date: null,
  focus_date: null,
  category: "operations",
  job_id: null,
  parent_id: null,
  ...over,
});

describe("rankSix: slot order", () => {
  it("pinned (focus_date=today) beats everything, even an urgent overdue", () => {
    const overdue = task({ priority: 2, due_date: "2026-07-01" });
    const pinned = task({ priority: 0, focus_date: TODAY });
    const six = rankSix([overdue, pinned], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([pinned.id, overdue.id]);
  });

  it("orders pins by priority desc", () => {
    const p0 = task({ focus_date: TODAY, priority: 0 });
    const p2 = task({ focus_date: TODAY, priority: 2 });
    const p1 = task({ focus_date: TODAY, priority: 1 });
    const six = rankSix([p0, p2, p1], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([p2.id, p1.id, p0.id]);
  });

  it("a stale pin (focus_date=yesterday) does not squat a slot", () => {
    const stalePin = task({ focus_date: "2026-07-01" }); // plain undated otherwise
    const dueToday = task({ due_date: TODAY });
    const six = rankSix([stalePin, dueToday], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([dueToday.id]);
  });

  it("caps overdue auto-fill at 3 so a stale backlog can't own the whole day", () => {
    const overdue = Array.from({ length: 8 }, (_, i) =>
      task({ due_date: `2026-06-${String(10 + i).padStart(2, "0")}` }),
    );
    const six = rankSix(overdue, { todayStr: TODAY });
    expect(six).toHaveLength(OVERDUE_AUTO_CAP);
  });

  it("within overdue: priority desc, then due DESC (a yesterday-miss beats a June-8 zombie)", () => {
    const zombie = task({ priority: 0, due_date: "2026-06-08" });
    const fresh = task({ priority: 0, due_date: "2026-07-01" });
    const flagged = task({ priority: 1, due_date: "2026-06-15" });
    const six = rankSix([zombie, fresh, flagged], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([flagged.id, fresh.id, zombie.id]);
  });

  it("fills the full slot order: pinned → overdue → due-today → on-site → flagged undated", () => {
    const flagged = task({ priority: 1 }); // undated + flagged → rank 5
    const onSite = task({ job_id: "job-1" }); // undated, on today's job → rank 4
    const dueToday = task({ due_date: TODAY }); // rank 3
    const overdue = task({ due_date: "2026-07-01" }); // rank 2
    const pinned = task({ focus_date: TODAY }); // rank 1
    const six = rankSix([flagged, onSite, dueToday, overdue, pinned], {
      todayStr: TODAY,
      scheduledJobIds: new Set(["job-1"]),
    });
    expect(six.map((t) => t.id)).toEqual([pinned.id, overdue.id, dueToday.id, onSite.id, flagged.id]);
  });

  it("an over-cap overdue task on today's site still re-enters via the on-site rank", () => {
    const a = task({ priority: 2, due_date: "2026-07-01" });
    const b = task({ priority: 1, due_date: "2026-07-01" });
    const c = task({ priority: 0, due_date: "2026-07-01" });
    const d = task({ priority: 0, due_date: "2026-06-20", job_id: "job-1" }); // past the cap, but the truck goes there
    const dueToday = task({ due_date: TODAY });
    const six = rankSix([a, b, c, d, dueToday], { todayStr: TODAY, scheduledJobIds: new Set(["job-1"]) });
    expect(six.map((t) => t.id)).toEqual([a.id, b.id, c.id, dueToday.id, d.id]);
  });
});

describe("rankSix: exclusions (what never auto-promotes)", () => {
  it("plain undated tasks never fill a slot, even with all six free", () => {
    const undated = task(); // p0, no due, no pin, no job
    const dueToday = task({ due_date: TODAY });
    const six = rankSix([undated, dueToday], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([dueToday.id]);
  });

  it("excludes office from the flagged-undated rank ONLY (a stated date beats the category)", () => {
    const officeFlagged = task({ category: "office", priority: 2 }); // undated → excluded
    const officeOverdue = task({ category: "office", due_date: "2026-07-01" }); // dated → ranks
    const officeDueToday = task({ category: "office", due_date: TODAY }); // dated → ranks
    const officePinned = task({ category: "office", focus_date: TODAY }); // pin overrides
    const six = rankSix([officeFlagged, officeOverdue, officeDueToday, officePinned], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([officePinned.id, officeOverdue.id, officeDueToday.id]);
  });

  it("subtasks (parent_id set) are never slots — they nest under their parent", () => {
    const child = task({ parent_id: "parent-1", due_date: TODAY, priority: 2 });
    const parent = task({ due_date: TODAY });
    const six = rankSix([child, parent], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([parent.id]);
  });

  it("drops non-open rows defensively", () => {
    const done = task({ status: "done", due_date: "2026-07-01" });
    const six = rankSix([done], { todayStr: TODAY });
    expect(six).toHaveLength(0);
  });
});

describe("rankSix: bounds + stability", () => {
  it("never returns more than SIX_SLOTS", () => {
    const many = Array.from({ length: 12 }, () => task({ due_date: TODAY }));
    expect(rankSix(many, { todayStr: TODAY })).toHaveLength(SIX_SLOTS);
    expect(SIX_SLOTS).toBe(6);
  });

  it("keeps input order on full ties (stable — callers pre-sort by due date)", () => {
    const first = task({ due_date: TODAY });
    const second = task({ due_date: TODAY });
    const six = rankSix([first, second], { todayStr: TODAY });
    expect(six.map((t) => t.id)).toEqual([first.id, second.id]);
  });

  it("never mutates the caller's array", () => {
    const a = task({ due_date: "2026-07-01" });
    const b = task({ focus_date: TODAY });
    const input = [a, b];
    rankSix(input, { todayStr: TODAY });
    expect(input.map((t) => t.id)).toEqual([a.id, b.id]);
  });
});
