import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE LONG-SHIFT JOB AFTER A SWITCH JOB (audit v994 SW1), pinned without a database.
 *
 * Brian clocks in at 7:00 AM on job A, switches to job B at 3:00 PM (0288 cuts: A closes, B opens
 * pointing at A) and forgets. The office's bell comes at 5:00 PM and names 7:00 AM, ten hours in;
 * the question and the buzz at 7:00 PM. A step that already went out on A is not sent again on B.
 * The family read is ONE query, scoped to the org by hand (the service client bypasses RLS).
 */
const state = vi.hoisted(() => ({ client: null as any }));
const spies = vi.hoisted(() => ({ notify: [] as any[], push: [] as any[] }));

vi.mock("@/lib/cron-guard", () => ({ requireCron: vi.fn(() => ({ supabase: state.client })) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  createNotifications: vi.fn(async (...a: any[]) => {
    spies.notify.push(a);
    return true;
  }),
}));
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => void spies.push.push(a)),
  orgStaffIdsOrThrow: vi.fn(async () => ["erik-1"]),
}));

import { GET } from "./route";

type Q = { table: string; verb: "select" | "update"; cols: string; payload?: any; filters: any[] };

function fakeSupabase(open: any[], family: any[] | { error: any }, calls: Q[]) {
  return {
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const answer = () => {
        if (table === "organizations") return { data: [{ id: "org-1", settings: { timezone: "America/Los_Angeles" } }], error: null };
        if (table === "time_entries" && q.verb === "select" && q.filters.some((f) => f[0] === "or" && String(f[1]).startsWith("id.in.")))
          return Array.isArray(family) ? { data: family, error: null } : { data: null, error: family.error };
        if (table === "time_entries" && q.verb === "select") return { data: open, error: null };
        if (table === "time_entries" && q.verb === "update") return { data: [{ id: "x" }], error: null };
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
        eq: (...a: any[]) => (q.filters.push(["eq", ...a]), chain),
        is: (...a: any[]) => (q.filters.push(["is", ...a]), chain),
        or: (...a: any[]) => (q.filters.push(["or", ...a]), chain),
        then(ok: any, bad: any) {
          return Promise.resolve().then(answer).then(ok, bad);
        },
      };
      return chain;
    },
  };
}

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
// Thursday 2001-01-04, Pacific (UTC-8). Nobody worked it.
const pacific = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return Date.parse("2001-01-04T08:00:00Z") + h * 3_600_000 + m * 60_000;
};
const iso = (hm: string) => new Date(pacific(hm)).toISOString();
const head = { id: A, profile_id: "brian-1", clock_in: iso("07:00"), clock_out: iso("15:00"), status: "closed", split_from: null };
const running = (extra: any = {}) => ({
  id: B,
  profile_id: "brian-1",
  clock_in: iso("15:00"),
  split_from: A,
  long_shift_warned_at: null,
  long_shift_nudged_at: null,
  job: { job_number: "J-105", name: "Rhodesia" },
  profiles: { full_name: "Brian Cole", role: "tech", active: true },
  ...extra,
});
const req = () => new Request("https://x/api/timeclock/long-shift");

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
  spies.notify.length = 0;
  spies.push.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("GET /api/timeclock/long-shift after a Switch Job", () => {
  it("5:00 PM: the office's bell line names the start of the day, ten hours in", async () => {
    vi.setSystemTime(pacific("17:00"));
    const b = running();
    state.client = fakeSupabase([b], [head, { ...b, status: "open", clock_out: null }], calls);
    const res = await (await GET(req())).json();
    expect(res).toMatchObject({ bells_due: 1, nudges_due: 0, office_bells: 1 });
    expect(spies.notify).toHaveLength(1);
    // He was on job A at 7:00 AM: the start is the shift's, and Rhodesia is named with the switch.
    expect(spies.notify[0][2].body).toMatch(
      /^On the clock since Thu 7:00 AM, 10 hours; at Rhodesia since 3:00 PM\. .+ At 12 hours Brian is asked\.$/,
    );
    expect(spies.notify[0][2].body).not.toMatch(/Clocked in Thu 7:00 AM at Rhodesia/);
    const fam = calls.find((c) => c.filters.some((f) => f[0] === "or" && String(f[1]).startsWith("id.in.")))!;
    expect(fam.filters).toContainEqual(["or", `id.in.(${A}),split_from.in.(${A})`]);
    expect(fam.filters).toContainEqual(["eq", "org_id", "org-1"]);
  });

  it("7:00 PM: the question and the buzz, twelve hours into the shift", async () => {
    vi.setSystemTime(pacific("19:00"));
    const b = running();
    state.client = fakeSupabase([b], [{ ...head, long_shift_warned_at: iso("17:00") }, b], calls);
    const res = await (await GET(req())).json();
    // The bell went out on the piece before the switch: not again.
    expect(res).toMatchObject({ bells_due: 0, nudges_due: 1, asked: 1, office_buzzes: 1 });
    expect(spies.push.map(([to, kind]) => [to, kind])).toEqual([
      [["brian-1"], "clock_out"],
      [["erik-1"], "long_shift"],
    ]);
    expect(spies.push[0][1]).toBe("clock_out");
    expect(spies.push[0][2].body).toBe("You've been on the clock since Thu 7:00 AM (at Rhodesia since 3:00 PM). Tap to set when you stopped.");
    expect(spies.push[1][2].body).toMatch(/^On the clock since Thu 7:00 AM, 12 hours; at Rhodesia since 3:00 PM\. Brian has been asked/);
  });

  it("a failed family read fails this org's run loudly, and nothing is sent", async () => {
    vi.setSystemTime(pacific("19:00"));
    state.client = fakeSupabase([running()], { error: { message: "boom" } }, calls);
    const res = await (await GET(req())).json();
    expect(res).toMatchObject({ failed: 1, office_bells: 0, asked: 0 });
    expect(spies.notify).toEqual([]);
    expect(spies.push).toEqual([]);
  });
});
