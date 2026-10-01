import { describe, it, expect } from "vitest";
import {
  inRankPool,
  MY_DAY_POOL_LIMIT,
  pinCarriedFrom,
  PUSH_SIX,
  rankPoolCut,
  rankSix,
  type PoolScope,
  type SixRankTask,
} from "@/lib/six-rank";

/**
 * THE JOURNEY, not the source. Erik, 2026-09-30 (/planner): "lets rework this Today's 6 task
 * organization because the tasks keep disappearing even the pinned ones, I think those reminders
 * should be visible".
 *
 * These cases drive the WHOLE path a reminder takes — the pool the database is asked for, the bound
 * that pool is cut at, and the rank that orders what comes back — through "write it, let the day
 * advance, look again". None of them assert that a file contains a string: a source-text assertion
 * would have passed happily on the broken build, because the broken build's source said exactly what
 * it meant to say. The pool is exercised through lib/six-rank's own arms (inRankPool), which are the
 * same arms it hands the database (rankPoolCut), so this is the real cut and not a copy of it.
 */

/** The pool a reader actually gets back: the cut, then the order the bound cuts in, then the bound. */
function fetchPool(all: SixRankTask[], todayStr: string, scope: PoolScope, limit = MY_DAY_POOL_LIMIT): SixRankTask[] {
  const cmp = (a: SixRankTask, b: SixRankTask) => {
    // focus_date asc, NULLS LAST — every standing pin ahead of everything else, carried first.
    const fa = a.focus_date ?? "￿";
    const fb = b.focus_date ?? "￿";
    if (fa !== fb) return fa < fb ? -1 : 1;
    const pa = Number(a.priority) || 0;
    const pb = Number(b.priority) || 0;
    if (pa !== pb) return pb - pa;
    // due_date asc, NULLS LAST
    const da = a.due_date ?? "￿";
    const db = b.due_date ?? "￿";
    if (da !== db) return da < db ? -1 : 1;
    const ca = String(a.created_at ?? "");
    const cb = String(b.created_at ?? "");
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  };
  return all
    .filter((t) => t.status === "open" && t.parent_id == null && t.job_id == null)
    .filter((t) => inRankPool(t, todayStr, scope))
    .sort(cmp)
    .slice(0, limit);
}

/** What My Day draws on `todayStr`, start to finish. */
const myDay = (all: SixRankTask[], todayStr: string) => rankSix(fetchPool(all, todayStr, "my_day"), { todayStr });
/** What the morning push would name on `todayStr`. */
const push = (all: SixRankTask[], todayStr: string) =>
  rankSix(fetchPool(all, todayStr, "push", 500), { todayStr, slots: PUSH_SIX });

let seq = 0;
const reminder = (over: Partial<SixRankTask> = {}): SixRankTask => ({
  id: `t${++seq}`,
  status: "open",
  priority: 0,
  due_date: null,
  focus_date: null,
  category: "operations",
  job_id: null,
  parent_id: null,
  created_at: `2026-09-${String(10 + (seq % 15)).padStart(2, "0")}T12:00:00Z`,
  ...over,
});

const MON = "2026-09-28";
const TUE = "2026-09-29";
const WED = "2026-09-30";
const NEXT_WEEK = "2026-10-06";

describe("defect 1: a pinned reminder survives the night", () => {
  it("pin it Monday, look on Tuesday, look again next week: it is still the first thing on the card", () => {
    const pin = reminder({ title: "Call the PUD about the meter", focus_date: MON } as Partial<SixRankTask>);
    const all = [pin, reminder({ due_date: MON }), reminder({ priority: 2 })];

    expect(myDay(all, MON)[0].id).toBe(pin.id);
    // The day turns over. Nothing writes to the row — there is no sweeper, by design.
    expect(myDay(all, TUE)[0].id).toBe(pin.id);
    // A week later it is STILL his pin. It was not even fetched before this build.
    expect(myDay(all, NEXT_WEEK)[0].id).toBe(pin.id);
  });

  it("the row is FETCHED at all the next morning — the half of the bug no rank could have fixed", () => {
    const pin = reminder({ focus_date: MON });
    // An undated, priority-0, non-office reminder with a stale pin: under the old cut
    // (focus_date.eq.<today> / due_date.lte.<today> / flagged-undated) it matched no arm on Tuesday,
    // so the query never returned it and nothing downstream could show it.
    expect(inRankPool(pin, MON, "my_day")).toBe(true);
    expect(inRankPool(pin, TUE, "my_day")).toBe(true);
    expect(fetchPool([pin], TUE, "my_day").map((t) => t.id)).toEqual([pin.id]);
  });

  it("the morning push carries the same pin on the same days — one rule, so they cannot disagree", () => {
    const pin = reminder({ focus_date: MON });
    const all = [pin, reminder({ due_date: TUE })];
    for (const day of [MON, TUE, NEXT_WEEK]) {
      expect(push(all, day)[0].id, day).toBe(pin.id);
      expect(myDay(all, day)[0].id, day).toBe(pin.id);
    }
  });

  it("it says WHY it is still there: Carried From is set once the pin is older than today", () => {
    expect(pinCarriedFrom(MON, MON)).toBeNull();
    expect(pinCarriedFrom(MON, TUE)).toBe(MON);
    expect(pinCarriedFrom(null, TUE)).toBeNull();
  });

  it("unpinning is what takes it off, not the clock", () => {
    const pin = reminder({ focus_date: MON });
    expect(myDay([pin], WED).map((t) => t.id)).toEqual([pin.id]);
    const unpinned = { ...pin, focus_date: null };
    // Still VISIBLE (it is one of his open reminders) but no longer leading, and no longer a pin.
    const after = myDay([unpinned, reminder({ due_date: WED })], WED);
    expect(after[0].id).not.toBe(pin.id);
    expect(pinCarriedFrom(unpinned.focus_date, WED)).toBeNull();
  });

  it("checking it off is the other way it goes", () => {
    const done = reminder({ focus_date: MON, status: "done" });
    expect(fetchPool([done], WED, "my_day")).toHaveLength(0);
    expect(myDay([done], WED)).toHaveLength(0);
  });
});

describe("defect 1, the other half: the bound can never be the thing that drops a pin", () => {
  it("one pin behind two hundred dated reminders still comes back, and leads", () => {
    const pin = reminder({ focus_date: MON });
    const noise = Array.from({ length: 200 }, (_, i) =>
      reminder({ due_date: `2026-0${i % 9 === 0 ? 8 : 9}-${String((i % 27) + 1).padStart(2, "0")}` }),
    );
    const pool = fetchPool([...noise, pin], WED, "my_day");
    expect(pool).toHaveLength(MY_DAY_POOL_LIMIT); // the bound still holds — build for millions
    expect(pool[0].id).toBe(pin.id); // but it cut the noise, never the promise
    expect(myDay([...noise, pin], WED)[0].id).toBe(pin.id);
  });

  it("twenty pins and a thousand plain reminders: every pin survives the bound", () => {
    const pins = Array.from({ length: 20 }, (_, i) => reminder({ focus_date: `2026-09-${String(1 + i).padStart(2, "0")}` }));
    const plain = Array.from({ length: 1000 }, () => reminder());
    const pool = fetchPool([...plain, ...pins], WED, "my_day");
    for (const p of pins) expect(pool.map((t) => t.id)).toContain(p.id);
  });
});

describe("defect 2: the list does not shuffle between polls", () => {
  it("seven undated pins, handed over in any order, always come back in the same one", () => {
    const pins = Array.from({ length: 7 }, () => reminder({ focus_date: WED }));
    const want = myDay(pins, WED).map((t) => t.id);
    // A database gives no order to rows that tie, and an UPDATE relocates a row in the heap, so the
    // same query really did come back differently minutes apart. Any permutation, one answer.
    for (const perm of [[...pins].reverse(), [...pins.slice(4), ...pins.slice(0, 4)], [pins[3], ...pins.filter((_, i) => i !== 3)]]) {
      expect(myDay(perm, WED).map((t) => t.id)).toEqual(want);
    }
  });

  it("and nothing drops out of sight while he watches, because nothing is capped", () => {
    const pins = Array.from({ length: 7 }, () => reminder({ focus_date: WED }));
    expect(myDay(pins, WED)).toHaveLength(7);
  });
});

describe("Erik's words: the reminders are VISIBLE", () => {
  it("a plain typed reminder — no date, no flag, no pin — is on the card the moment it exists", () => {
    const typed = reminder({ title: "Pick up the breaker" } as Partial<SixRankTask>);
    expect(inRankPool(typed, WED, "my_day")).toBe(true);
    expect(myDay([typed], WED).map((t) => t.id)).toEqual([typed.id]);
  });

  it("which is what lets the Add line stop stamping a pin: no pin, still visible, still there tomorrow", () => {
    const typed = reminder();
    expect(myDay([typed], WED)).toHaveLength(1);
    expect(myDay([typed], NEXT_WEEK)).toHaveLength(1);
    expect(pinCarriedFrom(typed.focus_date, NEXT_WEEK)).toBeNull(); // and it never pretends to be a pin
  });

  it("a plain undated reminder is NOT pushed to his phone, though: a push names a bounded set", () => {
    const typed = reminder();
    expect(inRankPool(typed, WED, "push")).toBe(false);
    expect(push([typed], WED)).toHaveLength(0);
    expect(rankPoolCut(WED, "push")).toContain("priority.gte.1");
  });

  it("a reminder due NEXT MONTH still waits, so the sheet's promise stays true", () => {
    const later = reminder({ due_date: "2026-11-15" });
    expect(myDay([later], WED)).toHaveLength(0);
    // ...until its day comes.
    expect(myDay([later], "2026-11-15").map((t) => t.id)).toEqual([later.id]);
  });
});
