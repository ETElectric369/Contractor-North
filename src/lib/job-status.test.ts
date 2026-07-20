import { describe, it, expect } from "vitest";
import { pickJobScheduledToday, pickMemberCurrentJob } from "@/lib/job-status";

// The "which job is this person on today" spine — shared by the /timeclock crew
// board and the job-less clock-in resolution. Day bounds here are an arbitrary
// UTC day; the callers pass real org-local bounds from todayBoundsInTz.
const dayStart = new Date("2026-07-15T07:00:00Z");
const dayEnd = new Date("2026-07-16T07:00:00Z");

type J = {
  id: string;
  status?: string | null;
  scheduled_start?: string | null;
  created_at?: string | null;
};

const scheduledToday: J = {
  id: "sched",
  status: "scheduled",
  scheduled_start: "2026-07-15T15:00:00Z", // inside the day bounds
  created_at: "2026-07-01T00:00:00Z",
};
const inProgress: J = {
  id: "prog",
  status: "in_progress",
  scheduled_start: null,
  created_at: "2026-07-05T00:00:00Z",
};
const newestOther: J = {
  id: "other",
  status: "to_be_scheduled",
  scheduled_start: null,
  created_at: "2026-07-10T00:00:00Z",
};

describe("pickJobScheduledToday (shared tier 1)", () => {
  it("picks a job whose scheduled_start falls inside the day bounds", () => {
    expect(pickJobScheduledToday([inProgress, scheduledToday], new Set(), dayStart, dayEnd)?.id).toBe("sched");
  });
  it("picks a job covered by a schedule segment even without scheduled_start", () => {
    expect(pickJobScheduledToday([inProgress], new Set(["prog"]), dayStart, dayEnd)?.id).toBe("prog");
  });
  it("earliest scheduled_start wins between two today-jobs", () => {
    const early: J = { ...scheduledToday, id: "early", scheduled_start: "2026-07-15T14:00:00Z" };
    expect(pickJobScheduledToday([scheduledToday, early], new Set(), dayStart, dayEnd)?.id).toBe("early");
  });
  it("returns null when nothing is scheduled today", () => {
    expect(pickJobScheduledToday([inProgress, newestOther], new Set(), dayStart, dayEnd)).toBeNull();
  });
});

describe("pickMemberCurrentJob tiers 1-3 (pre-0139 behavior, unchanged)", () => {
  it("tier 1: scheduled today beats in_progress", () => {
    expect(pickMemberCurrentJob([inProgress, scheduledToday], new Set(), dayStart, dayEnd)?.id).toBe("sched");
  });
  it("tier 2: in_progress beats other active jobs", () => {
    expect(pickMemberCurrentJob([newestOther, inProgress], new Set(), dayStart, dayEnd)?.id).toBe("prog");
  });
  it("tier 3: falls back to the newest other active job", () => {
    const older: J = { ...newestOther, id: "older", created_at: "2026-06-01T00:00:00Z" };
    expect(pickMemberCurrentJob([older, newestOther], new Set(), dayStart, dayEnd)?.id).toBe("other");
  });
  it("empty set → null", () => {
    expect(pickMemberCurrentJob([], new Set(), dayStart, dayEnd)).toBeNull();
  });
});

// THE PRECEDENCE LAW (Erik, 2026-07-20): an explicit crew day-assignment for the
// org-local today WINS over schedule/in_progress/newest — the board, the clock-in
// default, and (through it) My Day all follow the day-assignment.
describe("pickMemberCurrentJob tier 0 (crew day-assignment precedence)", () => {
  it("the day-assignment beats a job scheduled today", () => {
    expect(
      pickMemberCurrentJob([scheduledToday, inProgress, newestOther], new Set(), dayStart, dayEnd, "prog")?.id,
    ).toBe("prog");
  });
  it("the day-assignment beats an in_progress job", () => {
    expect(pickMemberCurrentJob([inProgress, newestOther], new Set(), dayStart, dayEnd, "other")?.id).toBe("other");
  });
  it("the day-assignment beats a segment-scheduled job", () => {
    expect(pickMemberCurrentJob([scheduledToday, newestOther], new Set(["sched"]), dayStart, dayEnd, "other")?.id).toBe(
      "other",
    );
  });
  it("an assignment pointing OUTSIDE the active set falls through (never resurrects a finished job)", () => {
    expect(pickMemberCurrentJob([scheduledToday, inProgress], new Set(), dayStart, dayEnd, "gone-job")?.id).toBe(
      "sched",
    );
  });
  it("null/undefined assignment = the pre-0139 pick exactly", () => {
    for (const a of [null, undefined]) {
      expect(pickMemberCurrentJob([inProgress, scheduledToday], new Set(), dayStart, dayEnd, a)?.id).toBe("sched");
    }
  });
});
