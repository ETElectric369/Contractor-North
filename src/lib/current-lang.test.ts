import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SIGNED-IN PERSON'S LANGUAGE, ONCE PER REQUEST (cn-v1139). React's cache() memoizes per server
 * request; outside a render it memoizes nothing, so this test stands in a memoizing cache of its own
 * (one map, cleared per case) and counts the reads underneath: the profile is read once however
 * many callers ask, and every failure is English. A page that already holds the session's id asks
 * currentLangFor(user?.id) and costs NO getUser of its own; the no-id door currentLang() is the one
 * getUser, then the same row.
 */
const state = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  row: { language: "es" } as { language?: string | null } | null,
  readError: null as unknown,
  throwOnClient: false,
  selects: 0,
  getUsers: 0,
  memo: new Map<string, unknown>(),
}));

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  let n = 0;
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      const id = n++;
      return (...args: A): R => {
        const key = `${id}:${JSON.stringify(args)}`;
        if (!state.memo.has(key)) state.memo.set(key, fn(...args));
        return state.memo.get(key) as R;
      };
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (state.throwOnClient) throw new Error("no cookies here");
    return {
      auth: {
        getUser: async () => {
          state.getUsers++;
          return { data: { user: state.user } };
        },
      },
      from: (table: string) => {
        expect(table).toBe("profiles");
        return {
          select: (cols: string) => {
            expect(cols).toContain("language");
            return {
              eq: (_c: string, id: string) => ({
                single: async () => {
                  state.selects++;
                  return { data: id === state.user?.id ? state.row : null, error: state.readError };
                },
              }),
            };
          },
        };
      },
    };
  },
}));

import { currentLang, currentLangFor, signedInProfile } from "./current-lang";

beforeEach(() => {
  state.user = { id: "u1" };
  state.row = { language: "es" };
  state.readError = null;
  state.throwOnClient = false;
  state.selects = 0;
  state.getUsers = 0;
  state.memo.clear();
});

describe("currentLang", () => {
  it("reads the profile ONCE for every caller in the request: the layout's row, then the page's language, cost one select", async () => {
    const first = await signedInProfile("u1");
    expect(first.data).toEqual({ language: "es" });
    expect(await signedInProfile("u1")).toBe(first);
    expect(await currentLangFor("u1")).toBe("es");
    expect(await currentLangFor("u1")).toBe("es");
    expect(await currentLang()).toBe("es");
    expect(await currentLang()).toBe("es");
    expect(state.selects).toBe(1);
    // currentLang() resolves the session once, then rides the same row.
    expect(state.getUsers).toBe(1);
  });

  it("a page that holds the id (currentLangFor) never calls getUser: one select, and nobody (a nullable user?.id) is English with no read at all", async () => {
    expect(await currentLangFor("u1")).toBe("es");
    expect(await currentLangFor("u1")).toBe("es");
    expect(state.getUsers).toBe(0);
    expect(state.selects).toBe(1);
    state.memo.clear();
    state.selects = 0;
    expect(await currentLangFor(undefined)).toBe("en");
    expect(await currentLangFor(null)).toBe("en");
    expect(await currentLangFor("")).toBe("en");
    expect(state.selects).toBe(0);
    expect(state.getUsers).toBe(0);
  });

  it("a page alone with no id in scope (the no-id door) costs one getUser and one select, and the language is the row's", async () => {
    expect(await currentLang()).toBe("es");
    expect(state.selects).toBe(1);
    expect(state.getUsers).toBe(1);
    state.memo.clear();
    state.row = { language: "en" };
    expect(await currentLang()).toBe("en");
    state.memo.clear();
    state.row = { language: null };
    expect(await currentLang()).toBe("en");
    state.memo.clear();
    state.row = { language: "fr" };
    expect(await currentLang()).toBe("en");
  });

  it("a failed read is English, never a throw: an errored select, no row, nobody signed in, a client that cannot open", async () => {
    state.readError = { code: "PGRST301", message: "refused" };
    expect(await currentLang()).toBe("en");
    expect(await currentLangFor("u1")).toBe("en");
    state.memo.clear();
    state.readError = null;
    state.row = null;
    expect(await currentLangFor("u1")).toBe("en");
    state.memo.clear();
    state.user = null;
    expect(await currentLang()).toBe("en");
    expect(state.selects).toBe(2);
    state.memo.clear();
    state.throwOnClient = true;
    expect(await currentLang()).toBe("en");
    expect(await currentLangFor("u1")).toBe("en");
  });

  it("is server-only, every reader is wrapped in React cache(), and the (app) layout reads its profile through the same door", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/current-lang.ts"), "utf8");
    expect(src.startsWith('import "server-only";')).toBe(true);
    expect(src).toContain("export const signedInProfile = cache(async (userId: string) =>");
    expect(src).toContain("export const currentLangFor = cache(async (userId: string | null | undefined): Promise<Lang> =>");
    expect(src).toContain("export const currentLang = cache(async (): Promise<Lang> =>");
    // The comment block shows the normal door (the page's own id, no second getUser) and the no-id door.
    expect(src).toContain("const t = translator(await currentLangFor(user?.id));");
    expect(src).toContain("const t = translator(await currentLang());");
    expect(src.indexOf("currentLangFor(user?.id)")).toBeLessThan(src.indexOf("const t = translator(await currentLang());"));
    const layout = readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain('import { signedInProfile } from "@/lib/current-lang";');
    expect(layout).toContain("const { data: profile, error: profileErr } = await signedInProfile(user.id);");
    expect(layout).not.toContain(".select(PROFILE_SAFE_COLS)");
  });
});
