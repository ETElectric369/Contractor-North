import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE LONG-SHIFT JOB'S TWO STEPS, pinned without a database (Erik, 2026-09-24: "Put a line on the
 * Bell at 10 hours and buzz at 12").
 *
 * What lives here is what the route does with the picker's answer: each step is CLAIMED before
 * anything is sent (a zero-row claim sends nothing), the 10-hour step is a bell line to the office
 * and never a push, the 12-hour step asks the crew member and buzzes the office on its own switch,
 * and the night holds the pushes only. The claim columns themselves are proven in
 * close-in-time.integration.test.ts. The fake refuses any statement it was not told about.
 */

const state = vi.hoisted(() => ({ client: null as any }));
const spies = vi.hoisted(() => ({ notify: [] as any[], push: [] as any[], notifyOk: true, staffFails: false }));

vi.mock("@/lib/cron-guard", () => ({ requireCron: vi.fn(() => ({ supabase: state.client })) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  createNotifications: vi.fn(async (...a: any[]) => {
    spies.notify.push(a);
    return spies.notifyOk;
  }),
}));
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => void spies.push.push(a)),
  orgStaffIdsOrThrow: vi.fn(async () => {
    if (spies.staffFails) throw new Error("profiles lookup failed");
    return ["erik-1", "alexa-1"];
  }),
}));

import { GET } from "./route";

type Q = { table: string; verb: "select" | "update"; cols: string; payload?: any; filters: any[] };

/** `claims`: the columns a claim may take per entry id; a claim not listed matches zero rows. */
function fakeSupabase(rows: any[], claims: Record<string, string[]>, calls: Q[]) {
  return {
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const answer = () => {
        if (table === "organizations") return { data: [{ id: "org-1", settings: { timezone: "America/Los_Angeles" } }], error: null };
        if (table === "time_entries" && q.verb === "select") return { data: rows, error: null };
        if (table === "time_entries" && q.verb === "update") {
          const id = q.filters.find((f) => f[0] === "eq" && f[1] === "id")?.[2];
          const col = Object.keys(q.payload)[0];
          return { data: (claims[id] ?? []).includes(col) ? [{ id }] : [], error: null };
        }
        throw new Error(`unrouted: ${table}.${q.verb}`);
      };
      const chain: any = {
        select(cols?: string) {
          if (q.verb === "select") q.cols = cols ?? "";
          return chain;
        },
        update(p: any) {
          q.verb = "update";
          q.payload = p;
          return chain;
        },
        eq(...a: any[]) {
          q.filters.push(["eq", ...a]);
          return chain;
        },
        is(...a: any[]) {
          q.filters.push(["is", ...a]);
          return chain;
        },
        or(...a: any[]) {
          q.filters.push(["or", ...a]);
          return chain;
        },
        then(ok: any, bad: any) {
          return Promise.resolve().then(answer).then(ok, bad);
        },
      };
      return chain;
    },
  };
}

const H = 3_600_000;
// Thursday 2001-01-04 in Pacific (PST, UTC-8). Nobody worked it.
const pacific = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return Date.parse("2001-01-04T08:00:00Z") + h * H + m * 60_000;
};
const brian = (hoursIn: number, now: number, extra: any = {}) => ({
  id: "entry-b",
  profile_id: "brian-1",
  clock_in: new Date(now - hoursIn * H).toISOString(),
  long_shift_warned_at: null,
  long_shift_nudged_at: null,
  job: { job_number: "J-104", name: "Herringbone" },
  profiles: { full_name: "Brian Cole", role: "tech", active: true },
  ...extra,
});
const req = () => new Request("https://x/api/timeclock/long-shift");

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
  spies.notify.length = 0;
  spies.push.length = 0;
  spies.notifyOk = true;
  spies.staffFails = false;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("GET /api/timeclock/long-shift", () => {
  it("reads only open rows with a step still owed, in this org", async () => {
    vi.setSystemTime(pacific("12:00"));
    state.client = fakeSupabase([], {}, calls);
    await GET(req());
    const read = calls.find((c) => c.table === "time_entries")!;
    expect(read.cols).toMatch(/long_shift_warned_at/);
    expect(read.filters).toContainEqual(["eq", "org_id", "org-1"]);
    expect(read.filters).toContainEqual(["eq", "status", "open"]);
    expect(read.filters).toContainEqual(["or", "long_shift_warned_at.is.null,long_shift_nudged_at.is.null"]);
  });

  it("at 10 hours: claims the bell step, then a bell line to the office, and no push at all", async () => {
    const now = pacific("18:00");
    vi.setSystemTime(now);
    state.client = fakeSupabase([brian(10, now)], { "entry-b": ["long_shift_warned_at"] }, calls);
    const res = await (await GET(req())).json();
    const claim = calls.find((c) => c.verb === "update")!;
    expect(Object.keys(claim.payload)).toEqual(["long_shift_warned_at"]);
    expect(claim.filters).toContainEqual(["is", "long_shift_warned_at", null]);
    expect(claim.filters).toContainEqual(["eq", "status", "open"]);
    expect(spies.push).toEqual([]);
    expect(spies.notify).toHaveLength(1);
    const [org, to, n] = spies.notify[0];
    expect(org).toBe("org-1");
    expect(to).toEqual(["erik-1", "alexa-1"]);
    expect(n).toMatchObject({ type: "long_shift", title: "Brian Is Still On The Clock", url: "/timecards?entry=entry-b" });
    expect(n.body).toMatch(/^Clocked in Thu 8:00 AM at .+, 10 hours ago\. If the shift is over, Clock Out Brian on Timecards\. At 12 hours Brian is asked\.$/);
    expect(res).toMatchObject({ office_bells: 1, asked: 0, office_buzzes: 0, failed: 0 });
  });

  it("a claim another run already took sends nothing", async () => {
    const now = pacific("18:00");
    vi.setSystemTime(now);
    state.client = fakeSupabase([brian(10, now)], {}, calls);
    await GET(req());
    expect(spies.notify).toEqual([]);
    expect(spies.push).toEqual([]);
  });

  it("at 12 hours: asks Brian (push and bell) and buzzes the office on its own switch", async () => {
    const now = pacific("20:00");
    vi.setSystemTime(now);
    const row = brian(12, now, { long_shift_warned_at: new Date(now - 2 * H).toISOString() });
    state.client = fakeSupabase([row], { "entry-b": ["long_shift_nudged_at"] }, calls);
    const res = await (await GET(req())).json();
    expect(calls.filter((c) => c.verb === "update").map((c) => Object.keys(c.payload)[0])).toEqual(["long_shift_nudged_at"]);
    expect(spies.push.map(([to, kind]) => [to, kind])).toEqual([
      [["brian-1"], "clock_out"],
      [["erik-1", "alexa-1"], "long_shift"],
    ]);
    expect(spies.push[1][2].body).toMatch(/12 hours ago\. Brian has been asked when the shift ended\. Clock Out Brian on Timecards if you know\.$/);
    expect(spies.notify.map(([, to]) => to)).toEqual([["brian-1"]]); // the office's bell line went out at 10
    expect(res).toMatchObject({ office_bells: 0, asked: 1, office_buzzes: 1 });
  });

  it("the night holds the pushes, never the bell line", async () => {
    // 11 PM, a 10:30 AM clock-in the job never reached (it was down): both steps are owed. The bell
    // line goes out now; the question and the buzz wait for the 6 AM run, unclaimed.
    const now = pacific("23:00");
    vi.setSystemTime(now);
    const late = { ...brian(12.5, now), id: "entry-l" };
    state.client = fakeSupabase([late], { "entry-l": ["long_shift_warned_at", "long_shift_nudged_at"] }, calls);
    const res = await (await GET(req())).json();
    expect(calls.filter((c) => c.verb === "update").map((c) => Object.keys(c.payload)[0])).toEqual(["long_shift_warned_at"]);
    expect(spies.push).toEqual([]);
    expect(spies.notify).toHaveLength(1);
    // Already past 12: the line promises nothing about a question that is not ahead of it.
    expect(spies.notify[0][2].body).toMatch(/12 hours ago\. If the shift is over, Clock Out Brian on Timecards\.$/);
    expect(res).toMatchObject({ held: 1, office_bells: 1, asked: 0, office_buzzes: 0 });
  });

  it("a bell line whose 12-hour mark falls in the night says he is asked in the morning", async () => {
    // Brian's 1:37 PM clock-in: the line goes up at 11:37 PM; twelve hours is 1:37 AM, held till 6.
    const now = pacific("23:37");
    vi.setSystemTime(now);
    state.client = fakeSupabase([brian(10, now)], { "entry-b": ["long_shift_warned_at"] }, calls);
    await GET(req());
    expect(spies.notify[0][2].body).toMatch(/Clock Out Brian on Timecards\. Brian is asked in the morning\.$/);
  });

  it("a bell line the database refused gives its claim back and is not counted as sent", async () => {
    const now = pacific("18:00");
    vi.setSystemTime(now);
    spies.notifyOk = false;
    state.client = fakeSupabase([brian(10, now)], { "entry-b": ["long_shift_warned_at"] }, calls);
    const res = await (await GET(req())).json();
    const updates = calls.filter((c) => c.verb === "update");
    expect(updates).toHaveLength(2);
    const [claim, release] = updates;
    expect(release.payload).toEqual({ long_shift_warned_at: null });
    // Only the stamp THIS run wrote is given back, never another run's claim.
    expect(release.filters).toContainEqual(["eq", "long_shift_warned_at", claim.payload.long_shift_warned_at]);
    expect(res).toMatchObject({ office_bells: 0, failed: 1 });
  });

  it("an office lookup that fails spends no claim and is reported", async () => {
    const now = pacific("20:00");
    vi.setSystemTime(now);
    spies.staffFails = true;
    state.client = fakeSupabase([brian(12, now)], { "entry-b": ["long_shift_warned_at", "long_shift_nudged_at"] }, calls);
    const res = await (await GET(req())).json();
    expect(calls.filter((c) => c.verb === "update")).toEqual([]);
    expect(spies.notify).toEqual([]);
    expect(spies.push).toEqual([]);
    expect(res).toMatchObject({ failed: 1, office_bells: 0, office_buzzes: 0 });
  });

  it("the office does not hear about a staff member's own clock; he is still asked", async () => {
    const now = pacific("20:00");
    vi.setSystemTime(now);
    const erik = brian(12, now, { id: "entry-e", profile_id: "erik-1", profiles: { full_name: "Erik Taylor", role: "owner", active: true } });
    state.client = fakeSupabase([erik], { "entry-e": ["long_shift_warned_at", "long_shift_nudged_at"] }, calls);
    await GET(req());
    expect(spies.push.map(([to, kind]) => [to, kind])).toEqual([[["erik-1"], "clock_out"]]);
    expect(spies.notify.map(([, to]) => to)).toEqual([["erik-1"]]);
  });

  it("a removed person's phone is never pushed, but the office still hears about his clock", async () => {
    const now = pacific("20:00");
    vi.setSystemTime(now);
    const gone = brian(12, now, { profiles: { full_name: "Brian Cole", role: "tech", active: false } });
    state.client = fakeSupabase([gone], { "entry-b": ["long_shift_warned_at", "long_shift_nudged_at"] }, calls);
    await GET(req());
    expect(spies.push.map(([to, kind]) => [to, kind])).toEqual([[["erik-1", "alexa-1"], "long_shift"]]);
    expect(spies.push[0][2].body).toMatch(/\(no longer on your crew\)\. Clock Out Brian on Timecards if you know\.$/);
    expect(spies.notify.map(([, to]) => to)).toEqual([["erik-1", "alexa-1"]]);
  });
});
