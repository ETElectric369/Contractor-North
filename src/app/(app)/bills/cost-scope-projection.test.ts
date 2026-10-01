import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE FAILURE IS ALWAYS A SELECT LIST (the projection law), on the column item C1 added a door for.
 *
 * Both Edit Bill boxes OPEN on `bills.scope_category` and SAVE it back. A row that arrives without
 * the column does not arrive null — it is not there at all — so the picker would open empty on a cost
 * already filed under Framing, and pressing Save Changes would take Framing off it. The screens are
 * server components, so these are source assertions, the same shape as bills-page-reads.
 */
const BILLS_PAGE = readFileSync(join(process.cwd(), "src/app/(app)/bills/page.tsx"), "utf8");
const JOB_PAGE = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/page.tsx"), "utf8");

describe("the screens that set a cost's part of the job ask for it (item C1)", () => {
  it("/bills reads scope_category on EVERY rung of its missing-column ladder", () => {
    // 0105 is older than every column the ladder drops, so it belongs on the base rung: a database
    // that has any of those has this one. Written outside the three conditionals.
    expect(BILLS_PAGE).toContain("job_id, po_id, category, notes, scope_category");
  });

  it("the job hub reads scope_category with the bills its Costs tab draws", () => {
    expect(JOB_PAGE).toContain("bill_date, po_id, scope_category,");
  });

  it("both Edit Bill boxes open on the stored value and send it back", () => {
    const jobBills = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-bills.tsx"), "utf8");
    const billsList = readFileSync(join(process.cwd(), "src/app/(app)/bills/bills-receipts.tsx"), "utf8");
    for (const src of [jobBills, billsList]) {
      expect(src).toContain("bill.scope_category");
      expect(src).toContain("scope_category:");
      expect(src).toContain("JobScopePicker");
    }
  });
});
