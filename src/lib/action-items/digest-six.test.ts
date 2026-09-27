import { describe, expect, it } from "vitest";
import { sixForPerson, sixOwner, type DigestTask } from "./digest-six";

/**
 * THE MORNING PUSH KEEPS A REMINDER PRIVATE (0358, Erik: Reminders are private). The digest reads the
 * whole company on the service client, so this is the only thing standing between Erik's "Buy Christy's
 * gift" and every office phone. Each person's push is ranked from THEIR Reminders only; a job's task is
 * nobody's six.
 */
const TODAY = "2026-09-26";
let n = 0;
const t = (over: Partial<DigestTask>): DigestTask => ({
  id: `t${++n}`,
  title: `task ${n}`,
  status: "open",
  priority: 0,
  due_date: TODAY,
  focus_date: null,
  category: null,
  job_id: null,
  parent_id: null,
  created_by: null,
  assigned_to: null,
  ...over,
});

describe("sixOwner: whose six a row belongs in (My Day's cut)", () => {
  it("the person it is for; else its maker", () => {
    expect(sixOwner(t({ created_by: "erik", assigned_to: "brian" }))).toBe("brian");
    expect(sixOwner(t({ created_by: "erik", assigned_to: null }))).toBe("erik");
  });
  it("a job's task is nobody's six; a Reminder with no maker and no person is nobody's", () => {
    expect(sixOwner(t({ job_id: "j1", created_by: "erik" }))).toBeNull();
    expect(sixOwner(t({ created_by: null, assigned_to: null }))).toBeNull();
  });
});

describe("sixForPerson: each person gets only their own", () => {
  const eriksGift = t({ title: "Buy Christy's gift", created_by: "erik" });
  const forBrian = t({ title: "Grab the ladder", created_by: "erik", assigned_to: "brian" });
  const alexasOwn = t({ title: "Call the bank", created_by: "alexa" });
  const jobTask = t({ title: "Hang the panel", created_by: "erik", job_id: "j1", focus_date: TODAY, priority: 2 });
  const orphan = t({ title: "Legacy", created_by: null, assigned_to: null });
  const pool = [eriksGift, forBrian, alexasOwn, jobTask, orphan];
  const titles = (who: string) => sixForPerson(pool, who, TODAY).map((x) => x.title);

  it("Erik's push: his own Reminder, not the one he made for Brian, not the job's task", () => {
    expect(titles("erik")).toEqual(["Buy Christy's gift"]);
  });

  it("Brian's push: the one made for him, and never Erik's private one", () => {
    expect(titles("brian")).toEqual(["Grab the ladder"]);
  });

  it("Alexa (office) never sees Erik's Reminder, and nobody is pushed the orphan or the job task", () => {
    expect(titles("alexa")).toEqual(["Call the bank"]);
    for (const who of ["erik", "brian", "alexa", "someone"]) {
      expect(titles(who)).not.toContain("Hang the panel");
      expect(titles(who)).not.toContain("Legacy");
    }
  });

  it("someone with no Reminders gets an empty six (their push, if any, is decisions only)", () => {
    expect(titles("someone")).toEqual([]);
  });

  it("still ranked the My Day way: undated plain ones never ride", () => {
    const undated = t({ title: "Someday", created_by: "erik", due_date: null });
    expect(sixForPerson([undated, eriksGift], "erik", TODAY).map((x) => x.title)).toEqual(["Buy Christy's gift"]);
  });
});
