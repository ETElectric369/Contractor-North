import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE OFFICE RING (ringOffice, pulled out of the materials list for the Panel tab). Two shapes:
 *  - materials: every add on the bell, one push per person per job per 15 minutes;
 *  - panel: ONE notice per job per hour; inside the hour the bell line already there is refreshed
 *    with the running count, and nobody is buzzed again. A Keep All batch is one call, one notice.
 */

type Row = { id: string; org_id: string; user_id: string; type: string; title: string; body: string | null; url: string; created_at: string; read_at: string | null };
let table: Row[] = [];
let seq = 0;
let failReads = false;

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
    insert: async (rows: Omit<Row, "id" | "created_at" | "read_at">[]) => {
      for (const r of rows) table.push({ ...r, id: `n${++seq}`, created_at: new Date().toISOString(), read_at: null } as Row);
      return { error: null };
    },
    then: (res: (v: unknown) => void) => {
      if (op === "select" && failReads) return res({ data: null, error: { message: "read failed" } });
      const hit = table.filter((r) => filters.every((f) => f(r)));
      if (op === "update") for (const r of hit) Object.assign(r, patch);
      res({ data: hit.map((r) => ({ id: r.id })), error: null });
    },
  };
  return api;
}

/** The language read (lib/lang-of): profiles rows by id, under the company named, or a failed read. */
let people: { id: string; language: string | null }[] = [];
let failLangRead = false;
let langReadFilters: [string, unknown][] = [];
function profiles() {
  let wanted: unknown[] = [];
  const api: any = {
    select: () => api,
    in: (_k: string, vs: unknown[]) => ((wanted = vs), api),
    eq: (k: string, v: unknown) => (langReadFilters.push([k, v]), api),
    then: (res: (v: unknown) => void) => {
      if (failLangRead) return res({ data: null, error: { message: "profiles unreadable" } });
      res({ data: people.filter((p) => wanted.includes(p.id)), error: null });
    },
  };
  return api;
}

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ from: (t: string) => (t === "profiles" ? profiles() : builder()) }) }));
const push = vi.fn(async (ids: string[], _kind?: string, _payload?: { title: string }) => ids);
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: (...a: unknown[]) => push(...(a as [string[], string, { title: string }])),
  pushKindIsOptIn: (kind: string) => kind === "day_ahead",
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { reportError } from "@/lib/observe";
import { createNotifications, notifyPeople, ringOffice } from "./notifications";

const base = { type: "panel_changed", url: "/jobs/j1?tab=panel", windowMinutes: 60, mode: "once_per_window" as const };

beforeEach(() => {
  table = [];
  failReads = false;
  people = [];
  failLangRead = false;
  langReadFilters = [];
  push.mockClear();
  vi.mocked(reportError).mockClear();
});

/**
 * WORDS PER PERSON (cn-v1138): a payload given as a function of the language is built once per
 * language the recipients read, after ONE profiles read that names the company (the service client
 * reads across companies without it); a failed read is English for everyone, filed.
 */
describe("a payload that is a function of the language", () => {
  const words = (lang: "en" | "es") => ({ type: "nudge", title: lang === "es" ? "Marca entrada cuando llegues." : "Clock in when you get there.", url: "/timeclock" });

  it("writes a Spanish row for an es person and an English row for an en person in the same call, and pushes each group its own words", async () => {
    people = [
      { id: "larkspur", language: "es" },
      { id: "snowbell", language: "en" },
      { id: "bayberry", language: null },
    ];
    expect(await createNotifications("org", ["larkspur", "snowbell", "bayberry"], words)).toBe(true);
    // Groups in the order their first reader appears: larkspur's Spanish, then the two English rows.
    expect(table.map((r) => [r.user_id, r.title, r.type])).toEqual([
      ["larkspur", "Marca entrada cuando llegues.", "nudge"],
      ["snowbell", "Clock in when you get there.", "nudge"],
      ["bayberry", "Clock in when you get there.", "nudge"],
    ]);
    // The one language read named the company.
    expect(langReadFilters).toEqual([["org_id", "org"]]);
    langReadFilters = [];
    table = [];
    const res = await notifyPeople("org", ["larkspur", "snowbell"], "assigned", words);
    expect(res).toEqual({ bell: true, pushed: ["larkspur", "snowbell"] });
    expect(langReadFilters).toEqual([["org_id", "org"]]);
    expect(table.map((r) => [r.user_id, r.title])).toEqual([
      ["larkspur", "Marca entrada cuando llegues."],
      ["snowbell", "Clock in when you get there."],
    ]);
    // One push per language group, each with that group's words; the type is the push kind.
    expect(push.mock.calls.map((c) => [c[0], c[1], (c[2] as { title: string }).title])).toEqual([
      [["larkspur"], "assigned", "Marca entrada cuando llegues."],
      [["snowbell"], "assigned", "Clock in when you get there."],
    ]);
    expect(table.every((r) => r.type === "assigned")).toBe(true);
  });

  it("a failed language read still writes the rows, in English, and files the read (never the ids)", async () => {
    people = [{ id: "larkspur", language: "es" }];
    failLangRead = true;
    expect(await createNotifications("org", ["larkspur", "snowbell"], words)).toBe(true);
    expect(table.map((r) => [r.user_id, r.title])).toEqual([
      ["larkspur", "Clock in when you get there."],
      ["snowbell", "Clock in when you get there."],
    ]);
    expect(reportError).toHaveBeenCalledWith("lang-of:read", { message: "profiles unreadable" }, { count: 2 });
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain("larkspur");
    expect(await notifyPeople("org", ["larkspur"], "assigned", words)).toEqual({ bell: true, pushed: ["larkspur"] });
    expect(table.at(-1)?.title).toBe("Clock in when you get there.");
  });

  it("a plain payload reads no language at all and writes as it always did", async () => {
    failLangRead = true; // would be filed if anything asked
    expect(await createNotifications("org", ["larkspur"], { title: "Hello", type: "general" })).toBe(true);
    expect(table.map((r) => [r.user_id, r.title, r.type])).toEqual([["larkspur", "Hello", "general"]]);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("the panel ring: one notice per job per hour", () => {
  it("rings once, then refreshes the same bell line with the running count and buzzes nobody", async () => {
    expect(await ringOffice("org", ["erik", "office"], { ...base, title: "Brian changed 3 circuits on J-011 13897 Honeysuckle" })).toBe("rang");
    expect(table).toHaveLength(2);
    expect(push).toHaveBeenCalledTimes(1);
    expect(await ringOffice("org", ["erik", "office"], { ...base, title: "Brian changed 5 circuits on J-011 13897 Honeysuckle" })).toBe("refreshed");
    expect(table).toHaveLength(2);
    expect(table.map((r) => r.title)).toEqual(["Brian changed 5 circuits on J-011 13897 Honeysuckle", "Brian changed 5 circuits on J-011 13897 Honeysuckle"]);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("a change after the office read the line brings the line back unread (still no second buzz)", async () => {
    await ringOffice("org", ["erik"], { ...base, title: "Brian changed 1 circuit on J-011 13897 Honeysuckle" });
    table[0].read_at = "2026-09-25T09:05:00Z";
    expect(await ringOffice("org", ["erik"], { ...base, title: "Brian changed 9 circuits on J-011 13897 Honeysuckle" })).toBe("refreshed");
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ title: "Brian changed 9 circuits on J-011 13897 Honeysuckle", read_at: null });
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
    const m = { type: "materials_added", url: "/jobs/j1?tab=materials", windowMinutes: 15, mode: "bell_each_push_once" as const, title: "Brian added to Honeysuckle materials" };
    expect(await ringOffice("org", ["erik"], { ...m, body: "1 ea — Q220" })).toBe("rang");
    expect(await ringOffice("org", ["erik"], { ...m, body: "2 ea — faceplates" })).toBe("bell_only");
    expect(table.map((r) => r.body)).toEqual(["1 ea — Q220", "2 ea — faceplates"]);
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("when the window can't be read", () => {
  it("the bell line is still written (never dropped) and nobody is buzzed", async () => {
    failReads = true;
    const m = { type: "materials_added", url: "/jobs/j1?tab=materials", windowMinutes: 15, mode: "bell_each_push_once" as const, title: "Brian added to Honeysuckle materials" };
    expect(await ringOffice("org", ["erik", "office"], { ...m, body: "1 ea — Q220" })).toBe("bell_only");
    expect(table).toHaveLength(2);
    expect(await ringOffice("org", ["erik"], { ...base, title: "Brian changed 2 circuits" })).toBe("bell_only");
    expect(table).toHaveLength(3);
    expect(push).not.toHaveBeenCalled();
  });
});
