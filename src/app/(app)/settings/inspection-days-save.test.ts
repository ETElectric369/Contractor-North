import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * INSPECTION DAYS ARE SAVED THROUGH THE WORKING DAY'S DOOR (cn-v1185): updateOrgSettings, the same
 * staff context and the same "a zero-row write is not a save" answer. What the browser sends is
 * never trusted: the shape is checked on the server and anything else is refused in words with
 * nothing written; only the five keys are stored, the days in week order.
 */
const state = vi.hoisted(() => ({
  wrote: [{ id: "org-1" }] as { id: string }[],
  updates: [] as Record<string, unknown>[],
  ctx: 0,
}));

function builder() {
  const b: any = {
    select: () => b,
    eq: () => b,
    single: async () => ({ data: { settings: { work_day_start: "07:00" } }, error: null }),
    update: (row: Record<string, unknown>) => {
      state.updates.push(row);
      const u: any = { eq: () => u, select: async () => ({ data: state.wrote, error: null }) };
      return u;
    },
  };
  return b;
}
const client = { from: () => builder(), rpc: async () => ({ data: null, error: null }) };
vi.mock("@/lib/site-editor-guard", () => ({
  resolveSiteContext: async () => {
    state.ctx++;
    return { supabase: client, userId: "me", orgId: "org-1", isCollaborator: false };
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustOrgPdfs: vi.fn(async () => {}) }));

const { updateOrgSettings } = await import("./actions");
const NOT_SAVED = "That didn't save — your role can't change company settings. Ask an owner or admin.";
const UNREADABLE = "Inspection Days didn't save: the days or times weren't readable. Reload the page and set them again.";
const GOOD = { offer: true, days: ["mon", "wed"], start: "09:00", end: "15:00", per_day: 3 };

beforeEach(() => {
  state.wrote = [{ id: "org-1" }];
  state.updates = [];
  state.ctx = 0;
});

describe("saving Inspection Days", () => {
  it("the pinned shape is stored, merged over the rest, days in week order", async () => {
    expect(await updateOrgSettings({ inspection_days: { ...GOOD, days: ["sat", "mon", "sun"] } })).toEqual({ ok: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].settings).toEqual({
      work_day_start: "07:00",
      inspection_days: { offer: true, days: ["sun", "mon", "sat"], start: "09:00", end: "15:00", per_day: 3 },
    });
  });

  it("an end not after the start is kept as typed (the card says nothing is offered)", async () => {
    expect(await updateOrgSettings({ inspection_days: { ...GOOD, start: "15:00", end: "09:00" } })).toEqual({ ok: true });
  });

  it("a role that may not save is refused exactly as the working day is", async () => {
    state.wrote = [];
    expect(await updateOrgSettings({ inspection_days: GOOD })).toEqual({ ok: false, error: NOT_SAVED });
    expect(await updateOrgSettings({ work_day_start: "08:00" })).toEqual({ ok: false, error: NOT_SAVED });
  });

  const BAD: [string, unknown][] = [
    ["not an object", "on"],
    ["an array", [GOOD]],
    ["null", null],
    ["offer not a boolean", { ...GOOD, offer: "true" }],
    ["an unknown weekday", { ...GOOD, days: ["mon", "funday"] }],
    ["a repeated weekday", { ...GOOD, days: ["mon", "mon"] }],
    ["days not a list", { ...GOOD, days: "mon" }],
    ["a start that is not HH:MM", { ...GOOD, start: "9:00" }],
    ["an end past midnight", { ...GOOD, end: "24:00" }],
    ["per_day 0", { ...GOOD, per_day: 0 }],
    ["per_day 9", { ...GOOD, per_day: 9 }],
    ["per_day a fraction", { ...GOOD, per_day: 2.5 }],
    ["per_day a string", { ...GOOD, per_day: "3" }],
    ["an extra key", { ...GOOD, note: "x" }],
    ["a missing key", { offer: true, days: ["mon"], start: "09:00", end: "15:00" }],
  ];
  for (const [why, value] of BAD) {
    it(`refused with nothing written: ${why}`, async () => {
      expect(await updateOrgSettings({ inspection_days: value })).toEqual({ ok: false, error: UNREADABLE });
      expect(state.updates).toHaveLength(0);
      expect(state.ctx).toBe(0);
    });
  }
});
