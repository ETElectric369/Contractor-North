import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, failingReads, type Tables, type Write } from "@/lib/prepayment-db.test-util";

/**
 * A JOB CALLED OFF SAYS WHAT ITS PAYMENT REQUESTS STILL HOLD (cn-v1178, C4/E4; the owner's decision 6).
 *
 * Cancelling a job wrote the status and closed its tasks, and read no bill: a sent deposit request stayed
 * payable on its link and nobody was told, and a paid one's money sat on a cancelled job with no word.
 * The cancel still stands and the app voids and refunds nothing; the answer names each request still
 * owed (its link still takes a card: void it on the job's Invoices tab if it is not owed) and the money
 * paid ahead that no bill used (refund it, or bill the work that was done).
 *
 * The job's requests, their lines, refunds and the credit lines on other bills are rows in an in-memory
 * database that answers every read by its filters (lib/prepayment-db.test-util), read through the real
 * lib/payment-request readPrepaymentStates and the real lib/prepayments requestsAtAnEnding: nothing that
 * holds the rule is mocked.
 */
const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn() }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { setJobStatus } from "./actions";

const JOB = "job-larkspur";
let tables: Tables;
let writes: Write[];

/** A payment request on the Larkspur job: its row and its one line (what it asks). */
function request(id: string, number: string, title: string, asks: number, paid: number, status: string) {
  tables.invoices.push({ id, org_id: "org-1", job_id: JOB, invoice_number: number, invoice_kind: "prepayment", title, status, amount_paid: paid, created_at: `2026-11-0${tables.invoices.length + 1}T00:00:00.000Z` });
  tables.invoice_items.push({ id: `${id}-line`, org_id: "org-1", invoice_id: id, quantity: 1, unit_price: asks, line_total: asks, import_source: "prepayment" });
}

beforeEach(() => {
  writes = [];
  tables = {
    jobs: [{ id: JOB, org_id: "org-1", status: "to_be_scheduled", hold_reason: null }],
    tasks: [],
    invoices: [],
    invoice_items: [],
    customer_credits: [],
    profiles: [{ id: "user-1", language: null }],
  };
  state.client = fakeDb(tables, { org: "org-1", writes, seq: { n: 0 } });
});

describe("cancelling a job with payment requests on it", () => {
  it("an unpaid deposit request: the cancel stands, nothing is voided, and the answer names it, what it asks and the one action", async () => {
    request("req-1", "INV-900", "Deposit", 1000, 0, "sent");
    const res = await setJobStatus(JOB, "cancelled");
    expect(res.ok).toBe(true);
    expect(tables.jobs[0].status).toBe("cancelled");
    expect(tables.invoices[0].status).toBe("sent");
    expect(writes.filter((w) => w.table === "invoices")).toEqual([]);
    expect(res.warning).toBe(
      "INV-900 (Deposit) still asks for $1,000.00 and its link still takes a card: void it on the job's Invoices tab if it is not owed.",
    );
  });

  it("a paid request no bill used: the money paid ahead is named, with its one action", async () => {
    request("req-1", "INV-900", "Deposit", 1000, 1000, "paid");
    const res = await setJobStatus(JOB, "cancelled");
    expect(res.ok).toBe(true);
    expect(res.warning).toBe("$1,000.00 paid ahead on INV-900 (Deposit) is on no bill: refund it, or bill the work that was done.");
  });

  it("skeptic S6: a partly paid request is said ONCE, with the one action its void door allows (refund what was paid, then void it); a void one and one a sent bill already took off say nothing", async () => {
    request("req-1", "INV-900", "Materials", 600, 200, "partial");
    request("req-2", "INV-901", "Deposit", 500, 0, "void");
    request("req-3", "INV-902", "Deposit", 400, 400, "paid");
    // INV-903, a sent bill, already took INV-902 off in full.
    tables.invoices.push({ id: "bill-1", org_id: "org-1", job_id: JOB, invoice_number: "INV-903", invoice_kind: "standard", status: "sent", amount_paid: 0 });
    tables.invoice_items.push({ id: "bill-1-credit", org_id: "org-1", invoice_id: "bill-1", quantity: 1, unit_price: -400, line_total: -400, import_source: "prepaid_credit", prepaid_invoice_id: "req-3" });
    const res = await setJobStatus(JOB, "cancelled");
    expect(res.warning).toBe(
      "INV-900 (Materials) still asks for $400.00 and its link still takes a card, and $200.00 was paid on it: if it is not owed, refund what was paid, then void it on the job's Invoices tab.",
    );
  });

  it("no requests: the answer is what it was (tasks only), and On Hold reads no bill", async () => {
    expect(await setJobStatus(JOB, "cancelled")).toEqual({ ok: true });
    request("req-1", "INV-900", "Deposit", 1000, 0, "sent");
    tables.jobs[0].status = "scheduled";
    expect(await setJobStatus(JOB, "on_hold", "waiting on the permit")).toEqual({ ok: true });
  });

  it("a failed read of the requests is said, never read as none; the cancel stands", async () => {
    request("req-1", "INV-900", "Deposit", 1000, 0, "sent");
    state.client = failingReads(state.client, "invoices");
    const res = await setJobStatus(JOB, "cancelled");
    expect(res.ok).toBe(true);
    expect(tables.jobs[0].status).toBe("cancelled");
    expect(res.warning).toBe("Couldn't read this job's payment requests just now: look at its Invoices tab for any still open.");
  });

  it("in Spanish, for a person who reads Spanish", async () => {
    tables.profiles[0].language = "es";
    request("req-1", "INV-900", "Deposit", 1000, 0, "sent");
    const res = await setJobStatus(JOB, "cancelled");
    expect(res.warning).toContain("INV-900 (Deposit) todavía pide $1,000.00");
    expect(res.warning).toContain("anúlala en la pestaña Facturas del trabajo");
  });
});
