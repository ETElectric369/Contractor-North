import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fakeDb } from "@/lib/bank-transfer-fake.test-util";
import { codeOnly } from "@/lib/migration-body.test-util";

/**
 * WHAT HAPPENS AFTER MONEY LANDS ON AN INVOICE (M1) — the four steps, without a database.
 *
 * THE DEFECT THIS WOULD HAVE CAUGHT: a deposit matched out of the bank download recomputed the
 * invoice and stopped. The job it paid off stayed "in progress" on the tile, the map and My Day;
 * nobody was told; no screen refreshed. Two of the four steps, at one of three doors.
 *
 * So: the recalc lands, a paid-off job is finished, the bell rings ONCE in the door's own words, and
 * the money screens are refreshed — and when the recalc does NOT land, nothing is finished off a
 * stale balance and the refusal says so in words.
 */
const calls = vi.hoisted(() => ({
  revalidated: [] as string[],
  pushedToGoogle: [] as string[],
  reported: [] as string[],
  rang: [] as { org: string | null | undefined; people: string[]; kind: string; line: { title: string; body?: string | null; url?: string | null } }[],
  staff: ["erik", "office-2", "office-3"] as string[],
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => calls.revalidated.push(p) }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: async (_k: string, id: string) => void calls.pushedToGoogle.push(id) }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string) => void calls.reported.push(where) }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: async () => {} }));
vi.mock("@/lib/push", () => ({ orgStaffIds: async () => calls.staff }));
vi.mock("@/lib/notifications", () => ({
  notifyPeople: async (org: string | null | undefined, people: (string | null | undefined)[], kind: string, line: any) => {
    calls.rang.push({ org, people: people.filter((p): p is string => !!p), kind, line });
    return { bell: true, pushed: people.filter((p): p is string => !!p) };
  },
}));

import { afterPaymentLanded } from "./after-payment-landed";

const ORG = "org-et";
const INV = "inv-80";
const JOB = "job-5659";

/** A $1,000 bill on a started job, with `paid` dollars of payments already on it. */
const books = (paid: number, over: Record<string, unknown> = {}) => ({
  invoices: [{ id: INV, org_id: ORG, job_id: JOB, invoice_kind: "standard", status: "sent", invoice_number: "INV-080", tax_rate: 0, total: 1000, amount_paid: 0, customers: { name: "Rita Moss" }, ...over }],
  invoice_items: [{ invoice_id: INV, line_total: 1000 }],
  payments: paid ? [{ invoice_id: INV, amount: paid }] : [],
  customer_credits: [] as any[],
  jobs: [{ id: JOB, status: "in_progress" }],
});

describe("afterPaymentLanded — the four steps every pay door takes", () => {
  beforeEach(() => {
    calls.revalidated.length = 0;
    calls.pushedToGoogle.length = 0;
    calls.reported.length = 0;
    calls.rang.length = 0;
    calls.staff = ["erik", "office-2", "office-3"];
  });

  it("a deposit off the bank file pays the last bill: the figures land, the JOB IS FINISHED, the office hears it once, every money screen refreshes", async () => {
    const db = fakeDb(books(1000));
    const r = await afterPaymentLanded(db, {
      invoiceId: INV,
      orgId: ORG,
      bell: { amount: 1000, said: "from the bank file", recordedBy: "erik" },
    });

    // 1. the recalc landed and said paid
    expect(r.settled).toBe(true);
    expect(db.tables.invoices[0]).toMatchObject({ amount_paid: 1000, status: "paid" });
    // 2. the job is done, and it left Google (this is the step the bank download never took)
    expect(r.job).toEqual({ completed: true, jobId: JOB });
    expect(db.tables.jobs[0].status).toBe("complete");
    expect(calls.pushedToGoogle).toEqual([JOB]);
    // 3. one bell line, in this door's words, with the person who tapped Apply left out of it
    expect(calls.rang).toEqual([
      {
        org: ORG,
        people: ["office-2", "office-3"],
        kind: "invoice_paid",
        line: { title: "Payment recorded", body: "$1,000.00 from the bank file on INV-080 — Rita Moss", url: `/billing/${INV}` },
      },
    ]);
    expect(r.rang).toEqual(["office-2", "office-3"]);
    // 4. every screen that shows money (the helper's own refresh, plus the finish's four)
    expect(calls.revalidated).toContain("/billing");
    expect(calls.revalidated).toContain(`/billing/${INV}`);
    expect(calls.revalidated).toContain("/planner");
    expect(calls.revalidated).toContain("/analytics");
    expect(calls.reported).toEqual([]);
  });

  it("a part payment: the figures land, the job stays open in its own words, and the office still hears what came in", async () => {
    const db = fakeDb(books(400));
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 400, said: "paid online" } });
    expect(r.settled).toBe(true);
    expect(db.tables.invoices[0]).toMatchObject({ amount_paid: 400, status: "partial" });
    expect(r.job.completed).toBe(false);
    expect(db.tables.jobs[0].status).toBe("in_progress");
    // Money that arrived on its own is news, and it is news to the whole office (no recorder).
    expect(calls.rang[0].people).toEqual(["erik", "office-2", "office-3"]);
    expect(calls.rang[0].line).toMatchObject({ title: "Payment received", body: "$400.00 paid online on INV-080 — Rita Moss" });
  });

  it("a REPEAT (the row was already there) settles again and rings NOTHING: one payment, one bell", async () => {
    const db = fakeDb(books(1000));
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG });
    expect(r.settled).toBe(true);
    expect(db.tables.invoices[0].status).toBe("paid");
    expect(r.job).toEqual({ completed: true, jobId: JOB });
    expect(calls.rang).toEqual([]);
    expect(r.rang).toEqual([]);
  });

  it("the recalc could not read: NOTHING is finished off a stale balance, and the refusal says why", async () => {
    const db = fakeDb(books(1000), { failing: ["payments"] });
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000, recordedBy: "erik" } });
    expect(r.settled).toBe(false);
    expect(r.job).toEqual({ completed: false, why: "the invoice's figures didn't recompute, so nothing was finished" });
    expect(db.tables.jobs[0].status).toBe("in_progress");
    expect(db.log.some((l) => l.table === "jobs" && l.verb === "update")).toBe(false);
    expect(calls.reported).toContain("recalcInvoice:read");
    // The money IS recorded, so the bell line still stands as the record of it.
    expect(calls.rang).toHaveLength(1);
  });

  it("paid twice: the bell says OVERPAID and names the amount over, because only a person can choose credit or refund", async () => {
    const db = fakeDb(books(2000));
    await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000, said: "paid online" } });
    expect(calls.rang[0].line.title).toBe("Overpaid — action needed");
    expect(calls.rang[0].line.body).toBe("$1,000.00 paid online on INV-080 — Rita Moss. That's $1,000.00 MORE than the total. Credit it or refund it.");
  });

  it("a payment with no company on it: nobody is rung and the ops log says so, and the figures still land", async () => {
    const db = fakeDb(books(1000));
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: null, bell: { amount: 1000 } });
    expect(r.settled).toBe(true);
    expect(calls.rang).toEqual([]);
    expect(calls.reported).toContain("afterPaymentLanded:bell");
  });

  it("a paid DRAW is a stage of the job, not its end — the gate's rule, reached through this door", async () => {
    const db = fakeDb(books(1000, { invoice_kind: "deposit" }));
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000 } });
    expect(r.settled).toBe(true);
    expect(r.job).toEqual({ completed: false, why: "a paid deposit draw is a stage of the job, not its end" });
    expect(db.tables.jobs[0].status).toBe("in_progress");
  });

  it("a bell that blows up never unsaves the payment: the figures and the job still land, and the ops log hears it", async () => {
    const db = fakeDb(books(1000));
    calls.staff = null as unknown as string[]; // orgStaffIds answers with something unusable
    const r = await afterPaymentLanded(db, { invoiceId: INV, orgId: ORG, bell: { amount: 1000 } });
    expect(r.settled).toBe(true);
    expect(r.job).toEqual({ completed: true, jobId: JOB });
    expect(calls.reported).toContain("afterPaymentLanded:bell");
  });
});

/**
 * THE TEETH: A FOURTH PAYMENT WRITER CANNOT FORGET THE FOUR STEPS.
 *
 * A shared helper is only a convention while a new door can be written without it. This walks the
 * source for every place that puts a row in `payments` and insists each one calls the helper — so a
 * fourth writer is RED until its author reads this and decides on purpose. (A deliberate bypass
 * tripwire, which is the only thing a source-text check is ever allowed to be: the behaviour itself
 * is pinned above.)
 */
describe("every door that records a payment goes through the one helper", () => {
  /**
   * Source with comments removed, so prose can neither satisfy nor trip an assertion about code —
   * through THE one stripper every bypass tripwire reads (lib/migration-body.test-util: codeOnly).
   *
   * THIS ONE'S BLINDNESS WAS LOAD-BEARING: the writer list below is BUILT by scanning, so a file whose
   * `from("payments").insert(` sat inside a hidden span would not have been found at all — not a
   * failing case, a missing one, and the "finds the writers" guard would have passed with a short list
   * that looked deliberate. The copy that used to live here treated every `/*` as a comment opener,
   * including the one inside `accept="image/` + a star + `"` on a camera input, which opened a comment
   * that ran on to the next real comment close: twenty app files came back short by 784 lines of code,
   * one span of src/middleware.ts covering 118 of them. The three writers below are the same three
   * either way today — nothing was hidden — but a fourth door could have been.
   */
  const code = (path: string) => codeOnly(readFileSync(join(process.cwd(), path), "utf8"));

  const writers = (readdirSync(join(process.cwd(), "src"), { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join("src", f))
    .filter((f) => /from\("payments"\)\s*\.(insert|upsert)\(/.test(code(f)));

  it("finds the writers (so an empty scan can never pass)", () => {
    expect(writers.sort()).toEqual([
      "src/app/(app)/billing/actions.ts", // Record Payment (and Settle Up, which records through it)
      "src/app/(app)/bills/bank-core.ts", // a deposit off the bank file, put on an invoice
      "src/lib/record-invoice-payment.ts", // the card / bank / Tap to Pay writer, webhook and sheet
    ]);
  });

  for (const f of writers) {
    it(`${f} calls afterPaymentLanded`, () => {
      expect(
        code(f),
        `${f} writes a payment row. Everything that follows a payment lives in lib/after-payment-landed (recalc, finish the job, the bell, the refresh) — call afterPaymentLanded instead of writing any of it again here.`,
      ).toMatch(/afterPaymentLanded\(/);
    });
  }

  it("and nothing writes those four steps for itself any more", () => {
    for (const f of writers) {
      const src = code(f);
      expect(src, f).not.toMatch(/completeJobWhenPaid\(/);
      expect(src, f).not.toMatch(/sendPushToProfiles\(/);
    }
  });
});
