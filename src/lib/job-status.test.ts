import { describe, it, expect } from "vitest";
import { sep } from "node:path";
import { eachAppSource } from "@/lib/migration-body.test-util";
import {
  JOB_STATUSES,
  JOB_STATUS_DOOR,
  SETTABLE_JOB_STATUSES,
  finishedJobFields,
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

  /**
   * WHAT A FINISH WRITES, not just which word it is (the M1/M2 seam). Two doors end a job and they
   * wrote different patches: finishJob cleared the hold reason, the paid-in-full gate did not. A hold
   * reason is a sentence Needs You says out loud when the job comes back, so one left on a finished
   * job is a false alarm — and the clear must not rest on migration 0366's trigger having been run.
   */
  it("a finish is the word AND the hold cleared with it, in one object, fresh each time", () => {
    expect(finishedJobFields()).toEqual({ status: "complete", hold_reason: null });
    // The word it writes is the one the typed table calls a finish, so the two cannot drift.
    expect(finishesTheJob(finishedJobFields().status)).toBe(true);
    // A fresh object per call: a shared literal handed to a query builder is one mutation from a bug.
    const a = finishedJobFields();
    a.hold_reason = "waiting on the permit" as unknown as null;
    expect(finishedJobFields().hold_reason).toBeNull();
  });
});

/**
 * THE TEETH: ONLY FINISHING WRITES "complete" ON A JOB — AND FINISHING MEANS BILLING FIRST.
 *
 * A deliberate bypass tripwire (the behaviour itself is pinned in jobs/finish-job.test.ts,
 * lib/complete-job-when-paid.test.ts and lib/finish-bills-first.test.ts): it walks the source for
 * anything that ends a job on the jobs table and allows exactly the two places that are allowed to —
 * finishJob, and the paid-in-full gate. A third is RED until its author reads this.
 *
 * IT NOW ASSERTS THE BILLING STEP, NOT JUST THE PATCH (M3, the money seam). The previous version
 * checked that both doors write finishedJobFields(), which is why it stayed green through the exact
 * defect it exists to catch: cn-v1039 shipped lib/job-status saying in one line that a finishing
 * status "may only be written by finishing it (which bills first)", and shipped a second door —
 * lib/complete-job-when-paid, wired by M1 to EVERY payment door — that wrote the patch perfectly and
 * never asked what the job had worked. Erik bills part of a time-and-materials job, the customer taps
 * Pay, the job goes complete, and the hours and receipts no bill claims are drafted nowhere and named
 * nowhere. So the pin is now the whole sentence: the word, the patch, AND lib/finish-bills-first's
 * finishBillingStep, which is the one place that decides what a finish has to bill.
 *
 * AND IT READS THE FILES THROUGH THE FIXED STRIPPER (migration-body.test-util codeOnly). The copy this
 * file carried treated every opener-looking pair of characters as a comment start, including the one
 * inside a string like `accept="image/*,application/pdf"` — which opened a comment that ran to the next
 * real close and blanked everything between. Measured on this tree: 18 app files with 756 lines of code
 * hidden that way, src/app/(app)/jobs/[id]/job-portal-papers.tsx for 160 of them and src/middleware.ts
 * for 118. A door written inside one of those spans was invisible to this tripwire by name, which is the
 * one thing a bypass tripwire must never be — so the reach is asserted below, out loud, in files.
 */
describe("nothing writes a job complete except finishing it, and finishing bills first", () => {
  /** Every write onto the `jobs` table that ends the job, and whether it typed the word itself. */
  const endsAJob = (src: string): { byHand: boolean }[] => {
    const hits: { byHand: boolean }[] = [];
    for (let at = src.indexOf('from("jobs")'); at >= 0; at = src.indexOf('from("jobs")', at + 1)) {
      const window = src.slice(at, at + 220);
      const upd = window.indexOf(".update(");
      if (upd < 0) continue;
      const payload = window.slice(upd, upd + 140);
      if (/status:\s*"complete"/.test(payload)) hits.push({ byHand: true });
      else if (/finishedJobFields\(\)/.test(payload)) hits.push({ byHand: false });
    }
    return hits;
  };

  const scanned: string[] = [];
  const ending: { f: string; hits: { byHand: boolean }[]; billsFirst: boolean }[] = [];
  eachAppSource((path, code) => {
    // The repo-relative path, so the names below read the way a person types them.
    const f = path.slice(path.indexOf(`${sep}src${sep}`) + 1).split(sep).join("/");
    scanned.push(f);
    const hits = endsAJob(code);
    if (hits.length) ending.push({ f, hits, billsFirst: /finishBillingStep\(/.test(code) });
  });

  it("the scan really read the app — not an empty walk, and not one blinded by a broken stripper", () => {
    // 1122 app source files on the tree this was written against. A floor, not an equality: files come
    // and go. An empty or crippled walk silently passes every other assertion in this describe.
    expect(scanned.length).toBeGreaterThan(900);
    expect(scanned).toContain("src/lib/complete-job-when-paid.ts");
    expect(scanned).toContain("src/app/(app)/jobs/actions.ts");
    // The two files the old stripper hid the most of are read whole now: a door written in either of
    // them would be seen. `codeOnly` keeps a comment it is unsure about, so the only risk is a louder
    // tripwire, never a blind one.
    expect(scanned).toContain("src/middleware.ts");
    expect(scanned).toContain("src/app/(app)/jobs/[id]/job-portal-papers.tsx");
  });

  it("the only two writers are Finish Job and the paid-in-full gate", () => {
    expect(ending.map((x) => x.f).sort()).toEqual([
      "src/app/(app)/jobs/actions.ts", // finishJob — bills the unbilled work, THEN writes the finish
      "src/lib/complete-job-when-paid.ts", // paid in full on a started job, after the money settled
    ]);
  });

  it("both of them write the WHOLE finish, and neither types the word itself", () => {
    const byHand = ending.filter((x) => x.hits.some((h) => h.byHand)).map((x) => x.f);
    expect(
      byHand,
      "This door ends a job by typing the status into the patch, so whatever else a finish writes — " +
        "today the hold reason (0234) — is missing from it. Write lib/job-status's finishedJobFields() instead.",
    ).toEqual([]);
    // And the scan is really finding them: an empty scan must never pass this describe.
    expect(ending.flatMap((x) => x.hits).length).toBeGreaterThan(1);
  });

  it("and BOTH of them reach the billing step — a job never ends with its work off every bill", () => {
    const skipped = ending.filter((x) => !x.billsFirst).map((x) => x.f);
    expect(
      skipped,
      "This door ends a job without running the billing step. lib/job-status says a finishing status " +
        "may only be written by finishing, and finishing BILLS FIRST: hours and receipts no bill claims " +
        "have to be drafted (Finish Job) or said out loud and the finish refused (a paid bill). Call " +
        "lib/finish-bills-first's finishBillingStep and act on its answer — do not re-derive it here.",
    ).toEqual([]);
    expect(ending.length).toBe(2);
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
