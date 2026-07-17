import { describe, it, expect } from "vitest";
import { endAfterStart } from "@/lib/appointments/times";

/** The guard rescheduleAppointment always had, ported to create/update after prod row
 *  d2788015 ("Disposal inspection — TTP #11") was saved via Edit Details ending an hour
 *  BEFORE it started. Pin it so the create/update paths can't lose it again. */
describe("endAfterStart", () => {
  it("no end time is fine (open-ended appointment)", () => {
    expect(endAfterStart("2026-07-15T18:00:00Z", null)).toBeNull();
    expect(endAfterStart("2026-07-15T18:00:00Z", "")).toBeNull();
  });

  it("end after start is fine", () => {
    expect(endAfterStart("2026-07-15T18:00:00Z", "2026-07-15T19:00:00Z")).toBeNull();
  });

  it("end BEFORE start is rejected (the d2788015 prod shape: 11am start, 10am end)", () => {
    expect(endAfterStart("2026-07-15T18:00:00Z", "2026-07-15T17:00:00Z")).toBe(
      "The end time has to be after the start.",
    );
  });

  it("end EQUAL to start is rejected (zero-length window)", () => {
    expect(endAfterStart("2026-07-15T18:00:00Z", "2026-07-15T18:00:00Z")).toBe(
      "The end time has to be after the start.",
    );
  });

  it("an unreadable end time is a clean error, not a silent save", () => {
    expect(endAfterStart("2026-07-15T18:00:00Z", "not-a-date")).toBe("I couldn't read the end time.");
  });

  it("an unreadable start doesn't crash the guard (start validity is checked upstream)", () => {
    expect(endAfterStart("not-a-date", "2026-07-15T19:00:00Z")).toBeNull();
  });
});
