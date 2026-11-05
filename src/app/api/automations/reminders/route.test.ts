import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE REMINDERS CRON ANSWERS HONESTLY AND FILES BEFORE IT ANSWERS (cn-v1130, skeptic #34). A run that
 * throws (the company list could not be read, or any step above the per-company catch) answers 500
 * with its words, and files the failure through the waited-for door: this function answers on the tick
 * it files, and a fire-and-forget write can freeze with it. A BLOCKER (cn-v1136): the whole run fell
 * over, every company's reminders with it, so the first such run pages North's own team.
 *
 * HOURLY, EACH COMPANY AT ITS OWN 8 AM, NOON AND 4 PM (2026-11-02, the day after DST ended). The run
 * works out once which companies are at one of their reminder hours and hands sendDueReminders only
 * those; a run with none reads nothing more and sends nothing; a company whose zone cannot be read is
 * counted failed and filed, and the rest still run.
 */
const spies = vi.hoisted(() => ({ send: vi.fn(), readAllOrgs: vi.fn(), reportError: vi.fn(), reportErrorAwaited: vi.fn(async () => {}), reportBlockerAwaited: vi.fn(async () => {}) }));

vi.mock("@/lib/cron-guard", () => ({ requireCron: vi.fn(() => ({ supabase: {} })) }));
vi.mock("@/lib/reminders-engine", () => ({ sendDueReminders: spies.send }));
vi.mock("@/lib/observe", () => ({ reportError: spies.reportError, reportErrorAwaited: spies.reportErrorAwaited }));
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn(), reportBlockerAwaited: spies.reportBlockerAwaited }));
const gate = vi.hoisted(() => ({ throwFor: null as string | null }));
vi.mock("@/lib/cron-orgs", async (orig) => {
  const real = await orig<typeof import("@/lib/cron-orgs")>();
  return {
    ...real,
    readAllOrgs: spies.readAllOrgs,
    atLocalHour: vi.fn((...a: Parameters<typeof real.atLocalHour>) => {
      if (gate.throwFor && a[0] === gate.throwFor) throw new RangeError(`Invalid time zone specified: ${a[0]}`);
      return real.atLocalHour(...a);
    }),
  };
});

import { GET } from "./route";

const req = () => new Request("https://x/api/automations/reminders");

/** Stand-in companies. 2026-11-02 is the Monday after DST ended. */
const LARKSPUR = { id: "larkspur", settings: { timezone: "America/Los_Angeles" } }; // 8/12/4 PST = 16/20/00 UTC
const CATBIRD = { id: "catbird", settings: { timezone: "America/New_York" } }; // 8/12/4 EST = 13/17/21 UTC
const at = (iso: string) => Date.parse(iso);
const handed = () => [...(spies.send.mock.calls[0][1].orgIds as Set<string>)].sort();

beforeEach(() => {
  gate.throwFor = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-11-02T16:00:00Z")); // Larkspur's 8 AM
  spies.readAllOrgs.mockReset();
  spies.readAllOrgs.mockResolvedValue([LARKSPUR]);
  spies.send.mockReset();
  spies.reportError.mockClear();
  spies.reportErrorAwaited.mockClear();
  spies.reportBlockerAwaited.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("GET /api/automations/reminders", () => {
  it("a clean run answers 200 with the counts and files nothing", async () => {
    spies.send.mockResolvedValue({ invoice_due: 1, quote_followup: 0, appointment: 0, skipped_no_email: 0, failed: 0 });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      companies: { due: 1, not_due_yet: 0, failed: 0 },
      reminders: { invoice_due: 1, quote_followup: 0, appointment: 0, skipped_no_email: 0, failed: 0 },
    });
    expect(spies.reportError).not.toHaveBeenCalled();
    expect(spies.reportErrorAwaited).not.toHaveBeenCalled();
    expect(spies.reportBlockerAwaited).not.toHaveBeenCalled();
  });

  it("a run that throws is a 500 with its words, filed through the waited-for BLOCKER door", async () => {
    const err = new Error("organizations could not be read: boom");
    spies.send.mockRejectedValue(err);
    const res0 = await GET(req());
    expect(res0.status).toBe(500);
    spies.reportBlockerAwaited.mockClear();
    // The company read failing is the same 500, before any company is judged.
    spies.readAllOrgs.mockRejectedValue(err);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "organizations could not be read: boom" });
    expect(spies.reportBlockerAwaited).toHaveBeenCalledTimes(1);
    expect(spies.reportBlockerAwaited).toHaveBeenCalledWith("cron-reminders-frequent", err);
    expect(spies.reportError).not.toHaveBeenCalled();
    expect(spies.reportErrorAwaited).not.toHaveBeenCalled();
  });

  it("each company is handed over only at ITS 8 AM, noon and 4 PM, never another hour", async () => {
    spies.send.mockResolvedValue({ invoice_due: 0, quote_followup: 0, appointment: 0, skipped_no_email: 0, failed: 0 });
    spies.readAllOrgs.mockResolvedValue([LARKSPUR, CATBIRD]);
    const dueAt: Record<string, string[]> = {};
    for (let h = 0; h < 24; h++) {
      spies.send.mockClear();
      const utc = `2026-11-02T${String(h).padStart(2, "0")}:00:00Z`;
      vi.setSystemTime(at(utc));
      const body = await (await GET(req())).json();
      expect(body.ok).toBe(true);
      if (spies.send.mock.calls.length) {
        dueAt[utc.slice(11, 13)] = handed();
        expect(body.companies.due).toBe(handed().length);
      } else {
        expect(body).toEqual({ ok: true, companies: { due: 0, not_due_yet: 2, failed: 0 } });
      }
    }
    // Catbird: 8 AM, noon, 4 PM EST = 13, 17, 21 UTC. Larkspur: 8 AM, noon PST = 16, 20 UTC; its 4 PM
    // is 00 UTC, the next UTC day's first hour (here the Monday's own 00:00 UTC is Sunday's 4 PM PST).
    expect(dueAt).toEqual({ "00": ["larkspur"], "13": ["catbird"], "16": ["larkspur"], "17": ["catbird"], "20": ["larkspur"], "21": ["catbird"] });
    // The old fixed hours 15/19/23 UTC are nobody's reminder hour any more (7, 11 and 3 PST).
    for (const old of ["15", "19", "23"]) expect(dueAt[old]).toBeUndefined();
  });

  it("a company whose timezone Intl cannot read is counted failed and filed; the others still get their reminders", async () => {
    spies.send.mockResolvedValue({ invoice_due: 0, quote_followup: 0, appointment: 0, skipped_no_email: 0, failed: 0 });
    gate.throwFor = "America/New_York";
    spies.readAllOrgs.mockResolvedValue([CATBIRD, LARKSPUR]);
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.companies).toEqual({ due: 1, not_due_yet: 0, failed: 1 });
    expect(spies.reportError).toHaveBeenCalledWith("cron-reminders-hour", expect.any(RangeError), { orgId: "catbird" });
    expect(handed()).toEqual(["larkspur"]);
  });
});
