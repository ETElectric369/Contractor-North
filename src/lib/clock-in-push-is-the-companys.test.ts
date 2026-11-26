import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE CLOCK-IN REMINDER IS THE COMPANY'S, NEVER THE PERSON'S (cn-v1193). The owner: "the clock in
 * reminder setting should be controlled by the boss not the employee". The company's Clock-In
 * Reminders box (org-settings clockInRemindersOn) decides whether the sender runs at all; once it runs,
 * nobody can mute it for themselves. A person's stored push_prefs.clock_in (a value stored while
 * cn-v1192's per-person switch was live, or a crafted save) is never read; `active` still filters; and
 * clock_in is not an opt-in kind, so the bell line is written for EVERY due person, pushed or not.
 *
 * Through the REAL lib/push (sendPushToProfiles) and the REAL notifyPeople: only the database, the Web
 * Push library and Apple's sender are stand-ins.
 */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
});

const db = vi.hoisted(() => ({
  profiles: [] as { id: string; push_prefs: Record<string, unknown> | null; active: boolean }[],
  subs: [] as { id: string; profile_id: string; platform: string; endpoint: string; p256dh: string; auth: string }[],
  bell: [] as Record<string, unknown>[],
}));
const sent = vi.hoisted(() => ({ endpoints: [] as string[] }));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }) => {
      sent.endpoints.push(sub.endpoint);
    }),
  },
}));
vi.mock("@/lib/apns", () => ({ apnsConfigured: () => false, sendApns: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        in: async (col: string, ids: string[]) => {
          if (table === "profiles" && col === "id") return { data: db.profiles.filter((p) => ids.includes(p.id)), error: null };
          if (table === "push_subscriptions" && col === "profile_id") return { data: db.subs.filter((s) => ids.includes(s.profile_id)), error: null };
          return { data: [], error: null };
        },
      }),
      insert: async (rows: Record<string, unknown>[]) => {
        if (table === "notifications") db.bell.push(...rows);
        return { error: null };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

import { notifyPeople } from "./notifications";
import { pushKindIsOptIn, pushKindIsTheCompanys, sendPushToProfiles } from "./push";

const words = { title: "Time to Clock In", body: "You were scheduled to start at 9:00 AM and haven't clocked in. Tap to clock in.", url: "/timeclock" };
const sub = (id: string) => ({ id: `s-${id}`, profile_id: id, platform: "web", endpoint: `https://push.test/${id}`, p256dh: "k", auth: "a" });

beforeEach(() => {
  db.profiles = [
    // Turned the cn-v1192 switch OFF while it was live: inert now.
    { id: "p-sam-tillery", push_prefs: { clock_in: false }, active: true },
    // Never touched a switch.
    { id: "p-dana-rook", push_prefs: null, active: true },
    // Removed from the company: never pushed.
    { id: "p-gone", push_prefs: { clock_in: true }, active: false },
  ];
  db.subs = [sub("p-sam-tillery"), sub("p-dana-rook"), sub("p-gone")];
  db.bell = [];
  sent.endpoints = [];
});

describe("clock_in is the company's kind", () => {
  it("lib/push names it the company's, and not an opt-in kind; clock_out and day_ahead stay the person's", () => {
    expect(pushKindIsTheCompanys("clock_in")).toBe(true);
    expect(pushKindIsOptIn("clock_in")).toBe(false);
    expect(pushKindIsTheCompanys("clock_out")).toBe(false);
    expect(pushKindIsTheCompanys("day_ahead")).toBe(false);
    expect(pushKindIsOptIn("day_ahead")).toBe(true);
  });

  it("a stored clock_in false is still pushed, nothing stored is pushed, an inactive person is not", async () => {
    const went = await sendPushToProfiles(["p-sam-tillery", "p-dana-rook", "p-gone"], "clock_in", words);
    expect(went).toEqual(["p-sam-tillery", "p-dana-rook"]);
    expect(sent.endpoints).toEqual(["https://push.test/p-sam-tillery", "https://push.test/p-dana-rook"]);
  });

  it("a crafted stored value (a string, a zero) mutes nobody either", async () => {
    db.profiles[0].push_prefs = { clock_in: 0 };
    db.profiles[1].push_prefs = { clock_in: "" };
    expect(await sendPushToProfiles(["p-sam-tillery", "p-dana-rook"], "clock_in", words)).toEqual(["p-sam-tillery", "p-dana-rook"]);
  });

  it("a person's own switch still holds for the person's kinds: clock_out muted is not pushed", async () => {
    db.profiles[0].push_prefs = { clock_out: false };
    expect(await sendPushToProfiles(["p-sam-tillery", "p-dana-rook"], "clock_out", words)).toEqual(["p-dana-rook"]);
  });

  it("through notifyPeople: the bell line for every due person, then the push to every active one", async () => {
    const res = await notifyPeople("org-larkspur", ["p-sam-tillery", "p-dana-rook"], "clock_in", words);
    expect(res).toEqual({ bell: true, pushed: ["p-sam-tillery", "p-dana-rook"] });
    expect(db.bell.map((r) => [r.user_id, r.type])).toEqual([
      ["p-sam-tillery", "clock_in"],
      ["p-dana-rook", "clock_in"],
    ]);
  });

  it("the bell line is written even for a due person no push reaches (no device)", async () => {
    db.subs = [sub("p-dana-rook")];
    await notifyPeople("org-larkspur", ["p-sam-tillery", "p-dana-rook"], "clock_in", words);
    expect(db.bell.map((r) => r.user_id)).toEqual(["p-sam-tillery", "p-dana-rook"]);
    expect(sent.endpoints).toEqual(["https://push.test/p-dana-rook"]);
  });
});
