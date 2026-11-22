import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE OLDER DOOR TIES ITS JOB TO THE STANDING ESTIMATE (cn-v1177, the owner's pick 3).
 *
 * Start a Job from This Visit and Convert to Job both run createJobFromAppointment. On a sales visit
 * with an estimate out, the job they made was a second job the moment that estimate was accepted.
 * Now: an accepted estimate is refused by the Won sheet's own decision (readWonSheet, called), and a
 * draft or sent estimate with no job is tied to the new job by a certain link only: the visit's
 * capture backlink, else the lead's ONLY live estimate. Never by a name, never one that has a job,
 * never one of several.
 *
 * The fake holds the visit, the jobs and the quotes; every write is compare-and-set as the real
 * PostgREST call is, so a zero-row tie is a zero-row tie.
 */
const db = vi.hoisted(() => ({
  appt: null as any,
  jobs: new Map<string, any>(),
  quotes: [] as any[],
  seq: 0,
  failQuoteRead: false,
  stealOnTie: false,
}));
const won = vi.hoisted(() => ({ readWonSheet: vi.fn(async (): Promise<any> => ({ ok: true, state: "plain", why: "nothing_priced", billingKind: "tm", noCustomer: false })) }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client(), userId: "u-sam", orgId: "org-larkspur" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/actions/win-customer", () => ({ customerForInquiry: vi.fn(async () => null) }));
vi.mock("@/lib/appointments/visit-work", () => ({
  visitWork: vi.fn(async () => ({ birth: { tasks: [], plannedMinutes: null, parts: [] }, typedItems: [], notes: [] })),
}));
vi.mock("./won-actions", () => ({ readWonSheet: won.readWonSheet }));

import { createJobFromAppointment } from "./actions";

type Filter = [string, string, unknown];

function client() {
  return {
    from(table: string) {
      const q: { op: string; patch?: any; filters: Filter[] } = { op: "select", filters: [] };
      const matches = (row: any) =>
        q.filters.every(([op, c, v]) =>
          op === "eq" ? row?.[c] === v : op === "is" ? (row?.[c] ?? null) === v : op === "in" ? (v as unknown[]).includes(row?.[c]) : true,
        );
      const run = async (single: boolean): Promise<{ data: any; error: any }> => {
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
            const id = `job-${++db.seq}`;
            db.jobs.set(id, { id, job_number: `J-90${db.seq}`, ...q.patch });
            return { data: { id }, error: null };
          }
          const id = q.filters.find(([, c]) => c === "id")?.[2] as string;
          return { data: db.jobs.get(id) ?? null, error: null };
        }
        if (table === "quotes") {
          if (q.op === "update") {
            if (db.stealOnTie) for (const r of db.quotes) r.job_id = r.job_id ?? "job-elsewhere";
            const hit = db.quotes.filter(matches);
            for (const r of hit) Object.assign(r, q.patch);
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          }
          if (db.failQuoteRead) return { data: null, error: { message: "read failed", code: "XX000" } };
          const rows = db.quotes.filter(matches).map((r) => ({ ...r }));
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        }
        if (table === "organizations") return { data: { settings: {} }, error: null };
        if (table === "inquiries") return { data: null, error: null };
        if (table === "customers") return { data: null, error: null };
        if (table === "profiles") return { data: null, error: null };
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
        in(c: string, v: unknown[]) {
          q.filters.push(["in", c, v]);
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        single: () => run(true),
        maybeSingle: () => run(true),
        then: (ok: any, bad: any) => run(false).then(ok, bad),
      };
      return chain;
    },
  };
}

const quote = (over: Record<string, unknown>) => ({ org_id: "org-larkspur", inquiry_id: null, job_id: null, status: "sent", ...over });

beforeEach(() => {
  db.appt = {
    id: "appt-larkspur",
    title: "Inspection: Dana Rook",
    type: "inspection",
    outcome: null,
    status: "completed",
    customer_id: "cust-dana",
    location: "12 Larkspur Lane",
    city: null,
    state: null,
    zip: null,
    job_id: null,
    capture_quote: null,
    starts_at: "2026-11-21T17:00:00.000Z",
    ends_at: null,
    planned_minutes: null,
    inquiry_id: null,
  };
  db.jobs = new Map();
  db.quotes = [];
  db.seq = 0;
  db.failQuoteRead = false;
  db.stealOnTie = false;
  won.readWonSheet.mockClear();
  won.readWonSheet.mockImplementation(async () => ({ ok: true, state: "plain", why: "nothing_priced", billingKind: "tm", noCustomer: false }));
});

describe("createJobFromAppointment on a sales visit: the standing estimate is tied, by a certain link only", () => {
  it("the estimate written up from this visit (its capture backlink), sent with no job, becomes the new job's, said in one line", async () => {
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "sent" })];
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(true);
    expect(db.jobs.size).toBe(1);
    expect(db.quotes[0].job_id).toBe(res.id);
    expect(res.tied).toBe("E-900 is now this job's estimate.");
    expect(res.note).toBeUndefined();
    expect(won.readWonSheet).toHaveBeenCalledWith("appt-larkspur");
  });

  it("a draft estimate from the visit is tied too", async () => {
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "draft" })];
    const res = await createJobFromAppointment("appt-larkspur");
    expect(db.quotes[0].job_id).toBe(res.id);
    expect(res.tied).toContain("E-900");
  });

  it("the visit's own estimate that already has a job is never touched, and no lead estimate is put in its place", async () => {
    db.appt.capture_quote = "q-e900";
    db.appt.inquiry_id = "lead-snowbell";
    db.quotes = [
      quote({ id: "q-e900", quote_number: "E-900", status: "sent", job_id: "job-elsewhere" }),
      quote({ id: "q-e901", quote_number: "E-901", status: "sent", inquiry_id: "lead-snowbell" }),
    ];
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(true);
    expect(db.quotes[0].job_id).toBe("job-elsewhere");
    expect(db.quotes[1].job_id).toBeNull();
    expect(res.tied).toBeUndefined();
  });

  it("no estimate from the visit: the lead's ONE live estimate with no job is tied", async () => {
    db.appt.inquiry_id = "lead-snowbell";
    db.quotes = [
      quote({ id: "q-e901", quote_number: "E-901", status: "sent", inquiry_id: "lead-snowbell" }),
      // Not live, or already on a job: never a candidate.
      quote({ id: "q-e902", quote_number: "E-902", status: "declined", inquiry_id: "lead-snowbell" }),
      quote({ id: "q-e903", quote_number: "E-903", status: "draft", inquiry_id: "lead-snowbell", job_id: "job-elsewhere" }),
      // Another company's estimate on a lead id that matches is never read: the company is pinned.
      quote({ id: "q-x", quote_number: "E-999", status: "sent", inquiry_id: "lead-snowbell", org_id: "org-snowbell" }),
    ];
    const res = await createJobFromAppointment("appt-larkspur");
    expect(db.quotes.find((q) => q.id === "q-e901")!.job_id).toBe(res.id);
    expect(db.quotes.find((q) => q.id === "q-e902")!.job_id).toBeNull();
    expect(db.quotes.find((q) => q.id === "q-e903")!.job_id).toBe("job-elsewhere");
    expect(db.quotes.find((q) => q.id === "q-x")!.job_id).toBeNull();
    expect(res.tied).toBe("E-901 is now this job's estimate.");
  });

  it("several live estimates on the lead: none is picked, and the warning says how many and which", async () => {
    db.appt.inquiry_id = "lead-snowbell";
    db.quotes = [
      quote({ id: "q-e901", quote_number: "E-901", status: "sent", inquiry_id: "lead-snowbell" }),
      quote({ id: "q-e902", quote_number: "E-902", status: "draft", inquiry_id: "lead-snowbell" }),
    ];
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(true);
    expect(db.quotes.every((q) => q.job_id === null)).toBe(true);
    expect(res.tied).toBeUndefined();
    expect(res.note).toBe("2 estimates for this lead are still open (E-901, E-902), so none was tied to J-901. Ask Nort to attach the one that is this work to J-901.");
  });

  it("a tie that lands on zero rows (another door gave the estimate a job a moment ago) is not a tie: it is said", async () => {
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "sent" })];
    db.stealOnTie = true;
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(true);
    expect(db.quotes[0].job_id).toBe("job-elsewhere");
    expect(res.tied).toBeUndefined();
    expect(res.note).toBe("E-900 could not be tied to J-901. Ask Nort to attach E-900 to J-901.");
  });

  it("a failed read of the estimates is never 'no estimate': the job is made and the warning says it", async () => {
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "sent" })];
    db.failQuoteRead = true;
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(true);
    expect(db.quotes[0].job_id).toBeNull();
    expect(res.note).toContain("Couldn't check just now for an estimate to tie to J-901.");
  });
});

describe("an ACCEPTED estimate behind the sale is refused as the Won sheet's start refuses it, and nothing is made", () => {
  it("accepted with no job (finish): refused in the Won sheet's words, no job, the estimate untouched", async () => {
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "accepted" })];
    won.readWonSheet.mockImplementation(async () => ({ ok: true, state: "finish", quote: { id: "q-e900", number: "E-900" }, total: 100, billingKind: "tm" }));
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("E-900 is already accepted, so the job comes from it: tap Finish the Job from E-900. Nothing was started.");
    expect(db.jobs.size).toBe(0);
    expect(db.quotes[0].job_id).toBeNull();
    expect(db.appt.job_id).toBeNull();
  });

  it("the lead's accepted estimate already has its job (refer): refused, naming that job", async () => {
    won.readWonSheet.mockImplementation(async () => ({ ok: true, state: "refer", quote: { id: "q", number: "E-900" }, job: { id: "j", number: "J-900" } }));
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("E-900 is already accepted and has its job, J-900");
    expect(res.error).toContain("Nothing was started.");
    expect(db.jobs.size).toBe(0);
  });

  it("the accepted estimate behind the visit has its job (has_job): refused", async () => {
    won.readWonSheet.mockImplementation(async () => ({ ok: true, state: "has_job", job: { id: "j", number: "J-900" } }));
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(false);
    expect(db.jobs.size).toBe(0);
  });

  it("the decision's read failed: nothing is made, and its own words are said", async () => {
    won.readWonSheet.mockImplementation(async () => ({ ok: false, error: "Couldn't read this visit's estimate just now." }));
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res).toEqual({ ok: false, error: "Couldn't read this visit's estimate just now." });
    expect(db.jobs.size).toBe(0);
  });
});

describe("only the older door on a sale asks", () => {
  it("a work visit (not a sale) is made as it always was: no decision read, nothing tied", async () => {
    db.appt.type = "job";
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "sent" })];
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(true);
    expect(won.readWonSheet).not.toHaveBeenCalled();
    expect(db.quotes[0].job_id).toBeNull();
  });

  it("a visit marked Not Sold is not a sale being started: no decision read, nothing tied", async () => {
    db.appt.outcome = "lost";
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "sent" })];
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res.ok).toBe(true);
    expect(won.readWonSheet).not.toHaveBeenCalled();
    expect(db.quotes[0].job_id).toBeNull();
  });

  it("the Won sheet's own start (asSale) asked before it called: this door neither re-asks nor ties", async () => {
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "sent" })];
    const res = await createJobFromAppointment("appt-larkspur", { asSale: true });
    expect(res.ok).toBe(true);
    expect(won.readWonSheet).not.toHaveBeenCalled();
    expect(db.quotes[0].job_id).toBeNull();
  });

  it("a visit that already has its job answers with it: nothing read, nothing tied", async () => {
    db.appt.job_id = "job-there";
    db.appt.capture_quote = "q-e900";
    db.quotes = [quote({ id: "q-e900", quote_number: "E-900", status: "sent" })];
    const res = await createJobFromAppointment("appt-larkspur");
    expect(res).toEqual({ ok: true, id: "job-there", already: true });
    expect(won.readWonSheet).not.toHaveBeenCalled();
    expect(db.quotes[0].job_id).toBeNull();
  });
});

/**
 * AFTER THE TIE, ACCEPTANCE REUSES THE JOB AND DOES NOT ADD THE VISIT'S WORK A SECOND TIME. The two
 * acceptance doors are other lanes' files and the database's; these pins hold the path the tie leads
 * into, so a change that made either door mint a job for a linked estimate, or birth the tasks bare
 * on one, fails here. The task and part matching itself is proven where it lives:
 * lib/estimate/sync-job-tasks.test.ts ("a visit's task is re-keyed to the line built from it") and
 * sync-job-materials.test.ts; the customer's link onto a job already there is proven against the
 * database in lib/born-from-estimate.integration.test.ts ("no job is made").
 */
describe("what the tie leads into (pins on the acceptance doors)", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("the office's acceptance: a linked estimate returns its job before any job is inserted, and catches up through the sync, never the bare birth", () => {
    const src = read("src/app/(app)/quotes/actions.ts");
    const start = src.indexOf("export async function createJobFromQuote(");
    const linked = src.indexOf("if (q.job_id) {", start);
    const insert = src.indexOf('.from("jobs")\n    .insert(', start);
    const firstInsert = insert > 0 ? insert : src.indexOf('from("jobs").insert(', start);
    expect(start).toBeGreaterThan(0);
    expect(linked).toBeGreaterThan(start);
    expect(firstInsert === -1 || linked < firstInsert).toBe(true);
    const branch = src.slice(linked, src.indexOf("\n  }\n", linked));
    expect(branch).toContain("return { ok: true, id: q.job_id };"); // a draft or sent estimate on the job: its job, nothing else
    expect(branch).toContain("const follow = await jobFollows(");
    expect(branch).not.toContain("bornTasks(");
  });
  it("the customer's link: the follow-up after accept_public_quote syncs the tasks and the list (re-keys the visit's), never the bare birth", () => {
    const src = read("src/app/q/[token]/actions.ts");
    const body = src.slice(src.indexOf("async function finishPublicAcceptance("), src.indexOf("async function finishPublicAcceptance(") + 8000);
    expect(body).toContain("await syncJobTasks(sb, {");
    expect(body).toContain("await syncJobMaterials(sb, {");
    expect(body).not.toContain("bornTasks(");
  });
  it("the sync's own rule: a task Start the Job put on the job from the visit finds the estimate's line, never doubles", () => {
    const rule = read("src/lib/estimate/sync-job-tasks.ts");
    expect(rule).toContain('export const VISIT_KEY = "task:";');
    // The visit's task claims the estimate line that remembers its task id, before anything is inserted.
    expect(rule).toContain("for (const t of visit) claim(t, (w) => !!w.task_id && `${VISIT_KEY}${w.task_id}` === t.source_key);");
  });
});
