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
        if (table === "inquiries") return { data: null, error: null };
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
    title: "Inspection — Tom Goodman",
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
