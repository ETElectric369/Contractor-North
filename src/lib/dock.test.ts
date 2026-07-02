import { describe, it, expect } from "vitest";
import { DOCK, activeSection } from "@/lib/dock";
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

/** Drift guard #2: activeSection is THE one matcher behind the desktop rail, the phone
 *  bottom tiles and the SectionSubnav strip. The original disease was three drifting
 *  copies, none of which prefix-matched child routes — /quotes/abc lit "Today" on desktop
 *  (via a `?? sections[0]` fallback), zero tiles on mobile, and the strip vanished. One
 *  case per [id] route family pins every detail page to its owning section. */
describe("activeSection — child detail routes light the right section", () => {
  const key = (pathname: string) => activeSection(pathname)?.key;

  it("landing pages map to their own sections", () => {
    expect(key("/planner")).toBe("today");
    expect(key("/jobs")).toBe("jobs");
    expect(key("/billing")).toBe("invoices");
    expect(key("/compliance")).toBe("office");
  });

  it("estimate details belong to Sales (section href is /leads — the old matchers missed)", () => {
    expect(key("/quotes/abc123")).toBe("sales");
    expect(key("/quotes/new")).toBe("sales");
  });

  it("cross-job details belong to Jobs", () => {
    expect(key("/work-orders/abc123")).toBe("jobs");
    expect(key("/materials/abc123")).toBe("jobs");
    expect(key("/jobs/abc123")).toBe("jobs");
  });

  it("purchasing (PO details) belongs to Money via the Bills & POs owns-alias", () => {
    expect(key("/purchasing")).toBe("invoices");
    expect(key("/purchasing/abc123")).toBe("invoices");
  });

  it("invoice details belong to Money, form details to Office, task categories to Today", () => {
    expect(key("/billing/abc123")).toBe("invoices");
    expect(key("/forms/abc123")).toBe("office");
    expect(key("/tasks/site-prep")).toBe("today");
  });

  it("unmapped routes match NOTHING — light nothing, never lie", () => {
    expect(activeSection("/definitely-not-a-route")).toBeUndefined();
    // Prefix means path segments, not string prefixes: /billings is not /billing.
    expect(activeSection("/billings")).toBeUndefined();
  });

  it("respects a role-filtered section list (a tech on a staff route lights nothing)", () => {
    const techSections = DOCK.filter((s) => !s.staffOnly);
    expect(activeSection("/quotes/abc123", techSections)).toBeUndefined();
    expect(activeSection("/timeclock", techSections)?.key).toBe("clock");
  });
});
