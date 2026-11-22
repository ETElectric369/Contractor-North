import { describe, it, expect, vi } from "vitest";

/**
 * THE HOLDS BACK PILE ON SHIP DAY (Wave 1 seam fix; re-pinned for the redraw, cn-v1161). 0366 has no
 * backfill, so the holds with no day are the ones from before it, the oldest on the list. Their rows
 * were built with since = their day (null), and the old pips read an empty since as age 0: every old
 * hold drew a grey "new" pip. A no-day hold now ages from its last touch (`since`); its words stay
 * "No Day Set". The pips are gone. Since cn-v1162 a hold is Due (SOON) only on its own CLOCK: the
 * come-back day somebody picked, from the day it came through seven days after. A hold with no day has
 * no clock and is plain; its last touch orders it (oldest first) and marks nothing.
 *
 * RE-PINNED ON PURPOSE (cn-v1179, decision D): a hold with NO day is no longer a Now row. It waits in
 * the Waiting fold, saying its reason and No Day Set, after every row that has a day, and counts in no
 * number. Only a database without the hold-day columns (before 0366) keeps the old rule.
 */

// A fixed day: the test reads no clock.
const TODAY = "2026-11-11";
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();

const state = vi.hoisted(() => ({ held: [] as any[], legacy: false }));

/** Every read answers empty, except the held-jobs read, told apart by its select. `legacy`: the
 *  database has no hold-day columns (before 0366), so the read naming them fails as Postgres would. */
function fakeClient() {
  const answer = (table: string, cols: string) => {
    if (table === "jobs" && cols.includes("hold_reason") && cols.includes("hold_until")) return state.legacy ? { missing: true } : state.held;
    if (table === "jobs" && cols.includes("hold_reason") && state.legacy) return state.held;
    if (table === "profiles") return { org_id: "org-1", role: "owner" };
    return [];
  };
  const chain = (table: string) => {
    let cols = "";
    const q: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const data = answer(table, cols);
            if (data && (data as any).missing) return (ok: any, err: any) => Promise.resolve({ data: null, error: { code: "42703", message: "column jobs.hold_until does not exist" }, count: null }).then(ok, err);
            const rows = Array.isArray(data) ? data : [];
            return (ok: any, err: any) => Promise.resolve({ data: Array.isArray(data) ? rows : data, error: null, count: rows.length }).then(ok, err);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              const data = answer(table, cols);
              return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
            };
          }
          if (prop === "select") {
            return (c?: string) => {
              cols = c ?? "";
              return q;
            };
          }
          return () => q;
        },
      },
    );
    return q;
  };
  return { from: (table: string) => chain(table), rpc: () => chain("rpc") };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { getActionItems, getActionItemsCount } from "./query";
import { summarize } from "./needs-you-rule";
import { waitingLine } from "@/components/action-items/waiting-fold";
import { translator } from "@/lib/i18n";

const hold = (id: string, num: string, name: string, touched: string, until: string | null) => ({
  id,
  job_number: num,
  name,
  updated_at: touched,
  hold_reason: "Waiting on the customer",
  hold_until: until,
  hold_by: null,
  holder: null,
  customers: { name: "A Customer" },
});

describe("a hold with no day waits in the fold (cn-v1179)", () => {
  it("no day: waiting, after the rows with a day, counted by no number; a later day waits; a day come is back on Now with its clock", async () => {
    state.legacy = false;
    state.held = [
      hold("j34", "J-934", "Larkspur Deck", daysAgo(85), null),
      hold("j48", "J-048", "Snowbell Barn", daysAgo(2), "2026-11-12"),
      hold("j13", "J-013", "Bayberry Porch", daysAgo(40), TODAY),
    ];
    const ctx = { todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" };
    const r = await getActionItems(ctx);
    // Back today: a Now row (a lone one, no pile), Due on its own day.
    const ids = [...r.now, ...r.now.flatMap((x) => x.children ?? [])].map((x) => x.id);
    expect(ids).toContain("onhold-j13");
    expect(ids).not.toContain("onhold-j34");
    expect(ids).not.toContain("onhold-j48");
    const back = r.now.find((x) => x.id === "onhold-j13")!;
    expect([back.clock, back.level]).toEqual([TODAY, "soon"]);
    // The fold: tomorrow's first, the one with no day last, saying its reason and No Day Set.
    const held = r.waiting.filter((w) => w.kind === "job_on_hold");
    expect(held.map((w) => [w.id, w.backOn])).toEqual([
      ["onhold-j48", "2026-11-12"],
      ["onhold-j34", null],
    ]);
    expect(waitingLine(held[1])).toBe("Larkspur Deck · J-934 · Waiting on the customer · No Day Set");
    expect(waitingLine(held[1], "es", translator("es"))).toBe("Larkspur Deck · J-934 · Waiting on the customer · Sin Día");
    expect(waitingLine(held[0])).toBe("Snowbell Barn · J-048 · Waiting on the customer · Back Nov 12");
    // The numbers: only the hold that is back counts (the header, the tiles, the dock's badge).
    expect(summarize(r.now, { isStaff: true }).total).toBe(1);
    expect(await getActionItemsCount(ctx)).toBe(1);
  });

  it("before 0366 (no hold-day columns) the old rule stands: a hold is a Now row with no Snooze", async () => {
    state.legacy = true;
    state.held = [hold("j34", "J-934", "Larkspur Deck", daysAgo(10), null)];
    const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
    state.legacy = false;
    const row = r.now.find((x) => x.id === "onhold-j34");
    expect(row, "the legacy hold stays on Now").toBeTruthy();
    expect(row!.affordances).toEqual(["do", "open"]);
    expect(row!.what?.key).toBe("ny_w_holdNoDay");
    expect(r.waiting.some((w) => w.id === "onhold-j34")).toBe(false);
  });
});

describe("a hold's clock", () => {
  it("a hold whose day has come: its clock is that day, Due for seven days after, then plain", async () => {
    state.held = [
      hold("j13", "J-013", "Birch Remodel", daysAgo(1), daysAgo(9).slice(0, 10)),
      hold("j21", "J-021", "Larkspur Deck", daysAgo(1), daysAgo(7).slice(0, 10)),
      hold("j48", "J-048", "Tupelo Panel", daysAgo(40), TODAY),
    ];
    const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
    const pile = r.now.find((i) => i.id === "pile:holds_back")!;
    const byId = Object.fromEntries(pile.children!.map((k) => [k.id, k]));
    expect(byId["onhold-j13"].since).toBe(daysAgo(9).slice(0, 10));
    expect(byId["onhold-j48"].since).toBe(TODAY);
    expect(byId["onhold-j13"].clock).toBe(daysAgo(9).slice(0, 10));
    expect(byId["onhold-j48"].clock).toBe(TODAY);
    // Back nine days: past the window, plain. Back seven days and back today: Due. The pile wears it.
    expect(byId["onhold-j13"].level).toBe("none");
    expect(byId["onhold-j21"].level).toBe("soon");
    expect(byId["onhold-j48"].level).toBe("soon");
    expect(pile.level).toBe("soon");
  });
});

describe("the fold's law (cn-v1179)", () => {
  it("waitingRow still refuses a row with no day; waitingRowNoDay takes only a job on hold", async () => {
    const { waitingRow, waitingRowNoDay } = await import("./types");
    const base = { id: "onhold-j1", kind: "job_on_hold" as const, title: "Larkspur Deck · J-041", why: "Waiting on the permit", href: "/jobs/j1" };
    expect(waitingRow({ ...base, backOn: null })).toBeNull();
    expect(waitingRow({ ...base, backOn: "" })).toBeNull();
    expect(waitingRow({ ...base, backOn: "not a day" })).toBeNull();
    expect(waitingRowNoDay(base)).toEqual({ ...base, backOn: null });
    for (const kind of ["materials_needed", "invoice_draft", "permit_inspection", "job_task_flagged"] as const) expect(waitingRowNoDay({ ...base, kind }), kind).toBeNull();
  });

  it("waitingRowNoDay has ONE caller: the hold feeder, inside its own block", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && readFileSync(p, "utf8").includes("waitingRowNoDay(")) callers.push(p.slice(process.cwd().length + 1));
      }
    };
    walk(join(process.cwd(), "src"));
    expect(callers.sort()).toEqual(["src/lib/action-items/query.ts", "src/lib/action-items/types.ts"]);
    const q = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    expect(q.match(/waitingRowNoDay\(/g)).toHaveLength(1);
    const at = q.indexOf("waitingRowNoDay({");
    expect(at).toBeGreaterThan(q.indexOf("// 5) HOLDS"));
    expect(at).toBeLessThan(q.indexOf("// 5b) FLAGGED JOB TASKS"));
    expect(q.slice(at - 200, at)).toContain('if (withDay && state === "no_day") {');
  });
});
