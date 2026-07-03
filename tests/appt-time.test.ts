import { describe, it, expect } from "vitest";
import { shiftApptToDay } from "@/lib/appt-time";

/**
 * A calendar move changes the DAY and must keep the appointment's local
 * wall-clock time + its duration. The bug this guards is the naive "add N ms"
 * reschedule: across a DST boundary that lands the start an hour off. These
 * cases run in the machine's local timezone (as the browser move does); the
 * wall-clock invariant holds regardless of which zone that is.
 */
describe("shiftApptToDay — keep wall-clock time + duration on the new day", () => {
  // Reconstruct the local wall-clock the returned instant lands on.
  const wall = (iso: string) => {
    const d = new Date(iso);
    return { h: d.getHours(), m: d.getMinutes(), ymd: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` };
  };

  it("moves to the target day at the same local time, preserving duration", () => {
    const start = new Date(2026, 6, 6, 9, 30, 0); // Jul 6 2026, 09:30 local
    const end = new Date(2026, 6, 6, 11, 0, 0); // 90 min later
    const r = shiftApptToDay(start.toISOString(), end.toISOString(), "2026-07-13");
    expect(wall(r.start)).toEqual({ h: 9, m: 30, ymd: "2026-07-13" });
    expect(wall(r.end!)).toEqual({ h: 11, m: 0, ymd: "2026-07-13" });
    // Duration unchanged: 90 minutes.
    expect(new Date(r.end!).getTime() - new Date(r.start).getTime()).toBe(90 * 60 * 1000);
  });

  it("a null end stays null", () => {
    const start = new Date(2026, 6, 6, 14, 15, 0);
    const r = shiftApptToDay(start.toISOString(), null, "2026-07-20");
    expect(wall(r.start)).toEqual({ h: 14, m: 15, ymd: "2026-07-20" });
    expect(r.end).toBeNull();
  });

  it("preserves wall-clock time across the US spring-forward boundary", () => {
    // US DST 2026 begins Sun Mar 8. Booked Fri Mar 6 at 08:00, move it onto
    // the 8th: naive "+2 days in ms" would read 09:00 (the lost hour); the
    // wall-clock re-stamp keeps it at 08:00.
    const start = new Date(2026, 2, 6, 8, 0, 0); // Mar 6 2026, 08:00 local
    const end = new Date(2026, 2, 6, 10, 0, 0); // 2 h
    const r = shiftApptToDay(start.toISOString(), end.toISOString(), "2026-03-08");
    expect(wall(r.start)).toEqual({ h: 8, m: 0, ymd: "2026-03-08" });
    expect(wall(r.end!)).toEqual({ h: 10, m: 0, ymd: "2026-03-08" });
  });

  it("rejects a non-ymd target", () => {
    expect(() => shiftApptToDay(new Date().toISOString(), null, "07/13/2026")).toThrow();
  });
});
