import { describe, it, expect } from "vitest";
import { lienStatus } from "@/lib/lien-math";

describe("lienStatus (CA prelim 20-day / lien 90-day deadlines)", () => {
  it("computes the prelim deadline 20 days after first furnishing", () => {
    const s = lienStatus({ firstFurnishedDate: "2026-06-01", today: "2026-06-10" });
    expect(s.prelimDeadline).toBe("2026-06-21");
    expect(s.prelimDaysLeft).toBe(11);
    expect(s.prelimUrgent).toBe(false);
  });
  it("flags prelim urgent within a week, and past-due as negative", () => {
    expect(lienStatus({ firstFurnishedDate: "2026-06-01", today: "2026-06-16" }).prelimUrgent).toBe(true); // 5 days left
    expect(lienStatus({ firstFurnishedDate: "2026-06-01", today: "2026-06-25" }).prelimDaysLeft).toBe(-4); // past due
  });
  it("computes the lien deadline 90 days after completion", () => {
    const s = lienStatus({ completionDate: "2026-06-01", today: "2026-06-10" });
    expect(s.lienDeadline).toBe("2026-08-30");
    expect(s.lienDaysLeft).toBe(81);
  });
  it("served/recorded clears the urgency", () => {
    const s = lienStatus({ firstFurnishedDate: "2026-06-01", prelimSentAt: "2026-06-05", today: "2026-06-19" });
    expect(s.prelimDone).toBe(true);
    expect(s.prelimUrgent).toBe(false); // not urgent once served, even though within the window
  });
  it("a recorded Notice of Completion shortens the lien window (60 direct / 30 sub)", () => {
    expect(lienStatus({ completionDate: "2026-06-01", nocRecorded: true, today: "2026-06-10" }).lienDeadline).toBe("2026-07-31"); // +60
    expect(lienStatus({ completionDate: "2026-06-01", nocRecorded: true, isSubcontractor: true, today: "2026-06-10" }).lienDeadline).toBe("2026-07-01"); // +30
  });
  it("returns nulls when dates are missing", () => {
    const s = lienStatus({ today: "2026-06-10" });
    expect(s.prelimDeadline).toBeNull();
    expect(s.prelimDaysLeft).toBeNull();
    expect(s.prelimUrgent).toBe(false);
  });
});
