import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDb, type Tables } from "@/lib/bank-transfer-fake.test-util";

/**
 * THE ONLINE-PAYMENT DOOR PRICES THE WORK IN THE JOB'S OWN COMPANY (M3 review, high).
 *
 * The billing step (lib/finish-bills-first) is shared by the two doors that end a job, and one of them
 * is a Stripe Route Handler on a SERVICE CLIENT — RLS off, `auth_org_id()` null. unbilledWorkForJob says
 * so in its own doc comment: a service-role caller must pin its org by hand, "because the service role
 * would otherwise read the first org it found". The step called it with no scope, and on that one door
 * three reads went wrong at once, silently:
 *
 *   · profile_pay is `where org_id = auth_org_id()`, so the service role reads ZERO rows and every
 *     person's bill_rate vanishes — including the owner's, which only that view supplies (its CASE
 *     folds bill_rate = coalesce(bill_rate, hourly_rate) for an owner, 0286).
 *   · organizations.select('settings').limit(1) is an ARBITRARY one of the companies sharing this
 *     database, so the default labor rate and material markup come from the wrong tenant.
 *   · job_codes has no org filter, so a code ANOTHER company marked non-billable drops this one's hours.
 *
 * Nothing errors. On ET's J-002 shape — 19.5 h at the owner's $150, a paid $2,000 deposit not yet taken
 * off a bill — the understated figure let the deposit "cover" the work, so the gate wrote status =
 * complete and pushed the office to hand $830 back to a customer who owed $925. Migration 0371's Done,
 * Not Billed pile cannot catch it: the job has a PAID bill.
 *
 * These run the REAL step against the REAL unbilledWorkForJob (nothing here mocks it, which is what the
 * other two tests of this door do) over a fake PostgREST holding three companies' rows — so what the
 * client does or does not narrow is the only thing that varies.
 */
const calls = vi.hoisted(() => ({ pushed: [] as string[], revalidated: [] as string[], reported: [] as string[] }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => calls.revalidated.push(p) }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: async (_k: string, id: string) => void calls.pushed.push(id) }));
vi.mock("@/lib/observe", () => ({ reportError: (where: string) => void calls.reported.push(where) }));

import { completeJobWhenPaid } from "./complete-job-when-paid";
import { finishBillingStep, type BillingAccess } from "./finish-bills-first";

/** ET Electric, and another company on the same database (Erik's three orgs, one database). */
const ET = "00000000-0000-4000-8000-000000000001";
const FERNHILL = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-00000000j002";
const ERIK = "00000000-0000-4000-8000-0000000owner";
const LAST_BILL = "inv-last";

const shift = (id: string, hours: number, at: string) => ({
  id,
  org_id: ET,
  job_id: JOB,
  status: "closed",
  profile_id: ERIK,
  clock_in: at,
  clock_out: new Date(Date.parse(at) + hours * 3_600_000).toISOString(),
  lunch_minutes: 0,
  job_code: "ELEC",
  split_from: null,
  profiles: { id: ERIK, full_name: "Erik" },
});

/**
 * 19.5 h closed on J-002 by one person, and the bill the customer just paid online.
 *
 * A PAID STANDARD BILL BESIDE A LIVE DEPOSIT DRAW IS A LEGAL STATE, and it is the one the flip needs.
 * H4 (isStandardBillingBlocker, invoice-math) blocks only a DRAFT standard invoice on a draw-billed job,
 * and nothing stops a deposit being taken on a job that already has a sent standard bill — ET's own J-002
 * is recorded as exactly this shape (actuals-draw's note, and jobs/actions' own note on INV-00006).
 */
function baseBooks(opts: { deposit?: number } = {}): Tables {
  return {
    invoices: [
      {
        id: LAST_BILL,
        org_id: ET,
        job_id: JOB,
        invoice_number: "INV-00080",
        invoice_kind: "standard",
        status: "paid",
        created_at: "2026-09-20T17:00:00Z",
        invoice_items: [],
      },
      ...(opts.deposit
        ? [
            {
              id: "inv-deposit",
              org_id: ET,
              job_id: JOB,
              invoice_number: "INV-00074",
              invoice_kind: "deposit",
              status: "paid",
              created_at: "2026-09-01T17:00:00Z",
              // A deposit's own amount line is lump money (lumpLineRule): nothing itemized from the job.
              invoice_items: [{ import_source: null, line_total: opts.deposit }],
            },
          ]
        : []),
    ],
    jobs: [
      {
        id: JOB,
        org_id: ET,
        status: "in_progress",
        billing_type: "tm",
        job_number: "J-002",
        name: "41 Larkspur",
        // No pricing level, so nothing caps the owner's own bill rate.
        customers: { name: "Marla Finch", pricing_levels: null },
      },
    ],
    payment_milestones: [],
    time_entries: [shift("te-1", 9.5, "2026-09-10T15:00:00Z"), shift("te-2", 10, "2026-09-11T15:00:00Z")],
    purchase_orders: [],
    bills: [],
    stock_moves: [],
    invoice_items: [],
    payments: [],
  };
}

/**
 * THE WEBHOOK'S CLIENT. RLS is off, so every company's rows are visible and nothing but an explicit
 * org filter narrows them: profile_pay answers nothing (its own `where org_id = auth_org_id()`), the
 * organizations list holds the other company FIRST so `limit(1)` picks it, and job_codes carries both
 * companies' non-billable codes.
 */
function serviceBooks(opts: { deposit?: number; otherCompanyAlsoBans?: string } = {}): Tables {
  return {
    ...baseBooks(opts),
    profile_pay: [],
    profiles: [{ id: ERIK, org_id: ET, role: "owner", full_name: "Erik", hourly_rate: null, bill_rate: 150 }],
    job_codes: [
      { id: "jc-et", org_id: ET, code: "SHOP", billable: false },
      { id: "jc-other", org_id: FERNHILL, code: opts.otherCompanyAlsoBans ?? "PTO", billable: false },
    ],
    organizations: [
      { id: FERNHILL, settings: { default_labor_rate: 60, material_markup_percent: 40 } },
      { id: ET, settings: { default_labor_rate: 150, material_markup_percent: 11 } },
    ],
  };
}

/**
 * A STAFF CLIENT, THE WAY RLS HANDS IT OVER: only ET's rows, the rates from profile_pay — and
 * `profiles` answering an error, because 0216 REVOKES hourly_rate and bill_rate from the authenticated
 * role. That is the trap in the obvious fix: a staff door handed an org scope would read profiles
 * directly, get a permission error, and turn every Finish Job press into "couldn't read this job's
 * hours and bills". The scope has to follow the CALLER, so this fixture stays green only while it does.
 */
function staffBooks(opts: { deposit?: number } = {}): Tables {
  return {
    ...baseBooks(opts),
    profile_pay: [{ id: ERIK, hourly_rate: 0, bill_rate: 150 }],
    profiles: [{ id: ERIK, org_id: ET, role: "owner", full_name: "Erik", hourly_rate: null, bill_rate: 150 }],
    job_codes: [{ id: "jc-et", org_id: ET, code: "SHOP", billable: false }],
    organizations: [{ id: ET, settings: { default_labor_rate: 150, material_markup_percent: 11 } }],
  };
}

const paidOff = (db: unknown, access: BillingAccess) => completeJobWhenPaid(db, LAST_BILL, access);

describe("a paid online bill prices the job's work in the job's own company", () => {
  beforeEach(() => {
    calls.pushed.length = 0;
    calls.revalidated.length = 0;
    calls.reported.length = 0;
  });

  /**
   * THE DEFECT, with money on both sides of it. $2,925 of work against a $2,000 deposit: the customer
   * owes $925. Priced through the unscoped reads the work came to $1,170, the deposit "covered" it, the
   * job went complete and the push said to settle $830 back to the customer.
   */
  it("THE DEFECT: a $2,000 deposit does not cover 19.5 h at the owner's own $150 — the job stays open and the office is told", async () => {
    const db = fakeDb(serviceBooks({ deposit: 2000 }));
    const r = await paidOff(db, { kind: "service", orgId: ET });

    expect(r.completed).toBe(false);
    expect(db.tables.jobs[0].status).toBe("in_progress");
    expect(db.log.some((l) => l.table === "jobs" && l.verb === "update")).toBe(false);
    expect(calls.pushed).toEqual([]);

    const say = (r as { say?: string }).say ?? "";
    // 19.5 h x $150 = $2,925.00, which is what no bill claims — never the other company's $1,170.
    expect(say).toContain("19.5 h ($2,925.00)");
    expect(say).toContain("41 Larkspur · J-002 — Marla Finch");
    expect(say).toContain("NOT finished yet");
    // And NOT the sentence that hands money back to a customer who owes it.
    expect(say).not.toContain("settle the difference with the customer");
    expect(say).not.toContain("$1,170.00");
  });

  /**
   * NO DEPOSIT, SO NO FLIP — but the one figure Erik acts on was still wrong, by the whole gap between
   * his bill rate and a foreign company's default. "Nothing dropped from a figure unsaid."
   */
  it("plain T&M: the 'Still to bill' sentence names the whole $2,925.00, not a foreign company's rate", async () => {
    const db = fakeDb(serviceBooks());
    const r = await paidOff(db, { kind: "service", orgId: ET });
    expect(r.completed).toBe(false);
    expect((r as { say?: string }).say).toContain("19.5 h ($2,925.00)");
    expect((r as { say?: string }).say).not.toContain("$1,170.00");
  });

  /**
   * THE SILENT ONE, AND THE ONE "BUILD FOR MILLIONS" MAKES A WHEN RATHER THAN AN IF. Another company
   * marks ELEC non-billable; ET bills it. Read unscoped, the union of both companies' non-billable codes
   * drops every hour on the job: hours 0 -> nothing pending -> the step skips -> the gate finishes the
   * job with 19.5 h off every bill and says NOTHING AT ALL. That is this lane's own defect, unfixed, on
   * the door the lane exists to close.
   */
  it("another company's non-billable code cannot zero this job's hours and end the job in silence", async () => {
    const db = fakeDb(serviceBooks({ otherCompanyAlsoBans: "ELEC" }));
    const r = await paidOff(db, { kind: "service", orgId: ET });
    expect(r.completed).toBe(false);
    expect(db.tables.jobs[0].status).toBe("in_progress");
    expect((r as { say?: string }).say).toContain("19.5 h ($2,925.00)");
  });

  /** ET's own non-billable code still drops ET's own hours: scoping narrows the read, it does not void it. */
  it("this company's OWN non-billable code still keeps its hours off the bill", async () => {
    const books = serviceBooks();
    for (const e of books.time_entries) e.job_code = "SHOP";
    const db = fakeDb(books);
    const r = await paidOff(db, { kind: "service", orgId: ET });
    expect(r.completed).toBe(true);
    expect(db.tables.jobs[0].status).toBe("complete");
    expect((r as { say?: string }).say).toBeUndefined();
  });

  /**
   * THE TRAP IN THE OBVIOUS FIX, PINNED. Pass a scope on the staff path and fetchJobLaborRows reads
   * profiles.hourly_rate/bill_rate directly — columns 0216 revokes from the authenticated role. This
   * fixture answers that read with an error, so a step that reached for it would come back "couldn't
   * read this job's hours and bills" instead of the figures.
   */
  it("a STAFF client keeps reading the pay view: the same $2,925.00, and the revoked columns are never touched", async () => {
    const db = fakeDb(staffBooks({ deposit: 2000 }), { failing: ["profiles"] });
    const r = await paidOff(db, { kind: "staff" });
    expect(r.completed).toBe(false);
    expect((r as { say?: string }).say).toContain("19.5 h ($2,925.00)");
    // Not the refusal a lost read produces — the figures were really read.
    expect(calls.reported).not.toContain("finishBillingStep.read");
    expect(db.log.some((l) => l.table === "profiles")).toBe(false);
  });

  /**
   * THE COMPANY ON THE JOB IS THE COMPANY THE DOOR PROVED (tenant isolation: a rule at ONE read path is
   * a convention, not a boundary). The webhook's org comes off Stripe metadata, which claimedInvoice has
   * checked against the INVOICE; nothing had ever checked it against the JOB whose hours get priced. A
   * job in another company — or in none — is priced by nobody and finished by nobody.
   */
  it.each([
    ["a different company", FERNHILL],
    ["no company at all", null],
  ])("a job in %s from the one the payment door proved is refused, loudly", async (_name, orgOnTheJob) => {
    const books = serviceBooks({ deposit: 2000 });
    books.jobs[0].org_id = orgOnTheJob;
    const db = fakeDb(books);
    const r = await paidOff(db, { kind: "service", orgId: ET });
    expect(r.completed).toBe(false);
    expect(db.tables.jobs[0].status).toBe("in_progress");
    expect((r as { say?: string }).say).toContain("41 Larkspur · J-002 — Marla Finch");
    expect(calls.reported).toContain("completeJobWhenPaid:job-org-mismatch");
    // Nothing was priced: the rates, the settings and the codes were never even read.
    expect(db.log.some((l) => ["profile_pay", "profiles", "organizations", "job_codes"].includes(l.table))).toBe(false);
  });
});

/**
 * AND THE STEP ITSELF REFUSES AN EMPTY COMPANY, wherever a future door comes from. A service client with
 * nothing to pin to is the unscoped read by another name, so it is the one thing this function may never
 * fall back to: it says so, in both its sentences, and reads no rates at all.
 */
describe("the billing step on a service client with no company", () => {
  beforeEach(() => {
    calls.reported.length = 0;
  });

  it("refuses rather than reading the first company it finds", async () => {
    const db = fakeDb(serviceBooks({ deposit: 2000 }));
    const step = await finishBillingStep(db as never, JOB, { kind: "service", orgId: "" });
    expect(step.kind).toBe("error");
    expect((step as { error: string }).error).toContain("which company's rates");
    // Said twice, and the push's half never tells a person to try something they did not do.
    expect((step as { said: string }).said).toContain("the app couldn't");
    expect((step as { said: string }).said).not.toMatch(/try again/i);
    expect(calls.reported).toContain("finishBillingStep.company");
    expect(db.log).toEqual([]);
  });
});
