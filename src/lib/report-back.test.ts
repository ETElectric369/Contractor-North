import { describe, it, expect } from "vitest";
import { reportBackDue, reportBackStanding, reportBackText, standingSentence, tenthHours } from "./report-back";

const TODAY = "2026-10-08";
const dayOf = (iso: string) => iso.slice(0, 10); // UTC days are fine for the rule's own test
const opts = { todayStr: TODAY, dayOf, windowDays: 3 };
const tm = { id: "j1", status: "in_progress", billing_type: "tm", planned_minutes: 480, report_back_at: null };
const day = (d: string, from: string, to: string, lunch = 0) => ({ job_id: "j1", status: "closed", clock_in: `${d}T${from}:00.000Z`, clock_out: `${d}T${to}:00.000Z`, lunch_minutes: lunch });

/**
 * THE T&M REPORT-BACK RULE (cn-v1069), pinned as a table: due only on an in-progress T&M job nobody
 * has told, once a clocked day has closed, and only while the job was worked in the last three days
 * (the badge law: a bounded window and a stamp that ends it).
 */
describe("reportBackDue", () => {
  it("a T&M job in progress with yesterday closed and nobody told: due, and the sentence names the standing", () => {
    const v = reportBackDue(tm, [day("2026-10-07", "08:00", "14:30", 30)], opts);
    expect(v).toMatchObject({ due: true, because: null });
    expect(v.standing).toMatchObject({ hoursIn: 6, guessHours: 8, lastWorked: "2026-10-07T14:30:00.000Z", sentence: "6h in · guess was 8h" });
  });

  it("not a fixed-price job, not a job that is not in progress, not one already told", () => {
    const e = [day("2026-10-07", "08:00", "14:00")];
    expect(reportBackDue({ ...tm, billing_type: "fixed" }, e, opts).because).toBe("not_tm");
    expect(reportBackDue({ ...tm, status: "scheduled" }, e, opts).because).toBe("not_in_progress");
    expect(reportBackDue({ ...tm, status: "complete" }, e, opts).because).toBe("not_in_progress");
    expect(reportBackDue({ ...tm, report_back_at: "2026-10-07T20:00:00.000Z" }, e, opts).because).toBe("told");
  });

  it("the first clocked day has to have CLOSED: a shift still open, or closed today, is too early", () => {
    expect(reportBackDue(tm, [], opts).because).toBe("no_closed_day");
    expect(reportBackDue(tm, [{ job_id: "j1", status: "open", clock_in: "2026-10-07T08:00:00.000Z", clock_out: null }], opts).because).toBe("no_closed_day");
    expect(reportBackDue(tm, [day("2026-10-08", "07:00", "11:00")], opts).because).toBe("no_closed_day");
    // Another job's day is not this job's.
    expect(reportBackDue(tm, [{ ...day("2026-10-07", "08:00", "14:00"), job_id: "j2" }], opts).because).toBe("no_closed_day");
  });

  it("bounded: a job last worked more than three days ago stops asking, and asks again on the next day worked", () => {
    expect(reportBackDue(tm, [day("2026-10-04", "08:00", "16:00")], opts).because).toBe("quiet");
    expect(reportBackDue(tm, [day("2026-10-05", "08:00", "16:00")], opts).due).toBe(true);
    expect(reportBackDue(tm, [day("2026-10-01", "08:00", "16:00"), day("2026-10-07", "08:00", "12:00")], opts).due).toBe(true);
  });

  it("no guess: the sentence says so instead of inventing one; hours read to a tenth", () => {
    const v = reportBackDue({ ...tm, planned_minutes: null }, [day("2026-10-06", "08:00", "17:15")], opts);
    expect(v.due).toBe(true);
    expect(v.standing.sentence).toBe("9.3h in, no guess");
    expect(reportBackDue({ ...tm, planned_minutes: 0 }, [day("2026-10-06", "08:00", "12:00")], opts).standing.sentence).toBe("4h in, no guess");
  });
});

describe("the standing and its words", () => {
  it("counts closed hours on this job only, lunch deducted, and the latest clock-out", () => {
    const s = reportBackStanding({ planned_minutes: 1920 }, [day("2026-10-01", "08:00", "16:00", 30), day("2026-10-02", "08:00", "12:00"), { ...day("2026-10-03", "08:00", "16:00"), job_id: "j2" }], "j1");
    expect(s).toEqual({ hoursIn: 11.5, guessHours: 32, lastWorked: "2026-10-02T12:00:00.000Z", sentence: "11.5h in · guess was 32h" });
  });
  it("tenths read plainly", () => {
    expect(tenthHours(6)).toBe("6");
    expect(tenthHours(6.04)).toBe("6");
    expect(tenthHours(6.25)).toBe("6.3");
    expect(standingSentence(0, 120)).toBe("0h in · guess was 2h");
  });
  it("the text names the person, the job and the figures, and promises no total it doesn't have", () => {
    expect(reportBackText("Dana", "the kitchen hood outlet", { hoursIn: 6, guessHours: 8 })).toBe(
      "Hi Dana, quick update on the kitchen hood outlet: we're about 6 hours in of the 8 we figured. I'll have a better read on the total as we go.",
    );
    expect(reportBackText(null, "J-012", { hoursIn: 103.2, guessHours: null })).toBe(
      "Hi, quick update on J-012: we're about 103.2 hours in. I'll have a better read on the total as we go.",
    );
  });
});
