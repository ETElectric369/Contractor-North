import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A FAILED READ IS NOT "NOTHING IS DUE" (cn-v1130, skeptic #34). The customer-reminder engine read
 * the companies, then each company's overdue invoices, follow-up quotes and coming visits, as bare
 * `.data`: a failed read sent nothing and said nothing. Pinned here against a routed PostgREST fake
 * with the email door mocked (nothing is ever sent):
 *
 *  - a failed companies read REJECTS (readAllOrgs): the route answers 500 and files it;
 *  - a failed invoices, quotes or appointments read for one company is filed under reminders-org with
 *    that company's id, counted in `failed`, and the loop goes on: the next company still gets its
 *    reminders.
 */
const spies = vi.hoisted(() => ({
  sendEmail: vi.fn(async (..._a: unknown[]) => ({ ok: true }) as { ok: boolean; error?: string }),
  reportError: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: spies.sendEmail,
  renderReminderEmail: () => "<p>reminder</p>",
  money: (n: number) => `$${n}`,
}));
// The real errorMessage stays (readAllOrgs words a failed read with it); only the filer is a spy.
vi.mock("@/lib/observe", async (orig) => ({ ...(await orig<typeof import("@/lib/observe")>()), reportError: spies.reportError }));
vi.mock("@/lib/bank-transfer", () => ({ pendingTransfers: vi.fn(async () => ({ problem: null, byInvoice: new Map() })) }));

import { sendDueReminders } from "./reminders-engine";

// ── a routed PostgREST fake: the route sees the table, the verb and every filter it was given ────
type Q = { table: string; verb: "select" | "insert"; filters: unknown[][] };
type Reply = { data?: unknown; error?: unknown } | undefined;

function fake(route: (q: Q) => Reply) {
  return {
    from(table: string) {
      const q: Q = { table, verb: "select", filters: [] };
      const chain: any = {
        select: () => chain,
        insert: () => {
          q.verb = "insert";
          return chain;
        },
        then: (resolve: (r: { data: unknown; error: unknown }) => void, reject?: (e: unknown) => void) => {
          try {
            const r = route(q);
            if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb}`);
            resolve({ data: r.data ?? null, error: r.error ?? null });
          } catch (e) {
            reject?.(e);
          }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "order", "limit", "range"]) {
        chain[m] = (...a: unknown[]) => {
          q.filters.push([m, ...a]);
          return chain;
        };
      }
      return chain;
    },
  };
}

/** The org a statement was scoped to by hand (`.eq("org_id", …)`). */
const orgOf = (q: Q) => q.filters.find((f) => f[0] === "eq" && f[1] === "org_id")?.[2];
/** readAllOrgs asks for pages of the companies: the rows at from=0, an empty page after. */
const orgPage = (q: Q, rows: unknown[]): Reply => ({ data: q.filters.some((f) => f[0] === "range" && Number(f[1]) > 0) ? [] : rows });

const ALL_ON = { timezone: "America/Los_Angeles", remind_invoice_due: true, remind_quote_followup: true, remind_appointments: true };
const ORG_A = { id: "org-a", name: "Larkspur Electric", phone: null, email: null, settings: ALL_ON };
const ORG_B = { id: "org-b", name: "Snowbell Electric", phone: null, email: null, settings: { timezone: "America/Los_Angeles", remind_invoice_due: true } };

const OVERDUE = {
  id: "inv-b1",
  invoice_number: "INV-201",
  total: 100,
  amount_paid: 0,
  public_token: "tok-b1",
  customers: { name: "Bayberry", email: "bayberry@example.com", address: null },
  jobs: null,
};

/** Everything answers cleanly; `fails` names the one table (for one company) whose read comes back as an error. */
function routes(fails: { table: string; orgId: string } | null = null) {
  const boom = { message: "boom" };
  return (q: Q): Reply => {
    if (q.table === "organizations") return orgPage(q, [ORG_A, ORG_B]);
    if (fails && q.table === fails.table && orgOf(q) === fails.orgId) return { error: boom };
    if (q.table === "invoices") return { data: orgOf(q) === "org-b" ? [OVERDUE] : [] };
    if (q.table === "quotes" || q.table === "appointments") return { data: [] };
    if (q.table === "reminder_log") return { data: null }; // the dedup read finds nothing; the insert lands
    return undefined;
  };
}

beforeEach(() => {
  spies.sendEmail.mockClear();
  spies.reportError.mockClear();
});

describe("sendDueReminders and a failed read", () => {
  it("the clean run reminds the second company's customer and fails nothing", async () => {
    const counts = await sendDueReminders(fake(routes()));
    expect(counts).toEqual({ invoice_due: 1, quote_followup: 0, appointment: 0, skipped_no_email: 0, failed: 0 });
    expect(spies.sendEmail).toHaveBeenCalledTimes(1);
    expect(spies.sendEmail.mock.calls[0][0]).toMatchObject({ to: "bayberry@example.com" });
    expect(spies.reportError).not.toHaveBeenCalled();
  });

  it("a failed companies read REJECTS, naming the table: never an empty run", async () => {
    const db = fake((q) => (q.table === "organizations" ? { error: { message: "boom" } } : routes()(q)));
    await expect(sendDueReminders(db)).rejects.toThrow("organizations could not be read: boom");
    expect(spies.sendEmail).not.toHaveBeenCalled();
  });

  it.each([["invoices"], ["quotes"], ["appointments"]])(
    "a failed %s read for one company is filed with its id and counted, and the next company is still reminded",
    async (table) => {
      const counts = await sendDueReminders(fake(routes({ table, orgId: "org-a" })));
      expect(counts.failed).toBe(1);
      expect(counts.invoice_due).toBe(1); // company B's overdue invoice still went out
      expect(spies.sendEmail).toHaveBeenCalledTimes(1);
      expect(spies.sendEmail.mock.calls[0][0]).toMatchObject({ to: "bayberry@example.com" });
      expect(spies.reportError).toHaveBeenCalledTimes(1);
      expect(spies.reportError).toHaveBeenCalledWith("reminders-org", { message: "boom" }, { orgId: "org-a" });
    },
  );

  it("a failed invoices read sends that company no reminder at all (it is not 'nothing is overdue')", async () => {
    // Company A is the one whose invoices read fails AND whose invoice is overdue: nothing may go to its customer.
    const db = fake((q) => {
      if (q.table === "organizations") return orgPage(q, [ORG_B]);
      if (q.table === "invoices") return { error: { message: "boom" } };
      return routes()(q);
    });
    const counts = await sendDueReminders(db);
    expect(counts).toMatchObject({ invoice_due: 0, failed: 1 });
    expect(spies.sendEmail).not.toHaveBeenCalled();
    expect(spies.reportError).toHaveBeenCalledWith("reminders-org", { message: "boom" }, { orgId: "org-b" });
  });
});
