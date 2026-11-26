import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * TIMECLOCK REMINDERS GO OUT BY IS SAVED THROUGH THE SCHEDULING CARD'S DOOR (cn-v1190):
 * updateOrgSettings, the same staff context and the same "a zero-row write is not a save" answer.
 * What the browser sends is never trusted: one of Push, Text or Both is stored; anything else is
 * refused in one sentence, before the company is even read, and nothing is written.
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
    single: async () => ({ data: { settings: { work_day_start: "07:00", remind_timeclock: false } }, error: null }),
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
const REFUSED = "Timeclock reminders didn't save: pick Push, Text or Both, then tap Save Changes.";

beforeEach(() => {
  state.wrote = [{ id: "org-1" }];
  state.updates = [];
  state.ctx = 0;
});

describe("saving Timeclock Reminders Go Out By", () => {
  it("each of the three is stored, merged over the rest (the old box is left as it was)", async () => {
    for (const by of ["push", "text", "both"]) {
      state.updates = [];
      expect(await updateOrgSettings({ remind_timeclock_by: by })).toEqual({ ok: true });
      expect(state.updates[0].settings).toEqual({ work_day_start: "07:00", remind_timeclock: false, remind_timeclock_by: by });
    }
  });

  it("anything else is refused in one sentence, nothing read or written", async () => {
    for (const junk of ["Push", "sms", "", null, undefined, 1, true, ["push"], { by: "push" }]) {
      expect(await updateOrgSettings({ work_day_start: "08:00", remind_timeclock_by: junk }), String(junk)).toEqual({ ok: false, error: REFUSED });
    }
    expect(state.updates).toEqual([]);
    expect(state.ctx).toBe(0);
  });

  it("a save that does not name it is untouched by the check", async () => {
    expect(await updateOrgSettings({ work_day_start: "08:00" })).toEqual({ ok: true });
  });
});
