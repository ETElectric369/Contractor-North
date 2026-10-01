import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * TWO DEVICES, ONE VISIT, ONE JOB (visit-start review, 2026-09-25).
 *
 * createJobFromAppointment reads appointments.job_id, inserts a job, then links it. Two taps at once
 * (the office on a laptop, Erik in the truck) both read "no job yet" and both insert. The link is
 * the claim: it lands only on a visit that still has no job, and the tap that loses re-reads,
 * deletes its own twin job and hands back the winner, so its clock goes on THAT job.
 *
 * The fake holds one visit row and a jobs table, and holds both inserts until both taps have made
 * their read, which is the exact interleaving that minted two jobs.
 */
const db = vi.hoisted(() => ({
  appt: null as any,
  jobs: new Map<string, any>(),
  customers: {} as Record<string, any>,
  inquiry: null as any,
  deleted: [] as string[],
  seq: 0,
  arrivals: 0,
  release: null as null | (() => void),
  gate: null as null | Promise<void>,
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client(), userId: "erik", orgId: "org-et" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
// appointments/actions pushes through notifyPeople (the Bell records every push, 0366 wave).
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
// THE WIN MINTS THE CUSTOMER (209451e1): the one rule every win uses, stubbed so the test can see it
// asked, and what the job was handed. null = the rule found no lead (the old tests' fresh leads).
const win = vi.hoisted(() => ({ customerForInquiry: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("@/lib/actions/win-customer", () => ({ customerForInquiry: win.customerForInquiry }));

import { createJobFromAppointment } from "./actions";

type Filter = [string, string, unknown];

function client() {
  return {
    from(table: string) {
      const q: { op: string; patch?: any; filters: Filter[] } = { op: "select", filters: [] };
      const matches = (row: any) =>
        q.filters.every(([op, c, v]) => (op === "eq" ? row?.[c] === v : op === "is" ? (row?.[c] ?? null) === v : true));
      const run = async (): Promise<{ data: any; error: null }> => {
        if (table === "appointments") {
          if (q.op === "update") {
            if (!matches(db.appt)) return { data: [], error: null };
            Object.assign(db.appt, q.patch);
            return { data: [{ id: db.appt.id }], error: null };
          }
          return { data: matches(db.appt) ? { ...db.appt } : null, error: null };
        }
        if (table === "jobs") {
          if (q.op === "insert") {
            // Both taps reach the insert before either links: the race, held open on purpose.
            db.arrivals += 1;
            if (db.arrivals === 2) db.release?.();
            await db.gate;
            const id = `job-${++db.seq}`;
            db.jobs.set(id, { id, ...q.patch });
            return { data: { id }, error: null };
          }
          if (q.op === "delete") {
            const id = q.filters.find(([, c]) => c === "id")?.[2] as string;
            db.deleted.push(id);
            db.jobs.delete(id);
            return { data: [{ id }], error: null };
          }
        }
        if (table === "organizations") return { data: { settings: {} }, error: null };
        if (table === "inquiries") return { data: q.filters.some(([, c, v]) => c === "id" && v === db.inquiry?.id) ? db.inquiry : null, error: null };
        if (table === "customers") return { data: db.customers[q.filters.find(([, c]) => c === "id")?.[2] as string] ?? null, error: null };
        throw new Error(`unrouted: ${table} ${q.op}`);
      };
      const chain: any = {
        select: () => chain,
        insert(p: any) {
          q.op = "insert";
          q.patch = p;
          return chain;
        },
        update(p: any) {
          q.op = "update";
          q.patch = p;
          return chain;
        },
        delete() {
          q.op = "delete";
          return chain;
        },
        eq(c: string, v: unknown) {
          q.filters.push(["eq", c, v]);
          return chain;
        },
        is(c: string, v: unknown) {
          q.filters.push(["is", c, v]);
          return chain;
        },
        limit: () => chain,
        single: run,
        maybeSingle: run,
        then: (ok: any, bad: any) => run().then(ok, bad),
      };
      return chain;
    },
  };
}

beforeEach(() => {
  db.appt = {
    id: "appt-tom",
    title: "Walk-Through: Tom Goodman",
    customer_id: "cust-tom",
    location: "3245 W. Lake Blvd",
    city: null,
    state: null,
    zip: null,
    job_id: null,
    starts_at: "2026-09-25T17:00:00.000Z",
    ends_at: null,
    planned_minutes: null,
    inquiry_id: null,
  };
  db.jobs = new Map();
  db.customers = { "cust-tom": { name: "Rita Moss", company_name: null, type: "residential" } };
  db.inquiry = null;
  db.deleted = [];
  db.seq = 0;
  db.arrivals = 0;
  db.gate = new Promise<void>((r) => (db.release = r));
});

describe("createJobFromAppointment: the link is the claim", () => {
  it("two interleaved taps leave one job, linked, and both answers name it", async () => {
    const [a, b] = await Promise.all([createJobFromAppointment("appt-tom"), createJobFromAppointment("appt-tom")]);

    expect(a.ok && b.ok).toBe(true);
    expect(a.id).toBe(b.id);
    expect(db.appt.job_id).toBe(a.id);
    expect(db.jobs.size).toBe(1);
    expect([...db.jobs.keys()]).toEqual([a.id]);
    expect(db.deleted).toHaveLength(1);
    // Exactly one of the two says "the visit already had it".
    expect([a.already, b.already].filter(Boolean)).toHaveLength(1);
  });

  it("a single tap makes and links its job", async () => {
    db.release?.();
    db.arrivals = 1;
    const res = await createJobFromAppointment("appt-tom");
    expect(res).toMatchObject({ ok: true, id: "job-1" });
    expect(res.already).toBeUndefined();
    expect(db.appt.job_id).toBe("job-1");
    expect(db.deleted).toEqual([]);
  });

  it("a visit that already has a job returns it, marked already, and makes nothing", async () => {
    db.appt.job_id = "job-55";
    const res = await createJobFromAppointment("appt-tom");
    expect(res).toEqual({ ok: true, id: "job-55", already: true });
    expect(db.jobs.size).toBe(0);
  });
});

/**
 * THE JOB IS NAMED FOR THE STREET, NEVER FOR THE VISIT (Erik 2026-09-27: "site inspections are
 * labeled with the tag they shouldnt carry site inspection in the job title"; 09-28, final: "street
 * number and name as always"). A job was born "Site inspection: Rita Moss" because this door copied
 * the visit's title. Now: the visit's street number and name (" #<unit>" with its unit); with no
 * street, who as written and the visit's own words, tag off.
 */
describe("createJobFromAppointment: the job's name is the street, never the visit's tag", () => {
  const madeJob = async () => {
    db.release?.();
    db.arrivals = 1;
    const res = await createJobFromAppointment("appt-tom");
    expect(res.ok).toBe(true);
    return db.jobs.get(res.id!) as { name: string; unit?: string | null };
  };
  const madeName = async () => (await madeJob()).name;
  beforeEach(() => {
    db.appt.location = "12 Test Elm St";
  });

  it("with a street, the street, whatever the visit's title says", async () => {
    // An old stored stock title and the new one (W2-10's "Walk-Through: …") both give the street.
    for (const title of ["Site inspection: Rita Moss", "Walk-Through: Rita Moss", "Service call — Hot tub circuit", "RV Inspection", "Call Rita Moss", "Call box install", null]) {
      db.jobs = new Map();
      db.appt.job_id = null;
      db.appt.title = title;
      expect(await madeName(), String(title)).toBe("12 Test Elm St");
    }
  });

  it("the street comes off the one-line location, never the town", async () => {
    db.appt.location = "12 Elm St, Testville, CA 96161";
    db.appt.title = "Site inspection: Rita Moss";
    expect(await madeName()).toBe("12 Elm St");
  });

  it("the visit's unit rides on the name as #<unit>, and onto the job", async () => {
    db.appt.location = "300 Test Lake Blvd, Testville, CA 96161";
    db.appt.unit = "Unit 56";
    const job = await madeJob();
    expect(job.name).toBe("300 Test Lake Blvd #56");
    expect(job.unit).toBe("Unit 56");
  });

  describe("no street", () => {
    beforeEach(() => {
      db.appt.location = null;
    });

    it("a tag and the customer is who, as written", async () => {
      db.appt.title = "Site inspection: Rita Moss";
      expect(await madeName()).toBe("Rita Moss");
      // The new stock title (W2-10) is a tag too: never "Walk-Through: …" on a job.
      db.jobs = new Map();
      db.appt.job_id = null;
      db.appt.title = "Walk-Through: Rita Moss";
      expect(await madeName()).toBe("Rita Moss");
    });

    it("the visit's own words follow who, with the tag taken off", async () => {
      db.appt.title = "Service call — Hot tub circuit";
      expect(await madeName()).toBe("Rita Moss · Hot tub circuit");
    });

    it("a real name that contains the word is the work", async () => {
      db.appt.title = "RV Inspection";
      expect(await madeName()).toBe("Rita Moss · RV Inspection");
    });

    it('a phone-call booking ("Call Rita Moss", bookingTitle\'s call kind) is never named after the call', async () => {
      db.appt.title = "Call Rita Moss";
      expect(await madeName()).toBe("Rita Moss");
    });

    it('"Call box install" is the work', async () => {
      db.appt.title = "Call box install";
      expect(await madeName()).toBe("Rita Moss · Call box install");
    });

    it("no card on the visit: the lead's name says who", async () => {
      db.appt.customer_id = null;
      db.appt.inquiry_id = "inq-1";
      db.appt.title = "Site inspection: Rich Test";
      db.inquiry = { id: "inq-1", customer_id: null, name: "Rich Test", company_name: null, type: "residential" };
      expect(await madeName()).toBe("Rich Test");
    });

    it("the lead got its card after booking, spelled another way: named for the card, the lead's spelling still only-who", async () => {
      db.appt.customer_id = null;
      db.appt.inquiry_id = "inq-2";
      db.appt.title = "Site inspection: Rich Test";
      db.customers["cust-rich"] = { name: "Richard Test", company_name: null, type: "residential" };
      db.inquiry = { id: "inq-2", customer_id: "cust-rich", name: "Rich Test", company_name: null, type: "residential" };
      expect(await madeName()).toBe("Richard Test");
    });

    it('no title at all is never "Job from appointment"', async () => {
      db.appt.title = null;
      expect(await madeName()).toBe("Rita Moss");
    });
  });
});

/**
 * A FRESH LEAD'S VISIT STARTS A JOB WITH A CONTACT (209451e1). The inspection door books the visit
 * with customer_id null on purpose, so a lead → visit → Start The Job wrote jobs.customer_id = null,
 * stamped the lead won and minted nobody: no contact on the job, no card until money landed. Now
 * the one rule every win uses (customerForInquiry: dedup by phone / email / name, the person's own
 * address, the lead stamped won) mints the card here, and the job, the visit and the lead all carry
 * it. The visit's notes (the lead's message) become the job's description.
 */
describe("createJobFromAppointment: a fresh lead gets its customer, and the job its description", () => {
  beforeEach(() => {
    win.customerForInquiry.mockClear();
    win.customerForInquiry.mockResolvedValue(null);
    db.release?.();
    db.arrivals = 1;
  });

  it("a lead with no customer: the card is minted through customerForInquiry and the job, the visit and the description carry it", async () => {
    db.appt.customer_id = null;
    db.appt.inquiry_id = "inq-fresh";
    db.appt.notes = "Kitchen hood outlet, wants it before the range arrives.";
    db.inquiry = { id: "inq-fresh", customer_id: null, name: "Jackie Burks", company_name: null, type: "residential" };
    win.customerForInquiry.mockResolvedValue("cust-minted");
    db.customers["cust-minted"] = { name: "Jackie Burks", company_name: null, type: "residential" };

    const res = await createJobFromAppointment("appt-tom");
    expect(res.ok).toBe(true);
    expect(win.customerForInquiry).toHaveBeenCalledTimes(1);
    // The staff client, the lead, and who did it: the rule's own signature.
    expect(win.customerForInquiry).toHaveBeenCalledWith(expect.anything(), "inq-fresh", "erik");
    const job = db.jobs.get(res.id!);
    expect(job.customer_id).toBe("cust-minted");
    expect(job.description).toBe("Kitchen hood outlet, wants it before the range arrives.");
    // The visit keeps the same answer the job got: one contact, both records.
    expect(db.appt.customer_id).toBe("cust-minted");
  });

  it("a visit that already has a customer never asks the rule, and a visit with no notes makes no description", async () => {
    db.appt.customer_id = "cust-tom";
    db.appt.inquiry_id = "inq-1";
    db.inquiry = { id: "inq-1", customer_id: null, name: "Rita Moss", company_name: null, type: "residential" };
    const res = await createJobFromAppointment("appt-tom");
    expect(res.ok).toBe(true);
    expect(win.customerForInquiry).not.toHaveBeenCalled();
    expect(db.jobs.get(res.id!).customer_id).toBe("cust-tom");
    expect(db.jobs.get(res.id!).description).toBeNull();
  });

  it("the rule finds nobody (a lead it couldn't read): the job is still made, customer-less, as before", async () => {
    db.appt.customer_id = null;
    db.appt.inquiry_id = "inq-gone";
    db.inquiry = { id: "inq-gone", customer_id: null, name: "Rich Test", company_name: null, type: "residential" };
    const res = await createJobFromAppointment("appt-tom");
    expect(res.ok).toBe(true);
    expect(db.jobs.get(res.id!).customer_id).toBeNull();
  });
});
