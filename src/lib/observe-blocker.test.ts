import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A BLOCKER PAGES ONCE (cn-v1136). The row is written at level blocker and READ BACK: the first
 * sighting (inserted) and a fixed row seen again (reopened) page North's own team; a repeat is a
 * count bump and pages nobody; a write that failed pages nobody. A page that could not be sent is a
 * plain error under "platform-alert" — never a blocker, or it would page about itself. Neither door
 * ever throws, and the waited-for door resolves under its four-second clock when the write hangs.
 */
const spies = vi.hoisted(() => ({ record: vi.fn(), alert: vi.fn(), reportError: vi.fn() }));
vi.mock("@/lib/observe", () => ({
  recordAppError: spies.record,
  reportError: spies.reportError,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/platform-alert", () => ({ alertPlatformAdmins: spies.alert }));

import { reportBlocker, reportBlockerAwaited } from "./observe-blocker";

const row = (over: Partial<{ inserted: boolean; reopened: boolean; escalated: boolean; event_count: number }>) => ({
  id: "row-1",
  inserted: false,
  reopened: false,
  escalated: false,
  event_count: 4,
  level: "blocker",
  ...over,
});

/** Let the fire-and-forget chain run to its end. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  spies.record.mockReset();
  spies.alert.mockReset();
  spies.reportError.mockReset();
  spies.alert.mockResolvedValue({ sent: 1, skipped: 0 });
});
afterEach(() => vi.useRealTimers());

describe("reportBlocker", () => {
  it("writes at level blocker and, on the first sighting, pages once with the where and the words", async () => {
    spies.record.mockResolvedValue(row({ inserted: true, event_count: 1 }));
    reportBlocker("stripe:webhook:refused", new Error("signature matched no secret"), { secretsTried: 1 });
    await settle();
    expect(spies.record).toHaveBeenCalledWith("stripe:webhook:refused", expect.any(Error), { secretsTried: 1 }, "blocker");
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(spies.alert).toHaveBeenCalledWith({ where: "stripe:webhook:refused", message: "signature matched no secret", reopened: false, escalated: false });
  });

  it("a fixed row seen again pages once and says it is back", async () => {
    spies.record.mockResolvedValue(row({ reopened: true, event_count: 9 }));
    reportBlocker("email:send", new Error("Resend 401: invalid key"));
    await settle();
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(spies.alert).toHaveBeenCalledWith({ where: "email:send", message: "Resend 401: invalid key", reopened: true, escalated: false });
  });

  it("a known error that is a blocker for the FIRST time pages once (escalated, skeptic #42 S2) — a triaged row, not inserted, not reopened", async () => {
    spies.record.mockResolvedValue(row({ escalated: true, event_count: 12 }));
    reportBlocker("cron-gcal-sync", new Error("calendar_connections could not be read"));
    await settle();
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(spies.alert).toHaveBeenCalledWith({ where: "cron-gcal-sync", message: "calendar_connections could not be read", reopened: false, escalated: true });
    // The next blocker repeat on that row is a count bump.
    spies.alert.mockClear();
    spies.record.mockResolvedValue(row({ event_count: 13 }));
    reportBlocker("cron-gcal-sync", new Error("calendar_connections could not be read"));
    await settle();
    expect(spies.alert).not.toHaveBeenCalled();
  });

  it("a page that reached NOBODY (sent 0) is filed as a plain error under platform-alert with the skipped count (S7)", async () => {
    spies.record.mockResolvedValue(row({ inserted: true, event_count: 1 }));
    spies.alert.mockResolvedValue({ sent: 0, skipped: 2 });
    reportBlocker("stripe:webhook:refused", new Error("signature matched no secret"));
    await settle();
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(spies.reportError).toHaveBeenCalledTimes(1);
    expect(spies.reportError).toHaveBeenCalledWith("platform-alert", expect.objectContaining({ message: "no admin reachable" }), { where: "stripe:webhook:refused", skipped: 2 });
    expect(spies.record).toHaveBeenCalledTimes(1); // the blocker write itself; the row about the page is reportError's, never a blocker
    // One admin reached: nothing filed.
    spies.reportError.mockClear();
    spies.alert.mockResolvedValue({ sent: 1, skipped: 1 });
    reportBlocker("x", new Error("m"));
    await settle();
    expect(spies.reportError).not.toHaveBeenCalled();
  });

  it("a repeat (a count bump) pages nobody — a storm is one page", async () => {
    spies.record.mockResolvedValue(row({ event_count: 300 }));
    for (let i = 0; i < 5; i++) reportBlocker("stripe:webhook:refused", new Error("signature matched no secret"));
    await settle();
    expect(spies.record).toHaveBeenCalledTimes(5);
    expect(spies.alert).not.toHaveBeenCalled();
  });

  it("a write that failed (null) pages nobody", async () => {
    spies.record.mockResolvedValue(null);
    reportBlocker("cron-daily", new Error("every step failed"));
    await settle();
    expect(spies.alert).not.toHaveBeenCalled();
    expect(spies.reportError).not.toHaveBeenCalled();
  });

  it("a page that throws is swallowed and filed as a plain error under platform-alert, never a blocker", async () => {
    spies.record.mockResolvedValue(row({ inserted: true }));
    spies.alert.mockRejectedValue(new Error("platform_admins could not be read"));
    expect(() => reportBlocker("nort:model-dead", new Error("401"))).not.toThrow();
    await settle();
    expect(spies.reportError).toHaveBeenCalledTimes(1);
    expect(spies.reportError).toHaveBeenCalledWith("platform-alert", expect.objectContaining({ message: "platform_admins could not be read" }), { where: "nort:model-dead" });
    expect(spies.record).toHaveBeenCalledTimes(1); // the blocker write itself; the failed page is not a second blocker
  });

  it("never throws, even when the write itself throws", async () => {
    spies.record.mockImplementation(() => {
      throw new Error("bad");
    });
    expect(() => reportBlocker("x", new Error("m"))).not.toThrow();
    await settle();
    expect(spies.alert).not.toHaveBeenCalled();
  });
});

describe("reportBlockerAwaited", () => {
  it("waits for the write and the page", async () => {
    spies.record.mockResolvedValue(row({ inserted: true }));
    await reportBlockerAwaited("cron-reminders-frequent", new Error("organizations could not be read"));
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(spies.alert).toHaveBeenCalledWith({ where: "cron-reminders-frequent", message: "organizations could not be read", reopened: false, escalated: false });
  });

  it("an escalation pages through the waited-for door too, and a page that reached nobody is filed", async () => {
    spies.record.mockResolvedValue(row({ escalated: true }));
    await reportBlockerAwaited("stripe:config", new Error("no key"));
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(spies.alert).toHaveBeenCalledWith({ where: "stripe:config", message: "no key", reopened: false, escalated: true });
    spies.alert.mockResolvedValue({ sent: 0, skipped: 0 });
    await reportBlockerAwaited("stripe:config", new Error("no key"));
    expect(spies.reportError).toHaveBeenCalledWith("platform-alert", expect.objectContaining({ message: "no admin reachable" }), { where: "stripe:config", skipped: 0 });
  });

  it("a bump pages nobody, and a failed page is filed, not thrown", async () => {
    spies.record.mockResolvedValue(row({}));
    await reportBlockerAwaited("x", new Error("m"));
    expect(spies.alert).not.toHaveBeenCalled();
    spies.record.mockResolvedValue(row({ inserted: true }));
    spies.alert.mockRejectedValue(new Error("no push"));
    await expect(reportBlockerAwaited("x", new Error("m"))).resolves.toBeUndefined();
    expect(spies.reportError).toHaveBeenCalledWith("platform-alert", expect.any(Error), { where: "x" });
  });

  it("resolves under its four-second clock when the write hangs", async () => {
    vi.useFakeTimers();
    spies.record.mockReturnValue(new Promise(() => {}));
    let done = false;
    const p = reportBlockerAwaited("stripe:webhook:refused", new Error("no secret")).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(3999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    expect(spies.alert).not.toHaveBeenCalled();
  });
});
