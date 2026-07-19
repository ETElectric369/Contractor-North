import { describe, expect, it } from "vitest";
import { taskHref } from "./task-href";

describe("taskHref — one rule for where a task row links", () => {
  it("a job task always opens the job's Tasks tab (category irrelevant)", () => {
    expect(taskHref({ job_id: "j1", category: "Permits" })).toBe("/jobs/j1?tab=tasks");
    expect(taskHref({ job_id: "j1", category: null })).toBe("/jobs/j1?tab=tasks");
  });

  it("job-less legacy categories keep their dedicated pages", () => {
    expect(taskHref({ job_id: null, category: "office" })).toBe("/tasks/office");
    expect(taskHref({ job_id: null, category: "operations" })).toBe("/tasks/operations");
    expect(taskHref({ job_id: null, category: "sales" })).toBe("/tasks/sales");
  });

  it("free-form or NULL categories (0136) land on the workbench, never a 404ing /tasks/<slug>", () => {
    expect(taskHref({ job_id: null, category: "Permits" })).toBe("/tasks?by=category");
    expect(taskHref({ job_id: null, category: null })).toBe("/tasks?by=category");
    expect(taskHref({ job_id: null })).toBe("/tasks?by=category");
  });
});
