import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE REMINDERS CRON ANSWERS HONESTLY AND FILES BEFORE IT ANSWERS (cn-v1130, skeptic #34). A run that
 * throws (the company list could not be read, or any step above the per-company catch) answers 500
 * with its words, and files the failure through the waited-for door: this function answers on the tick
 * it files, and a fire-and-forget write can freeze with it. A BLOCKER (cn-v1136): the whole run fell
 * over, every company's reminders with it, so the first such run pages North's own team.
 */
const spies = vi.hoisted(() => ({ send: vi.fn(), reportError: vi.fn(), reportErrorAwaited: vi.fn(async () => {}), reportBlockerAwaited: vi.fn(async () => {}) }));

vi.mock("@/lib/cron-guard", () => ({ requireCron: vi.fn(() => ({ supabase: {} })) }));
vi.mock("@/lib/reminders-engine", () => ({ sendDueReminders: spies.send }));
vi.mock("@/lib/observe", () => ({ reportError: spies.reportError, reportErrorAwaited: spies.reportErrorAwaited }));
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn(), reportBlockerAwaited: spies.reportBlockerAwaited }));

import { GET } from "./route";

const req = () => new Request("https://x/api/automations/reminders");

beforeEach(() => {
  spies.send.mockReset();
  spies.reportError.mockClear();
  spies.reportErrorAwaited.mockClear();
  spies.reportBlockerAwaited.mockClear();
});

describe("GET /api/automations/reminders", () => {
  it("a clean run answers 200 with the counts and files nothing", async () => {
    spies.send.mockResolvedValue({ invoice_due: 1, quote_followup: 0, appointment: 0, skipped_no_email: 0, failed: 0 });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reminders: { invoice_due: 1, quote_followup: 0, appointment: 0, skipped_no_email: 0, failed: 0 } });
    expect(spies.reportError).not.toHaveBeenCalled();
    expect(spies.reportErrorAwaited).not.toHaveBeenCalled();
    expect(spies.reportBlockerAwaited).not.toHaveBeenCalled();
  });

  it("a run that throws is a 500 with its words, filed through the waited-for BLOCKER door", async () => {
    const err = new Error("organizations could not be read: boom");
    spies.send.mockRejectedValue(err);
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "organizations could not be read: boom" });
    expect(spies.reportBlockerAwaited).toHaveBeenCalledTimes(1);
    expect(spies.reportBlockerAwaited).toHaveBeenCalledWith("cron-reminders-frequent", err);
    expect(spies.reportError).not.toHaveBeenCalled();
    expect(spies.reportErrorAwaited).not.toHaveBeenCalled();
  });
});
