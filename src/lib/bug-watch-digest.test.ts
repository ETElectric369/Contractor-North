import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE MONDAY DIGEST (cn-v1136): on North's own Monday (PLATFORM_TZ, not the server's UTC day and not
 * any company's clock), once per ISO week, every platform admin with a company gets the week's
 * numbers under bug_watch. Every count is checked — a count that could not be read throws, never a
 * quiet week — and the claim on the week is spent last, after the counts and the admins are in hand.
 */
const spies = vi.hoisted(() => ({
  admins: vi.fn(async () => [] as { id: string; org_id: string | null }[]),
  notify: vi.fn(async () => ({ bell: true, pushed: [] as string[] })),
  limited: vi.fn(async () => false),
}));
vi.mock("@/lib/platform-alert", () => ({ platformAdminProfiles: spies.admins }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: spies.notify }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: spies.limited }));

import { digestWords, isoWeekKey, readDigestCounts, sendBugWatchDigest, type DigestCounts } from "./bug-watch-digest";
import { PLATFORM_TZ } from "./platform-tz";

type Q = { table: string; cols: string; head: boolean; calls: [string, unknown[]][] };
type Answer = { data?: unknown; count?: number | null; error?: unknown };

/** A pretend service client: every read is recorded, and `route` answers it by what it asked. */
function fakeClient(route: (q: Q) => Answer) {
  const seen: Q[] = [];
  const client = {
    from(table: string) {
      const q: Q = { table, cols: "", head: false, calls: [] };
      seen.push(q);
      const b: any = {
        select(cols: string, opts?: { head?: boolean }) {
          q.cols = cols;
          q.head = !!opts?.head;
          return b;
        },
        then(ok: (v: Answer) => unknown, bad?: (e: unknown) => unknown) {
          return Promise.resolve()
            .then(() => ({ data: null, count: null, error: null, ...route(q) }))
            .then(ok, bad);
        },
      };
      for (const m of ["eq", "gte", "lt", "neq", "in", "or", "order", "limit"]) {
        b[m] = (...a: unknown[]) => {
          q.calls.push([m, a]);
          return b;
        };
      }
      return b;
    },
  };
  return { client, seen };
}

const has = (q: Q, m: string, ...a: unknown[]) => q.calls.some(([n, args]) => n === m && JSON.stringify(args) === JSON.stringify(a));

const QUIET: DigestCounts = { open: 0, newByLevel: { error: 0, blocker: 0 }, blockers: [], stale: 0, top: [] };
const BUSY: DigestCounts = {
  open: 3,
  newByLevel: { error: 11, blocker: 1 },
  blockers: [{ culprit: "stripe:webhook:refused", event_count: 40 }],
  stale: 3,
  top: [
    { culprit: "rsc-render", event_count: 12 },
    { culprit: "client:error-boundary", event_count: 3 },
  ],
};

/** Routes the digest's six reads to a DigestCounts; `fail` names the read that answers an error. */
function answering(c: DigestCounts, fail?: "open" | "stale" | "top") {
  return (q: Q): Answer => {
    const down = { error: { message: `${q.table} unreachable` } };
    if (q.table === "bug_reports") return fail === "open" ? down : { count: c.open };
    if (q.table !== "error_events") throw new Error(`unexpected table ${q.table}`);
    if (q.head && has(q, "eq", "level", "error")) return { count: c.newByLevel.error };
    if (q.head && has(q, "eq", "level", "blocker")) return { count: c.newByLevel.blocker };
    if (q.head && has(q, "in", "status", ["new", "triaged"])) return fail === "stale" ? down : { count: c.stale };
    if (!q.head && has(q, "eq", "level", "blocker")) return { data: c.blockers };
    if (!q.head) return fail === "top" ? down : { data: c.top };
    throw new Error(`unexpected read ${JSON.stringify(q)}`);
  };
}

const ORG = "6f1c2a3e-9b4d-4c5e-8f6a-1b2c3d4e5f60";
const at = (iso: string) => Date.parse(iso);

beforeEach(() => {
  spies.admins.mockReset();
  spies.notify.mockReset();
  spies.limited.mockReset();
  spies.admins.mockResolvedValue([{ id: "erik", org_id: ORG }]);
  spies.notify.mockResolvedValue({ bell: true, pushed: ["erik"] });
  spies.limited.mockResolvedValue(false);
});

describe("the Monday gate, on North's own clock, across the 2026-11-01 end of daylight time", () => {
  it("Sunday 2026-11-01 15:00 UTC (7 AM Pacific, standard time again) is not Monday: nothing read, nothing claimed", async () => {
    const { client, seen } = fakeClient(answering(BUSY));
    expect(await sendBugWatchDigest(client, at("2026-11-01T15:00:00Z"))).toEqual({ sent: 0, skipped: "not Monday" });
    expect(seen).toHaveLength(0);
    expect(spies.limited).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("Monday 2026-11-02 15:00 UTC (7 AM Pacific) is Monday: the digest goes", async () => {
    const { client } = fakeClient(answering(BUSY));
    expect(await sendBugWatchDigest(client, at("2026-11-02T15:00:00Z"))).toEqual({ sent: 1 });
    expect(spies.notify).toHaveBeenCalledTimes(1);
  });

  it("Monday 07:30 UTC is still Sunday night in Pacific (not Monday); Tuesday 07:30 UTC is Monday night (Monday)", async () => {
    expect(await sendBugWatchDigest(fakeClient(answering(BUSY)).client, at("2026-11-02T07:30:00Z"))).toEqual({ sent: 0, skipped: "not Monday" });
    expect(await sendBugWatchDigest(fakeClient(answering(BUSY)).client, at("2026-11-03T07:30:00Z"))).toEqual({ sent: 1 });
  });

  /**
   * THE GATE ADMITS MONDAY, TUESDAY AND WEDNESDAY (skeptic #42, N1): a Monday whose counts threw used to
   * lose the week. The weekly claim keeps it to one digest; Thursday onward is "not Monday".
   */
  describe("a Monday that failed is not a lost week", () => {
    it("Tuesday after a FAILED Monday (the claim was never spent) sends", async () => {
      await expect(sendBugWatchDigest(fakeClient(answering(BUSY, "open")).client, at("2026-11-02T15:00:00Z"))).rejects.toThrow(/unreachable/);
      expect(spies.limited).not.toHaveBeenCalled();
      expect(await sendBugWatchDigest(fakeClient(answering(BUSY)).client, at("2026-11-03T15:00:00Z"))).toEqual({ sent: 1 });
      expect(spies.limited).toHaveBeenCalledWith("bug-watch-digest:2026-W45", 1, 7 * 86_400);
      expect(spies.notify).toHaveBeenCalledTimes(1);
    });

    it("Tuesday after a SENT Monday: the week's claim refuses — already sent, nothing notified", async () => {
      expect(await sendBugWatchDigest(fakeClient(answering(BUSY)).client, at("2026-11-02T15:00:00Z"))).toEqual({ sent: 1 });
      spies.limited.mockResolvedValue(true); // the claim is spent for 2026-W45
      expect(await sendBugWatchDigest(fakeClient(answering(BUSY)).client, at("2026-11-03T15:00:00Z"))).toEqual({ sent: 0, skipped: "already sent" });
      expect(await sendBugWatchDigest(fakeClient(answering(BUSY)).client, at("2026-11-04T15:00:00Z"))).toEqual({ sent: 0, skipped: "already sent" });
      expect(spies.notify).toHaveBeenCalledTimes(1);
    });

    it("Wednesday is the last door; Thursday, Friday and Saturday are not Monday: nothing read, nothing claimed", async () => {
      expect(await sendBugWatchDigest(fakeClient(answering(BUSY)).client, at("2026-11-04T15:00:00Z"))).toEqual({ sent: 1 });
      spies.notify.mockClear();
      for (const day of ["2026-11-05", "2026-11-06", "2026-11-07"]) {
        const { client, seen } = fakeClient(answering(BUSY));
        expect(await sendBugWatchDigest(client, at(`${day}T15:00:00Z`)), day).toEqual({ sent: 0, skipped: "not Monday" });
        expect(seen, day).toHaveLength(0);
      }
      expect(spies.notify).not.toHaveBeenCalled();
    });
  });
});

describe("isoWeekKey", () => {
  it("rolls on Monday in the platform's zone, and the ISO year holds the week's Thursday", () => {
    expect(isoWeekKey(at("2026-11-01T15:00:00Z"), PLATFORM_TZ)).toBe("2026-W44"); // Sunday
    expect(isoWeekKey(at("2026-11-02T15:00:00Z"), PLATFORM_TZ)).toBe("2026-W45"); // Monday
    expect(isoWeekKey(at("2026-11-02T07:30:00Z"), PLATFORM_TZ)).toBe("2026-W44"); // Monday in UTC, Sunday night Pacific
    expect(isoWeekKey(at("2027-01-01T20:00:00Z"), PLATFORM_TZ)).toBe("2026-W53"); // a Friday: 2026 has 53 ISO weeks
    expect(isoWeekKey(at("2024-12-30T20:00:00Z"), PLATFORM_TZ)).toBe("2025-W01"); // a Monday that belongs to the new year
  });
});

describe("once per week", () => {
  it("already sent this ISO week (the claim refused): skipped, nothing notified; the claim is failed-open and named by the week", async () => {
    spies.limited.mockResolvedValue(true);
    const { client, seen } = fakeClient(answering(BUSY));
    expect(await sendBugWatchDigest(client, at("2026-11-02T15:00:00Z"))).toEqual({ sent: 0, skipped: "already sent" });
    expect(spies.limited).toHaveBeenCalledWith("bug-watch-digest:2026-W45", 1, 7 * 86_400);
    expect(spies.limited.mock.calls[0]).toHaveLength(3); // no failClosed: an outage may double, never silence
    expect(spies.notify).not.toHaveBeenCalled();
    expect(seen.length).toBeGreaterThan(0); // the counts were read first: a re-run after a failed count still sends
  });
});

describe("the words", () => {
  it("a quiet week", () => {
    expect(digestWords(QUIET)).toEqual({ title: "Bug Watch: All Quiet This Week", body: "Nothing new in the sink this week." });
  });

  it("the full digest: the two numbers in the title, the blockers first, the most-seen culprits (lifetime counts, said so), the stale count", () => {
    expect(digestWords(BUSY)).toEqual({
      title: "Bug Watch: 3 Open Reports · 12 New Errors This Week",
      body: "1 blocker: stripe:webhook:refused · Most seen overall: rsc-render ×12, client:error-boundary ×3 · 3 open longer than 30 days",
    });
  });

  it("a week with repeats is not quiet (N3): nothing open, nothing new, no blocker, but a most-seen list → the normal title", () => {
    expect(digestWords({ ...QUIET, top: [{ culprit: "rsc-render", event_count: 40 }] })).toEqual({
      title: "Bug Watch: 0 Open Reports · 0 New Errors This Week",
      body: "Most seen overall: rsc-render ×40",
    });
  });

  it("plurals", () => {
    expect(digestWords({ ...QUIET, open: 1, newByLevel: { error: 1, blocker: 0 } }).title).toBe("Bug Watch: 1 Open Report · 1 New Error This Week");
    expect(digestWords({ ...QUIET, open: 0, newByLevel: { error: 2, blocker: 0 } }).title).toBe("Bug Watch: 0 Open Reports · 2 New Errors This Week");
    expect(
      digestWords({
        ...QUIET,
        blockers: [
          { culprit: "email:send", event_count: 2 },
          { culprit: "nort:model-dead", event_count: 1 },
        ],
        stale: 1,
      }),
    ).toEqual({
      // Blockers seen this week make the week not quiet, even with nothing new and nothing open.
      title: "Bug Watch: 0 Open Reports · 0 New Errors This Week",
      body: "2 blockers: email:send, nort:model-dead · 1 open longer than 30 days",
    });
  });

  it("a quiet title can still carry old rows in the body (the stale count is not a repeat)", () => {
    expect(digestWords({ ...QUIET, stale: 4 })).toEqual({ title: "Bug Watch: All Quiet This Week", body: "4 open longer than 30 days" });
  });
});

describe("the reads", () => {
  it("six reads, each with its window: open reports by the Bugs page's rule, new rows by level, the week's blockers, the stale, the top three", async () => {
    const now = at("2026-11-02T15:00:00Z");
    const { client, seen } = fakeClient(answering(BUSY));
    expect(await readDigestCounts(client, now)).toEqual(BUSY);
    const since7 = new Date(now - 7 * 86_400_000).toISOString();
    const since30 = new Date(now - 30 * 86_400_000).toISOString();
    expect(seen.map((q) => q.table)).toEqual(["bug_reports", "error_events", "error_events", "error_events", "error_events", "error_events"]);
    expect(has(seen[0], "or", "status.is.null,status.eq.open")).toBe(true);
    expect(seen[0].head).toBe(true);
    expect(has(seen[1], "gte", "first_seen", since7)).toBe(true);
    expect(has(seen[2], "gte", "first_seen", since7)).toBe(true);
    expect(has(seen[3], "gte", "last_seen", since7) && has(seen[3], "eq", "level", "blocker")).toBe(true);
    expect(has(seen[4], "lt", "first_seen", since30) && has(seen[4], "neq", "level", "trace")).toBe(true);
    expect(has(seen[5], "gte", "last_seen", since7) && has(seen[5], "neq", "level", "trace") && has(seen[5], "limit", 3)).toBe(true);
    expect(has(seen[5], "order", "event_count", { ascending: false })).toBe(true);
  });

  it.each(["open", "stale", "top"] as const)("a failed count (%s) THROWS — never a quiet week — and the claim is not spent", async (fail) => {
    const { client } = fakeClient(answering(BUSY, fail));
    await expect(sendBugWatchDigest(client, at("2026-11-02T15:00:00Z"))).rejects.toMatchObject({ message: expect.stringContaining("unreachable") });
    expect(spies.limited).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("a head count that comes back without a number throws too", async () => {
    const { client } = fakeClient((q) => (q.table === "bug_reports" ? { count: null } : answering(BUSY)(q)));
    await expect(sendBugWatchDigest(client, at("2026-11-02T15:00:00Z"))).rejects.toThrow("open bug reports: the count did not come back");
  });
});

describe("who gets it", () => {
  it("one notifyPeople per admin with a company, under bug_watch, to /bugs, with the words", async () => {
    spies.admins.mockResolvedValue([
      { id: "erik", org_id: ORG },
      { id: "second", org_id: ORG },
      { id: "orgless", org_id: null },
    ]);
    const { client } = fakeClient(answering(BUSY));
    expect(await sendBugWatchDigest(client, at("2026-11-02T15:00:00Z"))).toEqual({ sent: 2 });
    expect(spies.notify).toHaveBeenCalledTimes(2);
    expect(spies.notify).toHaveBeenCalledWith(ORG, ["erik"], "bug_watch", {
      title: "Bug Watch: 3 Open Reports · 12 New Errors This Week",
      body: "1 blocker: stripe:webhook:refused · Most seen overall: rsc-render ×12, client:error-boundary ×3 · 3 open longer than 30 days",
      url: "/bugs",
    });
    expect(spies.notify).toHaveBeenCalledWith(ORG, ["second"], "bug_watch", expect.anything());
  });

  it("no admins (or none with a company): skipped, the claim not spent", async () => {
    spies.admins.mockResolvedValue([]);
    expect(await sendBugWatchDigest(fakeClient(answering(QUIET)).client, at("2026-11-02T15:00:00Z"))).toEqual({ sent: 0, skipped: "no admins" });
    spies.admins.mockResolvedValue([{ id: "orgless", org_id: null }]);
    expect(await sendBugWatchDigest(fakeClient(answering(QUIET)).client, at("2026-11-02T15:00:00Z"))).toEqual({ sent: 0, skipped: "no admins" });
    expect(spies.limited).not.toHaveBeenCalled();
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("a failed admins read throws through", async () => {
    spies.admins.mockRejectedValue(new Error("platform_admins unreachable"));
    await expect(sendBugWatchDigest(fakeClient(answering(QUIET)).client, at("2026-11-02T15:00:00Z"))).rejects.toThrow("platform_admins unreachable");
  });
});
