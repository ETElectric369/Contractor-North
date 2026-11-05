import { describe, expect, it } from "vitest";
import { datedWhen } from "./dated-when";

/** THE DATED AGE (2026-11-04): "Accepted Jun 12", never "140d ago"; the year only when not this year. */
describe("datedWhen", () => {
  const tz = "America/Los_Angeles";
  it("says the word and the month-day, in the company's timezone", () => {
    expect(datedWhen("Accepted", "2026-06-24T17:00:00Z", "2026-11-04", tz)).toBe("Accepted Jun 24");
    // 2 AM UTC on Jun 13 is the evening of Jun 12 in Pacific time.
    expect(datedWhen("Sent", "2026-06-13T02:00:00Z", "2026-11-04", tz)).toBe("Sent Jun 12");
    expect(datedWhen("Started", "2026-07-03", "2026-11-04", tz)).toBe("Started Jul 3");
  });
  it("adds the year only when it isn't this year, and says nothing without a day", () => {
    expect(datedWhen("Sent", "2025-12-03T17:00:00Z", "2026-11-04", tz)).toBe("Sent Dec 3, 2025");
    expect(datedWhen("Sent", null, "2026-11-04", tz)).toBeNull();
    expect(datedWhen("Sent", "not a day", "2026-11-04", tz)).toBeNull();
  });
});
