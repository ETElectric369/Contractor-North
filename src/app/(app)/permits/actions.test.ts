import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A NEW PERMIT IS THE TRADE'S PERMIT, NEVER THE COLUMN'S (cn-v1135). permits.type carries a database
 * default of "Electrical" (0022, written for one electrician), and createPermit used to send that same
 * word whenever nothing was typed — so a plumber's permit logged by Nort with no type said Electrical.
 * Driven here on a recording fake: the action ALWAYS sends a type (the column default is never
 * reached), a blank type is the company's trade's permit, a typed type stands, and a failed settings
 * read is said instead of guessed around.
 */
const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  settingsError: null as null | { message: string },
  inserted: [] as Record<string, unknown>[],
  /** The filters the settings read carried: the company's own row, by id. */
  settingsEqs: [] as [string, unknown][],
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: async () => ({ supabase: client(), userId: "me", orgId: "org-1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function client() {
  return {
    from: (table: string) => {
      if (table === "organizations") {
        const q = {
          eq: (k: string, v: unknown) => {
            state.settingsEqs.push([k, v]);
            return q;
          },
          limit: () => q,
          maybeSingle: async () => ({ data: state.settingsError ? null : { settings: state.settings }, error: state.settingsError }),
        };
        return { select: () => q };
      }
      if (table === "permits") {
        return {
          insert: async (row: Record<string, unknown>) => {
            state.inserted.push(row);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

import { createPermit } from "./actions";

beforeEach(() => {
  state.settings = {};
  state.settingsError = null;
  state.inserted = [];
  state.settingsEqs = [];
});

describe("createPermit: the type is always sent", () => {
  it("no type typed, a plumbing company: the permit is a Plumbing permit", async () => {
    state.settings = { trade: "plumbing" };
    expect(await createPermit({ job_id: "j1", permit_number: " 44-Larkspur " })).toEqual({ ok: true });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ job_id: "j1", permit_number: "44-Larkspur", type: "Plumbing", status: "applied" });
    // The settings read is the company's own row, by id — never the first row the client can see.
    expect(state.settingsEqs).toEqual([["id", "org-1"]]);
  });

  it("no type typed, a general contractor: a Building permit; HVAC: Mechanical; electrical: Electrical", async () => {
    for (const [trade, type] of [["general", "Building"], ["hvac", "Mechanical"], ["electrical", "Electrical"]] as const) {
      state.inserted = [];
      state.settings = { trade };
      await createPermit({ type: "   " });
      expect(state.inserted[0]?.type, trade).toBe(type);
    }
  });

  it("no trade known: Building, still never the column's default", async () => {
    state.settings = {};
    await createPermit({});
    expect(state.inserted[0]).toMatchObject({ type: "Building" });
    expect(typeof state.inserted[0].type).toBe("string");
  });

  it("the words a company typed for its trade are the last resort (lib/org-trade), the key first", async () => {
    state.settings = { trade_label: "Snowbell Plumbing & Heating" };
    await createPermit({});
    expect(state.inserted[0]).toMatchObject({ type: "Plumbing" });
    state.inserted = [];
    state.settings = { trade: "deck", trade_label: "electrical contractor" };
    await createPermit({});
    expect(state.inserted[0]).toMatchObject({ type: "Building" });
  });

  it("a typed type stands, trimmed, whatever the trade", async () => {
    state.settings = { trade: "plumbing" };
    await createPermit({ type: " Solar " });
    expect(state.inserted[0]).toMatchObject({ type: "Solar" });
  });

  it("a failed settings read is said, and no permit is written with a guessed type", async () => {
    state.settingsError = { message: "connection reset" };
    const res = await createPermit({ job_id: "j1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("connection reset");
    expect(state.inserted).toHaveLength(0);
  });

  it("a typed type needs no settings read at all", async () => {
    state.settingsError = { message: "would have failed" };
    expect(await createPermit({ type: "Building" })).toEqual({ ok: true });
    expect(state.inserted[0]).toMatchObject({ type: "Building" });
  });
});
