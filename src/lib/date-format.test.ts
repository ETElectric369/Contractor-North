import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime } from "@/lib/utils";

// These outputs are deterministic regardless of the machine's timezone because the
// formatters now pass an explicit timeZone. That is the whole point: the server
// (UTC) and the browser must render the same thing. This test guards the recurring
// "timezone again" / off-by-one bug from coming back.
describe("formatDate / formatDateTime — timezone-stable", () => {
  it("renders a date-only value as the literal wall day (no off-by-one in any zone)", () => {
    expect(formatDate("2026-06-21")).toBe("Jun 21, 2026");
    expect(formatDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatDate("2026-12-31")).toBe("Dec 31, 2026");
  });

  it("renders a timestamp in the business timezone (Pacific), not the server's UTC", () => {
    // 2026-06-21T03:00:00Z is June 20, 8:00 PM Pacific (PDT) — the classic case where
    // a UTC server printed "Jun 21" and disagreed with the field tech's phone.
    expect(formatDate("2026-06-21T03:00:00Z")).toBe("Jun 20, 2026");
    expect(formatDateTime("2026-06-21T03:00:00Z")).toBe("Jun 20, 8:00 PM");
  });

  it("respects an explicit per-org timezone override", () => {
    // Same instant in New York (EDT) is June 20, 11:00 PM.
    expect(formatDateTime("2026-06-21T03:00:00Z", "America/New_York")).toBe("Jun 20, 11:00 PM");
  });

  it("handles null / invalid input gracefully", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDateTime("not a date")).toBe("—");
  });
});
