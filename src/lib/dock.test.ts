import { describe, it, expect } from "vitest";
import { DOCK } from "@/lib/dock";
import { JOB_STATUSES, jobStatusLabel } from "@/lib/job-status";

/** Drift guard: the dock's Jobs sub-nav is GENERATED from the JOB_STATUSES spine. This pins
 *  coverage, order, hrefs AND labels — the original disease was a hand-written 6-entry list
 *  (missing invoiced/cancelled) with a "Completed" label drifting from canonical "complete",
 *  while the /jobs page rendered all 7. One data origin now; this test keeps it that way. */
describe("DOCK jobs section ← JOB_STATUSES", () => {
  const jobs = DOCK.find((s) => s.key === "jobs");
  const children = jobs?.children ?? [];
  const statusChildren = children.filter((c) => c.href?.startsWith("/jobs?status="));

  it("exists, with 'All jobs' first", () => {
    expect(jobs).toBeDefined();
    expect(children[0]).toMatchObject({ label: "All jobs", href: "/jobs" });
  });

  it("hrefs cover every job status, in lifecycle order (cancelled last)", () => {
    expect(statusChildren.map((c) => c.href)).toEqual(JOB_STATUSES.map((s) => `/jobs?status=${s}`));
  });

  it("labels derive from jobStatusLabel (no hand-written label drift)", () => {
    expect(statusChildren.map((c) => c.label.toLowerCase())).toEqual(
      JOB_STATUSES.map((s) => jobStatusLabel(s)),
    );
  });

  it("statuses sit directly after 'All jobs'; the staff cross-job links follow under a header", () => {
    expect(children.slice(1, 1 + JOB_STATUSES.length).map((c) => c.id)).toEqual(
      JOB_STATUSES.map((s) => `j-${s}`),
    );
    // Statuses are for everyone (techs filter their own job list) — never staff-gated.
    expect(statusChildren.every((c) => !c.staffOnly)).toBe(true);
    // The "Across all jobs" cluster: a staffOnly header node, then only staffOnly links,
    // so a tech never sees a dangling header or an office-only cross-job page.
    const rest = children.slice(1 + JOB_STATUSES.length);
    expect(rest[0]?.header).toBe(true);
    expect(rest.every((c) => c.staffOnly)).toBe(true);
  });
});
