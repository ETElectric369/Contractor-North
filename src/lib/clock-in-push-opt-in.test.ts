import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CLOCK-IN REMINDER STARTS OFF (cn-v1192). The owner, asked whether the new switch starts on or
 * off: "Start off". clock_in is an OPT-IN kind, like day_ahead: through notifyPeople a person is
 * pushed only when they turned Clock-in Reminders on, and the bell line is written only for the
 * people pushed. The REAL lib/push decides which kinds are opt-in (its DEFAULTS); only the send is a
 * stand-in, answering with the people whose own switch is on, as sendPushToProfiles does.
 */
const bell = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const switchedOn = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: async (rows: Record<string, unknown>[]) => {
        bell.rows.push(...rows);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/push", async (orig) => ({
  ...(await orig<typeof import("@/lib/push")>()),
  sendPushToProfiles: vi.fn(async (ids: string[]) => ids.filter((id) => switchedOn.ids.includes(id))),
}));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { notifyPeople } from "./notifications";
import { pushKindIsOptIn } from "./push";

const words = { title: "Time to Clock In", body: "You were scheduled to start at 9:00 AM and haven't clocked in. Tap to clock in.", url: "/timeclock" };

beforeEach(() => {
  bell.rows = [];
  switchedOn.ids = [];
});

describe("clock_in is opt-in", () => {
  it("is an opt-in kind in lib/push; its sibling clock_out is not", () => {
    expect(pushKindIsOptIn("clock_in")).toBe(true);
    expect(pushKindIsOptIn("clock_out")).toBe(false);
  });

  it("nobody switched it on: nobody is pushed and no bell line is written", async () => {
    const res = await notifyPeople("org-larkspur", ["p-sam-tillery"], "clock_in", words);
    expect(res).toEqual({ bell: true, pushed: [] });
    expect(bell.rows).toEqual([]);
  });

  it("the person who switched it on is pushed and gets the line; the other gets neither", async () => {
    switchedOn.ids = ["p-dana-rook"];
    const res = await notifyPeople("org-larkspur", ["p-sam-tillery", "p-dana-rook"], "clock_in", words);
    expect(res.pushed).toEqual(["p-dana-rook"]);
    expect(bell.rows.map((r) => [r.user_id, r.type])).toEqual([["p-dana-rook", "clock_in"]]);
  });
});
