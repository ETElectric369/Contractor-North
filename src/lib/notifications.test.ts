import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE OFFICE RING (ringOffice, pulled out of the materials list for the Panel tab). Two shapes:
 *  - materials: every add on the bell, one push per person per job per 15 minutes;
 *  - panel: ONE notice per job per hour; inside the hour the bell line already there is refreshed
 *    with the running count, and nobody is buzzed again. A Keep All batch is one call, one notice.
 */

type Row = { id: string; org_id: string; user_id: string; type: string; title: string; body: string | null; url: string; created_at: string };
let table: Row[] = [];
let seq = 0;

function builder() {
  const filters: ((r: Row) => boolean)[] = [];
  let op: "select" | "update" = "select";
  let patch: Partial<Row> = {};
  const api: any = {
    select: () => api,
    eq: (k: keyof Row, v: unknown) => (filters.push((r) => r[k] === v), api),
    gte: (k: keyof Row, v: string) => (filters.push((r) => String(r[k]) >= v), api),
    in: (k: keyof Row, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), api),
    limit: () => api,
    update: (p: Partial<Row>) => ((op = "update"), (patch = p), api),
    insert: async (rows: Omit<Row, "id" | "created_at">[]) => {
      for (const r of rows) table.push({ ...r, id: `n${++seq}`, created_at: new Date().toISOString() } as Row);
      return { error: null };
    },
    then: (res: (v: unknown) => void) => {
      const hit = table.filter((r) => filters.every((f) => f(r)));
      if (op === "update") for (const r of hit) Object.assign(r, patch);
      res({ data: hit.map((r) => ({ id: r.id })), error: null });
    },
  };
  return api;
}

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: () => builder() }) }));
const push = vi.fn(async () => {});
vi.mock("@/lib/push", () => ({ sendPushToProfiles: (...a: unknown[]) => push(...(a as [])) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { ringOffice } from "./notifications";

const base = { type: "panel_changed", url: "/jobs/j1?tab=panel", windowMinutes: 60, mode: "once_per_window" as const };

beforeEach(() => {
  table = [];
  push.mockClear();
});

describe("the panel ring: one notice per job per hour", () => {
  it("rings once, then refreshes the same bell line with the running count and buzzes nobody", async () => {
    expect(await ringOffice("org", ["erik", "office"], { ...base, title: "Brian changed 3 circuits on J-011 13897 Herringbone" })).toBe("rang");
    expect(table).toHaveLength(2);
    expect(push).toHaveBeenCalledTimes(1);
    expect(await ringOffice("org", ["erik", "office"], { ...base, title: "Brian changed 5 circuits on J-011 13897 Herringbone" })).toBe("refreshed");
    expect(table).toHaveLength(2);
    expect(table.map((r) => r.title)).toEqual(["Brian changed 5 circuits on J-011 13897 Herringbone", "Brian changed 5 circuits on J-011 13897 Herringbone"]);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("another job is its own notice, and another org never shares a window", async () => {
    await ringOffice("org", ["erik"], { ...base, title: "a" });
    expect(await ringOffice("org", ["erik"], { ...base, url: "/jobs/j2?tab=panel", title: "b" })).toBe("rang");
    expect(await ringOffice("org2", ["someone"], { ...base, title: "c" })).toBe("rang");
    expect(table).toHaveLength(3);
  });

  it("with nobody in the office there is nothing to ring", async () => {
    expect(await ringOffice("org", [], { ...base, title: "x" })).toBe("nobody");
    expect(table).toHaveLength(0);
  });
});

describe("the materials ring: every add on the bell, one push per 15 minutes", () => {
  it("bells each time and pushes once", async () => {
    const m = { type: "materials_added", url: "/jobs/j1?tab=materials", windowMinutes: 15, mode: "bell_each_push_once" as const, title: "Brian added to Herringbone materials" };
    expect(await ringOffice("org", ["erik"], { ...m, body: "1 ea — Q220" })).toBe("rang");
    expect(await ringOffice("org", ["erik"], { ...m, body: "2 ea — faceplates" })).toBe("bell_only");
    expect(table.map((r) => r.body)).toEqual(["1 ea — Q220", "2 ea — faceplates"]);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
