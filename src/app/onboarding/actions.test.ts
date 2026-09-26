import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SIGN-UP KEEPS THE TRADE (0352). The trade picked at /onboarding used to choose the job codes and
 * be thrown away. Now it is saved as the company's trade key with its starting switches, "Other /
 * Not Listed" is the blank preset, and a database without 0352 still makes the company the old way.
 */
const state = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], replies: [] as { error: { code?: string; message: string } | null }[] }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "me" } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.calls.push({ fn, ...args });
      return { data: "new-org", error: state.replies.shift()?.error ?? null };
    },
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

import { createOrganization } from "./actions";
import { featurePreset, BLANK_PRESET } from "@/lib/features";
import { TRADE_PRESETS } from "@/lib/trade-codes";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const run = (fields: Record<string, string>) => createOrganization(form(fields)).catch((e: Error) => e.message);

beforeEach(() => {
  state.calls = [];
  state.replies = [];
});

describe("createOrganization", () => {
  it("saves the picked trade and its starting switches", async () => {
    expect(await run({ name: "Sparky Co", trade: "electrical" })).toBe("REDIRECT /planner");
    expect(state.calls).toEqual([
      {
        fn: "create_organization",
        p_name: "Sparky Co",
        p_codes: TRADE_PRESETS.electrical.codes,
        p_trade: "electrical",
        p_features: featurePreset("electrical"),
      },
    ]);
  });

  it("Other / Not Listed: neutral codes, no trade key, the light preset", async () => {
    await run({ name: "Odd Jobs", trade: "other" });
    expect(state.calls[0]).toMatchObject({ p_codes: null, p_trade: null, p_features: BLANK_PRESET });
  });

  it("no trade picked: asks for one, and makes nothing", async () => {
    expect(await run({ name: "Blank Co", trade: "" })).toMatch(/^REDIRECT \/onboarding\?error=Pick%20your%20trade/);
    expect(state.calls).toHaveLength(0);
  });

  it("before 0352: falls back to the old two-argument call, so the company is still made", async () => {
    state.replies = [{ error: { code: "PGRST202", message: "Could not find the function" } }, { error: null }];
    expect(await run({ name: "Early Co", trade: "deck" })).toBe("REDIRECT /planner");
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1]).toEqual({ fn: "create_organization", p_name: "Early Co", p_codes: TRADE_PRESETS.deck.codes });
  });

  it("any other refusal is said, not retried", async () => {
    state.replies = [{ error: { code: "P0001", message: "This account has been deactivated." } }];
    expect(await run({ name: "Gone Co", trade: "deck" })).toMatch(/^REDIRECT \/onboarding\?error=This%20account/);
    expect(state.calls).toHaveLength(1);
  });
});
