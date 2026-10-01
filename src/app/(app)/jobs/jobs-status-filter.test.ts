import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCK } from "@/lib/dock";
import { JOB_STATUSES } from "@/lib/job-status";

/**
 * ALL IS THE JOBS LIST'S FIRST ROW AND ITS DEFAULT (Erik, report b94497dd, 2026-09-30: "Add a button
 * for the default setting at the top above To Be Scheduled 'All'").
 *
 * Two halves, pinned together because either alone is a half-truth:
 *   the NAV has a row that IS the unfiltered page (/jobs, no ?status=), above To Be Scheduled;
 *   the PAGE opens on that view, and a ?status= that is not a status on the job-status spine opens
 *   on it too instead of rendering an empty list under "Filtered: invoiced".
 */
const page = readFileSync(join(process.cwd(), "src/app/(app)/jobs/page.tsx"), "utf8");

describe("the Jobs list opens on All", () => {
  const jobs = DOCK.find((s) => s.key === "jobs")!;

  it("All is the first row of the Jobs nav, and it is this page with no filter", () => {
    expect(jobs.children[0]).toMatchObject({ label: "All", href: "/jobs" });
    // Above To Be Scheduled, which is where Erik asked for it.
    expect(jobs.children[1]?.href).toBe(`/jobs?status=${JOB_STATUSES[0]}`);
  });

  it("the page filters only on a real job status — anything else is All, never an empty list", () => {
    // The guard itself: the ?status= value is kept only when the spine has it.
    expect(page).toMatch(/JOB_STATUSES as readonly string\[\]\)\.includes\(String\(statusParam \?\? ""\)\)\s*\?\s*statusParam\s*:\s*undefined/);
    // And the filter the query applies is the guarded value, not the raw parameter.
    expect(page).toMatch(/if \(status\) query = query\.eq\("status", status\)/);
    expect(page).not.toMatch(/\.eq\("status", statusParam\)/);
  });

  it("the default view is still the whole book: active in the list, Completed shelved, cancelled counted", () => {
    expect(page).toMatch(/if \(!status\) \{/);
    expect(page).toContain("<CompletedJobsSection");
    expect(page).toContain("cancelled");
  });
});
