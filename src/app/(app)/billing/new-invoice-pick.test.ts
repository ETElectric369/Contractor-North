import { describe, it, expect } from "vitest";
import { jobRowLabel, pickRows, restoredPick, routePick, showsTaxRate, RECENT_JOBS, type PickJob } from "./new-invoice-pick";

/**
 * NEW INVOICE ON /BILLING ASKS ONE QUESTION (W1-28): "Which Job Or Customer?". What the list shows
 * for what is typed, and what a pick runs, pinned here.
 */

const JOBS: PickJob[] = [
  { id: "j-011", job_number: "J-011", name: "Timbercreek", customer_id: "c-tao", customer_name: "Tao Zhu" },
  { id: "j-046", job_number: "J-046", name: "J-046 Panel swap", customer_id: "c-jw", customer_name: "Jason Waldow" },
  { id: "j-052", job_number: "J-052", name: "Herringbone", customer_id: "c-ac", customer_name: "Andrew Cohen" },
];
const CUSTOMERS = [
  { id: "c-tao", name: "Tao Zhu" },
  { id: "c-karen", name: "Karen Wucher" },
];

describe("a job row reads 'J-011 · Timbercreek · Tao Zhu'", () => {
  it("the J-number once, the job, its customer", () => {
    expect(jobRowLabel(JOBS[0])).toBe("J-011 · Timbercreek · Tao Zhu");
    // A name that already starts with its number doesn't get it twice.
    expect(jobRowLabel(JOBS[1])).toBe("J-046 · Panel swap · Jason Waldow");
    expect(jobRowLabel({ id: "x", job_number: "J-099", name: "Shed", customer_id: null })).toBe("J-099 · Shed");
    expect(jobRowLabel({ id: "x", job_number: null, name: null, customer_id: null })).toBe("Untitled job");
  });
});

describe("the rows under the box", () => {
  it("before typing: the newest jobs that aren't cancelled (the page reads them that way), no customers", () => {
    const many: PickJob[] = Array.from({ length: 20 }, (_, i) => ({ id: `j-${i}`, job_number: `J-${100 + i}`, name: "Job", customer_id: null }));
    const rows = pickRows("", many, CUSTOMERS);
    expect(rows).toHaveLength(RECENT_JOBS);
    expect(rows.every((r) => r.kind === "job")).toBe(true);
    expect(rows[0]).toMatchObject({ id: "j-0" });
  });

  it("typing finds jobs by J-number, name or customer, and customers by name - jobs first", () => {
    expect(pickRows("j-052", JOBS, CUSTOMERS).map((r) => ("id" in r ? r.id : r.kind))).toEqual(["j-052"]);
    expect(pickRows("timber", JOBS, CUSTOMERS).map((r) => ("id" in r ? r.id : r.kind))).toEqual(["j-011"]);
    // "tao" is a job's customer and a customer: the job leads, the customer follows, tagged as one.
    expect(pickRows("tao", JOBS, CUSTOMERS)).toEqual([
      { kind: "job", id: "j-011", label: "J-011 · Timbercreek · Tao Zhu" },
      { kind: "customer", id: "c-tao", label: "Tao Zhu" },
    ]);
    expect(pickRows("KAREN", JOBS, CUSTOMERS)).toEqual([{ kind: "customer", id: "c-karen", label: "Karen Wucher" }]);
  });

  it("nothing matches: the last row makes the customer from what was typed", () => {
    expect(pickRows("  Nora Gove ", JOBS, CUSTOMERS)).toEqual([{ kind: "new-customer", name: "Nora Gove" }]);
  });

  it("the new-customer row opens on the WHOLE typed name, not the letters that first matched nothing", async () => {
    // Matching is by substring, so once "No" matches nothing, "Nora Gove" can't either: the row
    // appears partway through the name and stays. NewCustomerInline takes its name when it mounts,
    // so the row is keyed by the name - each keystroke mounts a fresh one on the full text.
    expect(pickRows("No", JOBS, CUSTOMERS)).toEqual([{ kind: "new-customer", name: "No" }]);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/billing/new-invoice-button.tsx"), "utf8");
    expect(src).toMatch(/<li key=\{`new-customer:\$\{r\.name\}`\}[^>]*>[\s\S]{0,700}?<NewCustomerInline initialName=\{r\.name\}/);
    expect(src).not.toContain('key="new-customer"');
  });
});

describe("what a pick runs", () => {
  it("a job goes through the job's own door, with the rate on the form while Sales Tax is on", () => {
    expect(routePick({ kind: "job", id: "j-011", label: "" }, { salesTax: true, taxRate: 0.0825 })).toEqual({ action: "job", jobId: "j-011", taxRate: 0.0825 });
    // Sales Tax off: no rate at all, never a hidden one.
    expect(routePick({ kind: "job", id: "j-011", label: "" }, { salesTax: false, taxRate: 0.0825 })).toEqual({ action: "job", jobId: "j-011" });
    expect(routePick({ kind: "job", id: "j-011", label: "" }, { salesTax: true, taxRate: 0 })).toEqual({ action: "job", jobId: "j-011" });
  });

  it("a customer gets a blank invoice at the rate on the form (untaxed with Sales Tax off)", () => {
    expect(routePick({ kind: "customer", id: "c-tao", label: "" }, { salesTax: true, taxRate: 0.0725 })).toEqual({ action: "customer", customerId: "c-tao", taxRate: 0.0725 });
    expect(routePick({ kind: "customer", id: "c-tao", label: "" }, { salesTax: false, taxRate: 0.0725 })).toEqual({ action: "customer", customerId: "c-tao", taxRate: 0 });
    // Nonsense is no rate.
    expect(routePick({ kind: "customer", id: "c-tao", label: "" }, { salesTax: true, taxRate: 8.25 })).toEqual({ action: "customer", customerId: "c-tao", taxRate: 0 });
  });

  it("the Tax Rate % field shows for a job pick AND a customer pick while Sales Tax is on", () => {
    expect(showsTaxRate({ kind: "job", id: "j-011", label: "" }, true)).toBe(true);
    expect(showsTaxRate({ kind: "customer", id: "c-tao", label: "" }, true)).toBe(true);
    expect(showsTaxRate({ kind: "job", id: "j-011", label: "" }, false)).toBe(false);
    expect(showsTaxRate(null, true)).toBe(false);
  });
});

describe("the draft kept across a reload", () => {
  it("restores the pick, and ignores the old form's shape (mode / quoteId / title)", () => {
    expect(restoredPick({ pick: { kind: "job", id: "j-011", label: "J-011 · Timbercreek · Tao Zhu" } })).toEqual({ kind: "job", id: "j-011", label: "J-011 · Timbercreek · Tao Zhu" });
    expect(restoredPick({ mode: "quote", quoteId: "q-1", customerId: "c-tao", jobId: "", title: "x" })).toBeNull();
    expect(restoredPick({ pick: { kind: "estimate", id: "q-1" } })).toBeNull();
    expect(restoredPick(null)).toBeNull();
  });
});
