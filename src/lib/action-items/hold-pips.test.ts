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
 *
 * RE-PINNED ON PURPOSE (cn-v1189): a hold whose day has come is no Now row either. It is a REMINDER, in
 * the build's own `reminders` list, drawn first in My Day's Tasks & Reminders and counted by no number;
 * its fold words say "Reminder Set Nov 12" and "No Reminder Set". The clock and Due pins went with the
 * Now row; and the day arriving writes nothing (the job stays on hold).
 */

// A fixed day: the test reads no clock.
const TODAY = "2026-11-11";
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();

const state = vi.hoisted(() => ({ held: [] as any[], legacy: false, writes: [] as string[] }));

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
          // Every write the build might make is written down (cn-v1189, C3: the day arriving writes nothing).
          if (prop === "update" || prop === "insert" || prop === "upsert" || prop === "delete") {
            return () => {
              state.writes.push(`${table}.${String(prop)}`);
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
  it("no day: waiting, after the rows with a day, counted by no number; a later day waits; a day come is a Reminder, never a Now row (cn-v1189)", async () => {
    state.legacy = false;
    state.writes = [];
    state.held = [
      hold("j34", "J-934", "Larkspur Deck", daysAgo(85), null),
      hold("j48", "J-948", "Snowbell Barn", daysAgo(2), "2026-11-12"),
      hold("j13", "J-913", "Bayberry Porch", daysAgo(40), TODAY),
    ];
    const ctx = { todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" };
    const r = await getActionItems(ctx);
    // ITS DAY HAS COME (cn-v1189): filed with Reminders, never a Needs You row (no row, no pile).
    const ids = [...r.now, ...r.now.flatMap((x) => x.children ?? []), ...r.older].map((x) => x.id);
    expect(ids.filter((id) => id.startsWith("onhold-") || id === "pile:holds_back")).toEqual([]);
    expect(r.reminders).toEqual([
      { jobId: "j13", title: "Bayberry Porch · J-913", jobNumber: "J-913", name: "Bayberry Porch", reason: "Waiting on the customer", holdUntil: TODAY, href: "/jobs/j13" },
    ]);
    // One place at a time: not in the fold either.
    expect(r.waiting.some((w) => w.id === "onhold-j13")).toBe(false);
    // The fold: tomorrow's first, the one with no day last, saying its reason and No Day Set.
    const held = r.waiting.filter((w) => w.kind === "job_on_hold");
    expect(held.map((w) => [w.id, w.backOn])).toEqual([
      ["onhold-j48", "2026-11-12"],
      ["onhold-j34", null],
    ]);
    expect(waitingLine(held[1])).toBe("Larkspur Deck · J-934 · Waiting on the customer · No Reminder Set");
    expect(waitingLine(held[1], "es", translator("es"))).toBe("Larkspur Deck · J-934 · Waiting on the customer · Sin Recordatorio");
    expect(waitingLine(held[0])).toBe("Snowbell Barn · J-948 · Waiting on the customer · Reminder Set Nov 12");
    // The numbers: no hold counts, not even the one whose day came (the header, the tiles, the dock's badge).
    expect(summarize(r.now, { isStaff: true }).total).toBe(0);
    expect(await getActionItemsCount(ctx)).toBe(0);
    // C3: THE DAY ARRIVING WRITES NOTHING. The job stays on hold; the build only reads.
    expect(state.writes).toEqual([]);
  });

  it("a tech: no hold reminders (the holds read is staff only, as Needs You's was)", async () => {
    state.legacy = false;
    state.held = [hold("j13", "J-913", "Bayberry Porch", daysAgo(40), TODAY)];
    const r = await getActionItems({ todayStr: TODAY, isStaff: false, userId: "tech-1", tz: "America/Los_Angeles" });
    expect(r.reminders).toEqual([]);
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

describe("the hold reminders' order (cn-v1189)", () => {
  it("the longest-waiting first: an earlier day before a later one, every one of them off Now", async () => {
    state.legacy = false;
    state.held = [
      hold("j48", "J-948", "Tupelo Panel", daysAgo(40), TODAY),
      hold("j13", "J-913", "Birch Remodel", daysAgo(1), daysAgo(9).slice(0, 10)),
      hold("j21", "J-021", "Larkspur Deck", daysAgo(1), daysAgo(7).slice(0, 10)),
    ];
    const r = await getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
    expect(r.reminders.map((h) => [h.jobId, h.holdUntil])).toEqual([
      ["j13", daysAgo(9).slice(0, 10)],
      ["j21", daysAgo(7).slice(0, 10)],
      ["j48", TODAY],
    ]);
    expect(r.now.find((i) => i.id === "pile:holds_back")).toBeUndefined();
  });
});

describe("the fold's law (cn-v1179)", () => {
  it("waitingRow still refuses a row with no day; waitingRowNoDay takes only a job on hold", async () => {
    const { waitingRow, waitingRowNoDay } = await import("./types");
    const base = { id: "onhold-j1", kind: "job_on_hold" as const, title: "Larkspur Deck · J-961", why: "Waiting on the permit", href: "/jobs/j1" };
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
