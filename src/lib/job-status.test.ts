import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  JOB_STATUSES,
  JOB_STATUS_DOOR,
  SETTABLE_JOB_STATUSES,
  finishesTheJob,
  pickJobScheduledToday,
  pickMemberCurrentJob,
} from "@/lib/job-status";

/**
 * WHICH DOOR A STATUS IS WRITTEN THROUGH (M2). Finishing a job BILLS THE UNBILLED WORK FIRST, so the
 * word "complete" may only be written by finishing — one typed table, read by the status writer, by
 * the job page's pill and by Nort's tool, instead of an `if` at each door. The type is the teeth: a
 * new job status will not compile until somebody says which door it goes through.
 */
describe("the door each job status is written through", () => {
  it("every status on the spine is classified, and nothing else is", () => {
    expect(Object.keys(JOB_STATUS_DOOR).sort()).toEqual([...JOB_STATUSES].sort());
  });

  it("finishing is 'complete', and only 'complete' — a cancelled job is called off, never billed", () => {
    expect(JOB_STATUSES.filter(finishesTheJob)).toEqual(["complete"]);
    expect(finishesTheJob("cancelled")).toBe(false);
    // Nothing off the spine ends a job either: a stray word is not a finish.
    for (const s of ["", "invoiced", "estimate", "done", null, undefined]) expect(finishesTheJob(s), String(s)).toBe(false);
  });

  it("the plain status write may set everything that is not a finish", () => {
    expect(SETTABLE_JOB_STATUSES).toEqual(["to_be_scheduled", "scheduled", "in_progress", "on_hold", "cancelled"]);
    expect(SETTABLE_JOB_STATUSES.some(finishesTheJob)).toBe(false);
  });
});

/**
 * THE TEETH: ONLY FINISHING WRITES "complete" ON A JOB.
 *
 * A deliberate bypass tripwire (the behaviour itself is pinned in jobs/finish-job.test.ts): it walks
 * the source for anything that writes the word onto the jobs table and allows exactly the two places
 * that are allowed to — finishJob, which bills first, and the paid-in-full gate, which runs after a
 * payment has already settled. A third is RED until its author reads this.
 */
describe("nothing writes a job complete except finishing it", () => {
  const code = (path: string) =>
    readFileSync(join(process.cwd(), path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");

  it("the only two writers are Finish Job and the paid-in-full gate", () => {
    const files = (readdirSync(join(process.cwd(), "src"), { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => join("src", f));
    // A write of the word onto `jobs`: `.update({ status: "complete"` with whatever rides along.
    const found = files.filter((f) => /from\("jobs"\)[\s\S]{0,80}?\.update\(\{\s*status: "complete"/.test(code(f)));
    expect(found.sort()).toEqual([
      "src/app/(app)/jobs/actions.ts", // finishJob — bills the unbilled work, THEN writes the word
      "src/lib/complete-job-when-paid.ts", // paid in full on a started job, after the money settled
    ]);
  });
});

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

/**
 * "CAN'T UNASSIGN BRIAN FROM ANY JOB HE IS ON VACATION" (0170).
 *
 * The old "— No job —" deleted the day row, which handed the cell straight back to THIS function —
 * and its last line is a catch-all that returns the newest job the member is rostered on. Brian is
 * still on the roster (correctly — he hasn't left the crew), so it always found something and the
 * same job reappeared one refresh later. The control that looked like unassign was a no-op.
 */
describe("an explicit day OFF beats every guess", () => {
  it("returns nobody, even though the member is rostered on live jobs", () => {
    expect(pickMemberCurrentJob([inProgress, scheduledToday], new Set(), dayStart, dayEnd, null, true)).toBeNull();
  });

  it("beats a pinned day assignment too — OFF is the more specific decision", () => {
    expect(pickMemberCurrentJob([inProgress, scheduledToday], new Set(), dayStart, dayEnd, "prog", true)).toBeNull();
  });

  it("beats today's schedule", () => {
    expect(pickMemberCurrentJob([scheduledToday], new Set(["sched"]), dayStart, dayEnd, null, true)).toBeNull();
  });

  it("NOT off still behaves exactly as before — this must not change the normal day", () => {
    // The regression that would matter most: making every cell empty.
    expect(pickMemberCurrentJob([inProgress, scheduledToday], new Set(), dayStart, dayEnd, null, false)?.id).toBe("sched");
    expect(pickMemberCurrentJob([inProgress, scheduledToday], new Set(), dayStart, dayEnd)?.id).toBe("sched");
  });
});
