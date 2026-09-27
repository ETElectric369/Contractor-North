import { describe, expect, it } from "vitest";
import { taskHref } from "./task-href";

describe("taskHref — one rule for where a task row links (0358)", () => {
  it("a job task always opens the job's Tasks tab (category irrelevant)", () => {
    expect(taskHref({ job_id: "j1", category: "Permits" })).toBe("/jobs/j1?tab=tasks");
    expect(taskHref({ job_id: "j1", category: null })).toBe("/jobs/j1?tab=tasks");
  });

  it("a task with no job is a Reminder: the one Reminders page, whatever its category", () => {
    for (const category of ["office", "operations", "sales", "Permits", null, undefined]) {
      expect(taskHref({ job_id: null, category })).toBe("/tasks");
    }
    expect(taskHref({})).toBe("/tasks");
  });

  it("never builds a /tasks/<category> link: those pages are gone", () => {
    for (const category of ["office", "operations", "sales", "Permits"]) {
      expect(taskHref({ job_id: null, category })).not.toMatch(/^\/tasks\//);
    }
  });
});
