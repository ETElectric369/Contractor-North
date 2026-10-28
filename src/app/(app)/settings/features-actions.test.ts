import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * setFeature (the switch board, 0352) and the one door it replaces. The database decides who may
 * move a switch (set_org_feature: the owner of an active seat); this pins what the app SAYS:
 *   - a stored value that isn't the asked-for one is a failure, never a quiet success;
 *   - a database without 0352 gets a plain line, not a developer error;
 *   - the RPC's own refusals come through in its words;
 *   - updateOrgSettings refuses a switch in words instead of dropping it, and strips estimating_mode
 *     (the owner's own door, features-actions setEstimatingMode, writes it).
 */
const state = vi.hoisted(() => ({ client: null as any, rpcCalls: [] as { fn: string; args: unknown }[], fromCalls: 0 }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustOrgPdfs: vi.fn(async () => {}) }));
vi.mock("@/lib/site-editor-guard", () => ({
  resolveSiteContext: async () => ({ supabase: state.client, userId: "me", orgId: "org-1", isCollaborator: false }),
}));

import { setFeature } from "./features-actions";
import { updateOrgSettings } from "./actions";

function client(reply: { data?: unknown; error?: { code?: string; message: string } | null }) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
    rpc: async (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      return { data: reply.data ?? null, error: reply.error ?? null };
    },
    from() {
      state.fromCalls++;
      throw new Error("no table read expected");
    },
  };
}

beforeEach(() => {
  state.rpcCalls = [];
  state.fromCalls = 0;
});

describe("setFeature", () => {
  it("calls set_org_feature with the key and the value, and hands back the previous value for Undo", async () => {
    state.client = client({ data: { key: "panel_map", on: false, previous: true } });
    expect(await setFeature("panel_map", false)).toEqual({ ok: true, key: "panel_map", on: false, previous: true });
    expect(state.rpcCalls).toEqual([{ fn: "set_org_feature", args: { p_key: "panel_map", p_on: false } }]);
  });

  it("a key that isn't a feature never reaches the database", async () => {
    state.client = client({ data: null });
    expect(await setFeature("plan" as never, true)).toEqual({ ok: false, error: "That isn't a feature." });
    expect(await setFeature("leads", "yes" as never)).toEqual({ ok: false, error: "Say on or off." });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("a stored value that isn't the one asked for is a failure, never a quiet success", async () => {
    state.client = client({ data: { key: "panel_map", on: true, previous: true } });
    expect(await setFeature("panel_map", false)).toEqual({ ok: false, error: "That didn't save. Reload and try again." });
    state.client = client({ data: null });
    expect(await setFeature("panel_map", false)).toEqual({ ok: false, error: "That didn't save. Reload and try again." });
  });

  it("before 0352 is applied: a plain line, no developer text", async () => {
    state.client = client({ error: { code: "PGRST202", message: "Could not find the function public.set_org_feature(p_key, p_on) in the schema cache" } });
    const res = await setFeature("panel_map", false);
    expect(res).toEqual({ ok: false, error: "Features need an update from North. Nothing changed." });
  });

  it("the database's refusal comes through in its own words", async () => {
    state.client = client({ error: { code: "P0001", message: "Only the owner can turn features on or off." } });
    expect(await setFeature("leads", false)).toEqual({ ok: false, error: "Only the owner can turn features on or off." });
  });
});

describe("updateOrgSettings refuses the switch board's keys in words", () => {
  it.each([{ features: { leads: false } }, { trade: "deck" }, { timeclock_job_codes: false }, { service_area: "x", features: {} }])(
    "%j",
    async (patch) => {
      state.client = client({ data: null });
      const res = await updateOrgSettings(patch as Record<string, unknown>);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("Only the owner turns features on or off, on the Features page in Settings.");
      expect(state.fromCalls).toBe(0);
      expect(state.rpcCalls).toHaveLength(0);
    },
  );
});

describe("updateOrgSettings strips estimating_mode: How You Price is the owner's door (S5)", () => {
  it("a staff save carrying it writes everything else and never the mode", async () => {
    const updates: Record<string, unknown>[] = [];
    state.client = {
      auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) => {
        const b: any = {
          select: () => b,
          eq: () => b,
          single: async () => ({ data: table === "organizations" ? { settings: { estimating_mode: "catalog", service_area: "Larkspur" } } : null, error: null }),
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            const u: any = { eq: () => u, select: async () => ({ data: [{ id: "org-1" }], error: null }) };
            return u;
          },
        };
        return b;
      },
    };
    const res = await updateOrgSettings({ estimating_mode: "research", service_area: "Snowbell" });
    expect(res).toEqual({ ok: true });
    expect(updates).toHaveLength(1);
    // The stored mode stands; the rest of the patch landed.
    expect(updates[0]).toEqual({ settings: { estimating_mode: "catalog", service_area: "Snowbell" } });
  });
});
