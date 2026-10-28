import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRADE_ORDER, TRADE_PACKAGES, TRADE_PACK_OPTIONS } from "@/lib/trade-package";

/**
 * "IMPORT A TRADE'S CODES" READS THE REGISTRY (cn-v1135). The door used to read lib/trade-code-packs,
 * five lists that disagreed with sign-up's ten (TRBL there, TROUB here), so a company seeded at sign-up
 * and then importing its own trade got twins. Now the id is a trade KEY, the rows are the registry's one
 * list, and a code the company already holds is skipped by its canonical spelling for that trade — the
 * old packs' aliases fold (TRBL → TROUB, LV → LOW), so nobody gets a second bucket for the same work.
 * Driven on a recording fake: alias skipped, N added, the words, an unknown id refused.
 */
const state = vi.hoisted(() => ({
  existing: [] as { code: string }[],
  readError: null as null | { message: string },
  inserted: [] as Record<string, unknown>[][],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => { throw new Error("no client expected"); }),
  createServiceClient: vi.fn(() => { throw new Error("no service client expected"); }),
}));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: async () => ({ supabase: client(), userId: "me", orgId: "org-1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
    from: (table: string) => {
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_id: "org-1" }, error: null }) }) }) };
      }
      if (table === "job_codes") {
        return {
          select: () => ({ eq: async (_col: string, orgId: string) => {
            expect(orgId).toBe("org-1");
            return { data: state.readError ? null : state.existing, error: state.readError };
          } }),
          insert: async (rows: Record<string, unknown>[]) => {
            state.inserted.push(rows);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

import { importTradeCodePack } from "./actions";

beforeEach(() => {
  state.existing = [];
  state.readError = null;
  state.inserted = [];
});

const codesOf = (rows: Record<string, unknown>[]) => rows.map((r) => r.code);

describe("importTradeCodePack", () => {
  it("an empty company gets the trade's whole registry list, org-scoped, every row active", async () => {
    const res = await importTradeCodePack("plumbing");
    expect(res).toEqual({ ok: true, added: TRADE_PACKAGES.plumbing.codes.length, skipped: 0 });
    expect(state.inserted).toHaveLength(1);
    expect(codesOf(state.inserted[0])).toEqual(TRADE_PACKAGES.plumbing.codes.map((c) => c.code));
    for (const row of state.inserted[0]) expect(row).toMatchObject({ org_id: "org-1", active: true });
    expect(state.inserted[0].find((r) => r.code === "SHOP")).toMatchObject({ billable: false });
    expect(state.inserted[0].find((r) => r.code === "SVC")).toMatchObject({ billable: true });
  });

  it("a code held under the old pack's spelling is skipped: TRBL holds TROUB back, and LV holds LOW", async () => {
    state.existing = [{ code: "TRBL" }, { code: "lv" }, { code: " svc " }];
    const res = await importTradeCodePack("electrical");
    const added = codesOf(state.inserted[0]);
    expect(added).not.toContain("TROUB");
    expect(added).not.toContain("LOW");
    expect(added).not.toContain("SVC");
    expect(added).toContain("PANEL");
    expect(res).toEqual({ ok: true, added: TRADE_PACKAGES.electrical.codes.length - 3, skipped: 3 });
  });

  it("an alias folds only for its own trade: TRIM is a plumber's FINISH, an electrician's own TRIM", async () => {
    state.existing = [{ code: "TRIM" }];
    await importTradeCodePack("plumbing");
    expect(codesOf(state.inserted[0])).not.toContain("FINISH");
    state.inserted = [];
    await importTradeCodePack("electrical");
    expect(codesOf(state.inserted[0])).not.toContain("TRIM");
    expect(codesOf(state.inserted[0])).toContain("ROUGH");
  });

  it("a second import of the same trade adds nothing and writes nothing", async () => {
    state.existing = TRADE_PACKAGES.deck.codes.map((c) => ({ code: c.code }));
    expect(await importTradeCodePack("deck")).toEqual({ ok: true, added: 0, skipped: TRADE_PACKAGES.deck.codes.length });
    expect(state.inserted).toHaveLength(0);
  });

  it("an id that is not a trade is refused in words, before any read", async () => {
    expect(await importTradeCodePack("solar")).toEqual({ ok: false, error: 'There is no trade called "solar".' });
    expect(await importTradeCodePack("")).toEqual({ ok: false, error: 'There is no trade called "".' });
    expect(state.inserted).toHaveLength(0);
  });

  it("a failed read of the company's codes is said, not imported over", async () => {
    state.readError = { message: "connection reset" };
    const res = await importTradeCodePack("general");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("connection reset");
    expect(state.inserted).toHaveLength(0);
  });

  it("the picker's rows are every registry trade in TRADE_ORDER, general first, never electrical first", () => {
    expect(TRADE_PACK_OPTIONS[0].id).toBe("general");
    expect(TRADE_PACK_OPTIONS.map((o) => o.id)).toEqual([...TRADE_ORDER]);
    expect(TRADE_PACK_OPTIONS.findIndex((o) => o.id === "electrical")).toBeGreaterThan(0);
    for (const o of TRADE_PACK_OPTIONS) expect(o.count).toBe(TRADE_PACKAGES[o.id].codes.length);
  });
});
