import { describe, it, expect } from "vitest";
import { advance, reminderSuppressed } from "./automations-math";

describe("advance — recurring next-date math", () => {
  it("advances each frequency by one period (mid-month, no rollover)", () => {
    expect(advance("2026-06-20", "weekly")).toBe("2026-06-27");
    expect(advance("2026-06-20", "biweekly")).toBe("2026-07-04");
    expect(advance("2026-06-20", "monthly")).toBe("2026-07-20");
    expect(advance("2026-06-20", "quarterly")).toBe("2026-09-20");
    expect(advance("2026-06-20", "yearly")).toBe("2027-06-20");
  });
  it("treats an unknown frequency as monthly", () => {
    expect(advance("2026-06-20", "whoknows")).toBe("2026-07-20");
  });
  it("crosses the year boundary", () => {
    expect(advance("2026-12-15", "monthly")).toBe("2027-01-15");
    expect(advance("2026-11-20", "quarterly")).toBe("2027-02-20");
  });
  // Documents the JS Date month rollover: monthly on the 31st overflows into the
  // following month (Feb has no 31st). Locked here so a future change is intentional.
  it("rolls a month-end date forward the way JS Date does (known edge)", () => {
    expect(advance("2026-01-31", "monthly")).toBe("2026-03-03");
    expect(advance("2024-02-29", "yearly")).toBe("2025-03-01");
  });
});

describe("reminderSuppressed — the no-spam decision", () => {
  const now = Date.UTC(2026, 5, 20, 18, 0, 0);
  const DAY = 86_400_000;

  it("allows the first reminder (nothing sent yet)", () => {
    expect(reminderSuppressed([], 7, 3, now)).toBe(false);
  });
  it("suppresses once the per-entity cap is reached", () => {
    // 3 sends, cap 3 -> done forever, regardless of age
    expect(reminderSuppressed([now - 30 * DAY, now - 20 * DAY, now - 10 * DAY], 7, 3, now)).toBe(true);
  });
  it("suppresses while the most recent send is inside the window", () => {
    expect(reminderSuppressed([now - 3 * DAY], 7, 3, now)).toBe(true); // 3 days ago, 7-day window
  });
  it("allows again once the window has passed (and under the cap)", () => {
    expect(reminderSuppressed([now - 10 * DAY], 7, 3, now)).toBe(false); // 10 days ago > 7
  });
  it("appointment cap of 1 means once-ever", () => {
    expect(reminderSuppressed([now - 3650 * DAY], 3650, 1, now)).toBe(true);
  });
  it("uses the MOST RECENT send for the window, not the oldest", () => {
    expect(reminderSuppressed([now - 30 * DAY, now - 2 * DAY], 7, 5, now)).toBe(true);
  });
  it("ignores non-finite timestamps", () => {
    expect(reminderSuppressed([NaN, Infinity], 7, 3, now)).toBe(false);
  });
});
