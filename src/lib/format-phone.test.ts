import { describe, it, expect } from "vitest";
import { formatPhone } from "./utils";

// Nort saved Tom Goodman's "+1 (916) 992-4711" as "1 (916) 992-4711" (2026-09-24): the one
// formatter printed the US country code back out, so one number read two ways across the book.
describe("formatPhone — the one phone formatter", () => {
  it("drops a leading US country code however it arrives", () => {
    expect(formatPhone("+1 (916) 992-4711")).toBe("(916) 992-4711");
    expect(formatPhone("1 (916) 992-4711")).toBe("(916) 992-4711");
    expect(formatPhone("1-916-992-4711")).toBe("(916) 992-4711");
    expect(formatPhone("+19169924711")).toBe("(916) 992-4711");
    expect(formatPhone("19169924711")).toBe("(916) 992-4711");
  });

  it("formats a plain ten-digit number the same way", () => {
    expect(formatPhone("9169924711")).toBe("(916) 992-4711");
    expect(formatPhone("916.992.4711")).toBe("(916) 992-4711");
  });

  it("is idempotent on its own output (a re-save never drifts)", () => {
    expect(formatPhone(formatPhone("+1 (916) 992-4711"))).toBe("(916) 992-4711");
  });

  it("still formats progressively while typing", () => {
    expect(formatPhone("")).toBe("");
    expect(formatPhone("91")).toBe("(91");
    expect(formatPhone("91699")).toBe("(916) 99");
    expect(formatPhone(null)).toBe("");
  });
});
