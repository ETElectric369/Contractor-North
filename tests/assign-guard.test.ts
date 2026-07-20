import { describe, it, expect } from "vitest";
import { blocksCrewWipe } from "@/lib/action-items/assign-guard";

/**
 * Pins the crew-wipe contract. The My Day "Assign to" sheet opened on an unpicked default with
 * its primary button enabled, and job.assign reads an empty assignee as "clear the whole crew" —
 * so one tap silently removed every name from a job and reported success. The guard refuses to
 * translate that from a human surface while leaving the agent's explicit-clear branch reachable.
 */
describe("blocksCrewWipe — an unpicked assignee never clears a job's crew", () => {
  it("blocks the UI default (no person picked)", () => {
    expect(blocksCrewWipe("job_to_schedule", "assign", "", "ui")).toBe(true);
    expect(blocksCrewWipe("job_to_schedule", "assign", undefined, "ui")).toBe(true);
    expect(blocksCrewWipe("job_to_schedule", "assign", null, "ui")).toBe(true);
    expect(blocksCrewWipe("job_to_schedule", "assign", "   ", "ui")).toBe(true);
  });

  it("blocks voice too — only the agent states the intent explicitly", () => {
    expect(blocksCrewWipe("job_to_schedule", "assign", "", "voice")).toBe(true);
  });

  it("leaves the agent's explicit clear-the-crew contract intact", () => {
    expect(blocksCrewWipe("job_to_schedule", "assign", "", "agent")).toBe(false);
    expect(blocksCrewWipe("job_to_schedule", "assign", null, "agent")).toBe(false);
  });

  it("never blocks a real assignment", () => {
    expect(blocksCrewWipe("job_to_schedule", "assign", "emp-1", "ui")).toBe(false);
  });

  it("does not touch task unassign — that's reversible and legitimate", () => {
    expect(blocksCrewWipe("task", "assign", "", "ui")).toBe(false);
    expect(blocksCrewWipe("work_order", "assign", "", "ui")).toBe(false);
  });

  it("does not touch other verbs on a job", () => {
    expect(blocksCrewWipe("job_to_schedule", "schedule", "", "ui")).toBe(false);
    expect(blocksCrewWipe("job_to_schedule", "open", "", "ui")).toBe(false);
  });
});
