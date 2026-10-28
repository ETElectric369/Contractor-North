import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHO READS WHICH LANGUAGE (lib/lang-of, cn-v1138): one profiles select per 200 ids, every asked id
 * in the answer, English for anyone missing or unreadable, a failed read filed with the chunk's
 * count and never an id, the company named on the read when the sender knows it (the service
 * client reads across companies without it); the caller's own language from the session — or from
 * the id the caller already has, with no second round trip — English on any failure.
 */
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { reportError } from "@/lib/observe";
import { langOf, callerLang } from "./lang-of";

const state = {
  people: [] as { id: string; language: string | null; org_id?: string }[],
  fail: false,
  selects: [] as unknown[][],
  eqs: [] as [string, unknown][],
  user: null as { id: string } | null,
  getUserCalls: 0,
};

function from(table: string) {
  let wanted: unknown[] = [];
  let one: unknown = null;
  let org: unknown = null;
  const b: any = {
    select: () => b,
    in: (_k: string, vs: unknown[]) => ((wanted = vs), state.selects.push(vs), b),
    eq: (k: string, v: unknown) => {
      state.eqs.push([k, v]);
      if (k === "org_id") org = v;
      else one = v;
      return b;
    },
    limit: () => b,
    maybeSingle: async () => {
      if (state.fail) return { data: null, error: { message: "boom" } };
      const row = state.people.find((p) => p.id === one);
      return { data: row ? { language: row.language } : null, error: null };
    },
    then: (res: (v: unknown) => void) => {
      if (table !== "profiles") return res({ data: [], error: null });
      if (state.fail) return res({ data: null, error: { message: "boom" } });
      // The database applies the company filter: a row of another company never comes back.
      res({ data: state.people.filter((p) => wanted.includes(p.id) && (org == null || p.org_id === org)), error: null });
    },
  };
  return b;
}
const sb = {
  from,
  auth: {
    getUser: async () => {
      state.getUserCalls += 1;
      return { data: { user: state.user } };
    },
  },
};

beforeEach(() => {
  state.people = [];
  state.fail = false;
  state.selects = [];
  state.eqs = [];
  state.user = null;
  state.getUserCalls = 0;
  vi.mocked(reportError).mockClear();
});

describe("langOf", () => {
  it("answers every id asked: es for an es row, en for an en row, a null row, or no row at all", async () => {
    state.people = [
      { id: "larkspur", language: "es" },
      { id: "snowbell", language: "en" },
      { id: "bayberry", language: null },
    ];
    const m = await langOf(sb, ["larkspur", "snowbell", "bayberry", "thistlewood", "larkspur"]);
    expect([...m.entries()]).toEqual([
      ["larkspur", "es"],
      ["snowbell", "en"],
      ["bayberry", "en"],
      ["thistlewood", "en"],
    ]);
    // One select, the ids once each; with no company given, no company filter (the caller's own
    // session client is already scoped by RLS).
    expect(state.selects).toEqual([["larkspur", "snowbell", "bayberry", "thistlewood"]]);
    expect(state.eqs).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("with the company given, the read carries .eq('org_id', …): a stranger's id in the list answers 'en', never the stranger's row", async () => {
    state.people = [
      { id: "larkspur", language: "es", org_id: "org-1" },
      { id: "stranger", language: "es", org_id: "org-2" },
    ];
    const m = await langOf(sb, ["larkspur", "stranger"], "org-1");
    expect([...m.entries()]).toEqual([
      ["larkspur", "es"],
      ["stranger", "en"],
    ]);
    expect(state.eqs).toEqual([["org_id", "org-1"]]);
    // A null or empty company is no filter (a caller that never knew it), not a filter on nothing.
    state.eqs = [];
    await langOf(sb, ["larkspur"], null);
    await langOf(sb, ["larkspur"], "");
    expect(state.eqs).toEqual([]);
  });

  it("chunks at 200 ids", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `p${i}`);
    state.people = ids.map((id, i) => ({ id, language: i % 2 ? "es" : "en" }));
    const m = await langOf(sb, ids);
    expect(m.size).toBe(450);
    expect(state.selects.map((s) => s.length)).toEqual([200, 200, 50]);
    expect(m.get("p1")).toBe("es");
    expect(m.get("p2")).toBe("en");
  });

  it("a failed read is English for everyone, filed with the count and never an id; nothing is asked for no ids", async () => {
    state.fail = true;
    const m = await langOf(sb, ["larkspur", "snowbell"]);
    expect([...m.entries()]).toEqual([
      ["larkspur", "en"],
      ["snowbell", "en"],
    ]);
    expect(reportError).toHaveBeenCalledWith("lang-of:read", { message: "boom" }, { count: 2 });
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain("larkspur");
    state.selects = [];
    expect((await langOf(sb, [])).size).toBe(0);
    expect(state.selects).toEqual([]);
  });
});

describe("callerLang", () => {
  it("the signed-in person's language; English when there is nobody, no row, or the read fails", async () => {
    state.people = [{ id: "larkspur", language: "es" }];
    expect(await callerLang(sb)).toBe("en");
    state.user = { id: "larkspur" };
    expect(await callerLang(sb)).toBe("es");
    state.user = { id: "nobody" };
    expect(await callerLang(sb)).toBe("en");
    state.user = { id: "larkspur" };
    state.fail = true;
    expect(await callerLang(sb)).toBe("en");
    expect(await callerLang({ from: () => { throw new Error("no client"); }, auth: sb.auth })).toBe("en");
  });

  it("given the signed-in id, reads the language with no getUser round trip; a blank id falls back to the session", async () => {
    state.people = [{ id: "larkspur", language: "es" }];
    expect(await callerLang(sb, "larkspur")).toBe("es");
    expect(state.getUserCalls).toBe(0);
    expect(state.eqs).toEqual([["id", "larkspur"]]);
    // A client with no auth at all still answers when the id is given.
    expect(await callerLang({ from }, "larkspur")).toBe("es");
    state.user = { id: "larkspur" };
    expect(await callerLang(sb, "")).toBe("es");
    expect(await callerLang(sb, null)).toBe("es");
    expect(state.getUserCalls).toBe(2);
  });
});
