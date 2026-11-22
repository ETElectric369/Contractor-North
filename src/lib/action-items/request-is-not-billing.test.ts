import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";
import { tieAlreadyInvoiced } from "./already-invoiced";
import { jobBillingStatus } from "@/lib/analytics/money-metrics";

/**
 * A PAYMENT REQUEST IS NOT A BILL FOR WORK (cn-v1177, the sweep). A request (invoice_kind "prepayment")
 * is money asked for ahead of the work, and a deposit request carries its estimate's quote_id. No reader
 * that decides "is this job / estimate billed, invoiced, settled" may take one for a bill of work. Each
 * read below leaves it out by the one predicate (isPrepaymentKind, or the query's own
 * .neq("invoice_kind", "prepayment")); these pins fail if the exclusion is dropped.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("Needs You's Already Invoiced never ties a payment request", () => {
  it("the tie refuses a request in one sentence, and writes nothing", async () => {
    const db = fakeDb({
      jobs: [{ id: "j", org_id: "o", job_number: "J-900", name: "Larkspur", customer_id: "c", customers: { name: "Dana Rook" } }],
      invoices: [{ id: "r", org_id: "o", invoice_number: "INV-900", status: "paid", invoice_kind: "prepayment", job_id: null, quote_id: null, appointment_id: null }],
    });
    const res = await tieAlreadyInvoiced(db as never, "o", { kind: "job", id: "j" } as never, "r");
    expect(res).toEqual({
      ok: false,
      error: "INV-900 is a payment request: money asked for ahead of the work, so it doesn't settle this. Pick the invoice that billed the finished work. Nothing was changed.",
    });
    expect(db.tables.invoices[0].job_id).toBeNull();
    expect(db.log.some((l) => l.verb === "update")).toBe(false);
  });
  it("and never offers one", () => {
    expect(read("src/lib/action-items/already-invoiced.ts")).toContain(
      ".filter((r) => !isPrepaymentKind(r.invoice_kind) && (!isDrawKind(r.invoice_kind) || r.invoice_kind === \"final\"))",
    );
  });
});

describe("the reads that decide billed / invoiced leave a request out", () => {
  it("Needs You's billed jobs (inspections, estimate drafts, needs-a-day) read no request", () => {
    expect(read("src/lib/action-items/query.ts")).toContain(
      'supabase.from("invoices").select("id, job_id, invoice_kind, status, created_at").not("job_id", "is", null).not("status", "in", "(draft,void)").neq("invoice_kind", "prepayment").limit(5000)',
    );
  });
  it("the Billing board: a finished job with only a request stays in Done - Not Invoiced", () => {
    expect(read("src/lib/billing-pipeline.ts")).toContain(
      'const invoicedJobIds = new Set(invoices.filter((i) => i.status !== "void" && i.job_id && !isPrepaymentKind(i.invoice_kind)).map((i) => i.job_id as string));',
    );
  });
  it("the estimate page: a deposit request naming the estimate is not its invoice", () => {
    expect(read("src/app/(app)/quotes/[id]/page.tsx")).toContain('supabase.from("invoices").select("id").eq("quote_id", id).neq("invoice_kind", "prepayment").limit(1).maybeSingle(),');
  });
  it("the jobs list: a finished job whose only bill is a paid request is still To Be Invoiced, never Paid in Full", () => {
    expect(jobBillingStatus([{ status: "paid", total: 1000, amount_paid: 1000, invoice_kind: "prepayment" }])).toBe("to_be_invoiced");
    expect(jobBillingStatus([{ status: "sent", total: 1000, amount_paid: 0, invoice_kind: "prepayment" }])).toBe("to_be_invoiced");
    // With the bill that took it off, the job's money reads as it always did.
    expect(
      jobBillingStatus([
        { status: "paid", total: 1000, amount_paid: 1000, invoice_kind: "prepayment" },
        { status: "sent", total: 1200, amount_paid: 0, invoice_kind: "standard" },
      ]),
    ).toBe("partial");
    expect(read("src/app/(app)/jobs/page.tsx")).toContain('.select("job_id, status, total, amount_paid, invoice_kind")');
  });
  it("the next invoice on a fixed-price job still bills the estimate when only its deposit request names it", () => {
    expect(read("src/app/(app)/jobs/actions.ts")).toContain(
      'supabase.from("invoices").select("id").eq("quote_id", quote.id).neq("status", "void").neq("invoice_kind", "prepayment").limit(1);',
    );
  });
  it("Inspections: a job carrying only a request is not billed work", () => {
    expect(read("src/lib/inspections-read.ts")).toContain('.neq("invoice_kind", "prepayment")');
  });
  it("a revision is not blocked by its original's deposit request", () => {
    expect(read("src/lib/billing/revision-billed.ts")).toContain('.in("quote_id", ids).neq("status", "void").neq("invoice_kind", "prepayment");');
  });
});
