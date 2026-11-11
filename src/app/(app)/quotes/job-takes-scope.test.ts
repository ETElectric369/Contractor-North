import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A JOB BORN FROM AN ESTIMATE TAKES THE ESTIMATE'S SCOPE: THE OFFICE'S DOOR (cn-v1160). The owner,
 * 2026-11-10, on a job made from an accepted estimate: "i like how the new estimate tasks carry
 * though to the items to buy and created a task to be done but the scope remains empty when that can
 * be filled from the estimate description all the way through we already have the information
 * right?" The job's Description is the scope the crew reads, and New Invoice copies it onto the
 * customer's bill.
 *
 * createJobFromQuote is CALLED here against a recording client (the one-editor-doors lesson: a green
 * source pin proved nothing), and what it wrote is read back off the recording:
 *   · a NEW job is inserted with the estimate's description, trimmed by the one rule
 *     (lib/estimate/job-scope); an estimate with no words names no column;
 *   · an estimate ACCEPTED onto a job that already exists fills the job's Description only while it
 *     is empty: a compare-and-set on the exact value read, pinned to the job's id, read back;
 *   · words a person typed are never replaced;
 *   · a fill that fails is reported and never fails the acceptance.
 * The customer's own Accept is SQL (accept_public_quote) and has its own database suite.
 */
type Call = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; payload?: unknown; select?: string; filters: unknown[][] };
const s = vi.hoisted(() => ({
  calls: [] as { table: string; verb: string; payload?: unknown; select?: string; filters: unknown[][] }[],
  answer: null as null | ((c: { table: string; verb: string; payload?: unknown; select?: string; filters: unknown[][] }) => unknown),
  reported: [] as { where: string; error: unknown; extra: unknown }[],
}));

function builder(table: string) {
  const c: Call = { table, verb: "select", filters: [] };
  const run = () => s.answer?.(c) ?? { data: null, error: null };
  const b: any = {
    select: (cols?: string) => ((c.select = cols), b),
    insert: (p: unknown) => ((c.verb = "insert"), (c.payload = p), b),
    update: (p: unknown) => ((c.verb = "update"), (c.payload = p), b),
    delete: () => ((c.verb = "delete"), b),
    maybeSingle: async () => (s.calls.push(c), run()),
    single: async () => (s.calls.push(c), run()),
    then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => (s.calls.push(c), Promise.resolve().then(run).then(ok, err)),
  };
  for (const m of ["eq", "in", "is", "or", "order", "limit", "neq", "not"]) b[m] = (...a: unknown[]) => (c.filters.push([m, ...a]), b);
  return b;
}
const client = {
  from: (t: string) => builder(t),
  rpc: async (fn: string, args: unknown) => {
    const c: Call = { table: fn, verb: "rpc", payload: args, filters: [] };
    s.calls.push(c);
    return s.answer?.(c) ?? { data: null, error: null };
  },
  auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
// reportError writes to error_events through the service client; here it only records.
vi.mock("@/lib/observe", () => ({ reportError: (where: string, error: unknown, extra?: unknown) => void s.reported.push({ where, error, extra }) }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
// The birth, the job's two rules and the paperwork doors, as spies (their own suites drive them): what
// this door does around them is the point.
const rules = vi.hoisted(() => ({
  estimateLines: vi.fn(async () => ({ lines: [], minutes: 120, taskMinutes: new Map(), partCounts: new Map() })),
  syncJobTasks: vi.fn(async () => ({ inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false, sizeNow: null })),
  syncJobMaterials: vi.fn(async () => ({ inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] })),
  bornWithTasks: vi.fn(async () => ({ inserted: 1, plannedSet: true, birth: { tasks: [], plannedMinutes: null, parts: [] } })),
  createWorkOrderFromQuote: vi.fn(async () => ({ ok: true })),
  createMaterialListFromQuote: vi.fn(async () => ({ ok: true })),
  supersedeRevised: vi.fn(async (): Promise<{ superseded: string[]; error?: string }> => ({ superseded: [] })),
}));
vi.mock("@/lib/estimate/sync-job-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), estimateLines: rules.estimateLines, syncJobTasks: rules.syncJobTasks }));
vi.mock("@/lib/estimate/sync-job-materials", async (importOriginal) => ({ ...(await importOriginal<object>()), syncJobMaterials: rules.syncJobMaterials }));
vi.mock("@/lib/estimate/born-with-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), bornWithTasks: rules.bornWithTasks }));
vi.mock("@/lib/estimate/revision", async (importOriginal) => ({ ...(await importOriginal<object>()), supersedeRevised: rules.supersedeRevised }));
vi.mock("@/app/(app)/work-orders/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createWorkOrderFromQuote: rules.createWorkOrderFromQuote }));
vi.mock("@/app/(app)/materials/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createMaterialListFromQuote: rules.createMaterialListFromQuote }));

const { createJobFromQuote } = await import("./actions");
const { scopeForJob } = await import("@/lib/estimate/job-scope");

const quoteRead = (c: Call) => c.table === "quotes" && c.verb === "select" && !!c.select?.startsWith("id, job_id, status,");
const jobInsert = (c: Call) => c.table === "jobs" && c.verb === "insert";
const link = (c: Call) => c.table === "quotes" && c.verb === "update" && "job_id" in (c.payload as object);
/** The fill's two steps on a job that already exists: what its Description holds, then the write. */
const scopeRead = (c: Call) => c.table === "jobs" && c.verb === "select" && c.select === "description";
const scopeWrite = (c: Call) => c.table === "jobs" && c.verb === "update";
const scopeReports = () => s.reported.filter((r) => r.where === "createJobFromQuote:scope");

/** The estimate's scope paragraph, as a person leaves it: blank space at both ends, its own line break inside. */
const TYPED = "  \n\tReplace the 100 A panel.\r\nNew 200 A service, two ground rods.\n\n ";
const SCOPE = "Replace the 100 A panel.\r\nNew 200 A service, two ground rods.";
const QUOTE = {
  id: "q1", job_id: null as string | null, status: "accepted", customer_id: "c1", title: "Snowbell panel", quote_number: "E-040", inquiry_id: null,
  address: null, unit: null, city: null, state: null, zip: null, revises_quote_id: null,
};

beforeEach(() => {
  s.calls = [];
  s.reported = [];
  s.answer = null;
  for (const spy of Object.values(rules)) spy.mockClear();
  rules.supersedeRevised.mockImplementation(async () => ({ superseded: [] }));
});

describe("the estimate's description is asked for: a column not selected cannot be inherited", () => {
  it("createJobFromQuote's read of the estimate names description, beside the address it already inherited", async () => {
    s.answer = (c) => (quoteRead(c as Call) ? { data: null, error: null } : { data: null, error: null });
    await createJobFromQuote("q1");
    const asked = (s.calls.find((c) => quoteRead(c as Call))!.select ?? "").split(", ");
    expect(asked).toEqual(expect.arrayContaining(["description", "address", "unit", "city", "state", "zip", "job_id", "status"]));
  });
});

describe("a NEW job is born with the estimate's scope", () => {
  /** An accepted estimate with no job yet; `description` left out means the row holds none. */
  const world = (description?: unknown) => (c: Call): unknown => {
    if (quoteRead(c)) return { data: { ...QUOTE, ...(description === undefined ? {} : { description }) }, error: null };
    if (jobInsert(c)) return { data: { id: "j-new" }, error: null };
    if (link(c)) return { data: [{ id: "q1" }], error: null };
    if (c.table === "customers" && c.select === "name, company_name, type") return { data: { name: "Larkspur Holdings", company_name: null, type: "residential" }, error: null };
    return { data: null, error: null };
  };
  const inserted = () => s.calls.find((c) => jobInsert(c as Call))!.payload as Record<string, unknown>;

  it("the job's Description is the estimate's description with the blank space at its ends removed; what is inside it is untouched", async () => {
    s.answer = world(TYPED) as never;
    expect(await createJobFromQuote("q1")).toEqual({ ok: true, id: "j-new" });
    expect(inserted().description).toBe(SCOPE);
    // The one rule (lib/estimate/job-scope), not a trim of this door's own.
    expect(inserted().description).toBe(scopeForJob(TYPED));
    expect(rules.bornWithTasks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no description on the row", undefined],
    ["null", null],
    ["an empty string", ""],
    ["only blank space", " \t\r\n  \n"],
    ["something that is not text", 42],
  ])("an estimate with no words (%s) names no column: the job is born with no Description, as before", async (_name, description) => {
    s.answer = world(description) as never;
    expect(await createJobFromQuote("q1")).toEqual({ ok: true, id: "j-new" });
    expect("description" in inserted()).toBe(false);
  });

  it("nothing else about the birth moved: the same columns with the same values, and one more", async () => {
    s.answer = world() as never;
    await createJobFromQuote("q1");
    const without = { ...inserted() };
    s.calls = [];
    s.answer = world(TYPED) as never;
    await createJobFromQuote("q1");
    const { description, ...rest } = inserted();
    expect(description).toBe(SCOPE);
    expect(rest).toEqual(without);
    expect(Object.keys(without)).toEqual(expect.arrayContaining(["customer_id", "inquiry_id", "name", "billing_type", "status", "created_by"]));
  });

  it("the birth is the only write to the job: the fill is for a job that already exists", async () => {
    s.answer = world(TYPED) as never;
    await createJobFromQuote("q1");
    expect(s.calls.filter((c) => c.table === "jobs" && c.verb !== "select").map((c) => c.verb)).toEqual(["insert"]);
    expect(s.calls.filter((c) => scopeRead(c as Call))).toEqual([]);
    expect(scopeReports()).toEqual([]);
  });
});

describe("an estimate ACCEPTED onto a job that already exists fills the job's Description only while it is empty", () => {
  /**
   * An accepted estimate already on job j1. `job`: what the job's Description read answers; `write`:
   * what the fill answers; `again`: what the read after a zero-row write answers.
   */
  const world = (o: { status?: string; description?: unknown; job?: unknown; write?: unknown | (() => unknown); again?: unknown }) => (c: Call): unknown => {
    if (quoteRead(c)) return { data: { ...QUOTE, job_id: "j1", status: o.status ?? "accepted", description: "description" in o ? o.description : TYPED }, error: null };
    // The call is on the recording before it is answered, so the first read counts one.
    if (scopeRead(c)) return s.calls.filter((x) => scopeRead(x as Call)).length === 1 ? (o.job ?? { data: { description: null }, error: null }) : (o.again ?? { data: null, error: null });
    if (scopeWrite(c)) return typeof o.write === "function" ? (o.write as () => unknown)() : (o.write ?? { data: [{ id: "j1" }], error: null });
    return { data: null, error: null };
  };
  const writes = () => s.calls.filter((c) => scopeWrite(c as Call));
  const reads = () => s.calls.filter((c) => scopeRead(c as Call));
  /** The acceptance went on as it always did: the paperwork, then the job's two rules. */
  const acceptanceRan = () => {
    expect(rules.createWorkOrderFromQuote).toHaveBeenCalledWith("q1");
    expect(rules.createMaterialListFromQuote).toHaveBeenCalledWith("q1");
    expect(rules.syncJobTasks).toHaveBeenCalledTimes(1);
    expect(rules.syncJobMaterials).toHaveBeenCalledTimes(1);
  };

  it("NO DESCRIPTION YET (null): the job takes the estimate's, by a compare-and-set on null, pinned to the job's id and read back", async () => {
    s.answer = world({ job: { data: { description: null }, error: null } }) as never;
    const res = await createJobFromQuote("q1");
    expect(res).toMatchObject({ ok: true, id: "j1" });
    expect(reads()).toEqual([expect.objectContaining({ table: "jobs", select: "description", filters: [["eq", "id", "j1"]] })]);
    expect(writes()).toEqual([
      expect.objectContaining({ table: "jobs", verb: "update", payload: { description: SCOPE }, select: "id", filters: [["eq", "id", "j1"], ["is", "description", null]] }),
    ]);
    expect(scopeReports()).toEqual([]);
    acceptanceRan();
  });

  it.each([
    ["an empty string", ""],
    ["a space", " "],
    ["a line break and a tab", "\r\n\t"],
  ])("A BLANK DESCRIPTION (%s): the same, compared against the exact blank text that was read", async (_name, blank) => {
    s.answer = world({ job: { data: { description: blank }, error: null } }) as never;
    expect(await createJobFromQuote("q1")).toMatchObject({ ok: true, id: "j1" });
    expect(writes()).toEqual([expect.objectContaining({ payload: { description: SCOPE }, select: "id", filters: [["eq", "id", "j1"], ["eq", "description", blank]] })]);
    expect(scopeReports()).toEqual([]);
  });

  it.each([
    ["a scope somebody typed", "Rewire the garage. Owner supplies the fixtures."],
    ["the first estimate's scope, when a revision is accepted", "Replace the 100 A panel."],
    ["one character", "."],
    ["words with space around them", "  see the plans  "],
    ["a no-break space, which is not blank to the rule or to Postgres", " "],
  ])("WORDS A PERSON TYPED ARE NEVER REPLACED (%s): the job is read, and nothing is written to it", async (_name, own) => {
    s.answer = world({ job: { data: { description: own }, error: null } }) as never;
    expect(await createJobFromQuote("q1")).toMatchObject({ ok: true, id: "j1" });
    expect(reads()).toHaveLength(1);
    expect(writes()).toEqual([]);
    expect(scopeReports()).toEqual([]);
    acceptanceRan();
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["only blank space", "\n \t"],
  ])("an estimate with no words (%s) has nothing to give: the job is not even read", async (_name, description) => {
    s.answer = world({ description }) as never;
    expect(await createJobFromQuote("q1")).toMatchObject({ ok: true, id: "j1" });
    expect(reads()).toEqual([]);
    expect(writes()).toEqual([]);
    acceptanceRan();
  });

  it.each(["sent", "draft", "declined"])("ONLY AN ACCEPTED ESTIMATE: one that is %s and linked gets the old answer, and the job is not touched", async (status) => {
    s.answer = world({ status }) as never;
    expect(await createJobFromQuote("q1")).toEqual({ ok: true, id: "j1" });
    expect(s.calls.filter((c) => c.table === "jobs")).toEqual([]);
    expect(rules.createWorkOrderFromQuote).not.toHaveBeenCalled();
  });

  it("a supersede that failed stops before the fill, as it stops before everything else: accepting again does both", async () => {
    rules.supersedeRevised.mockImplementation(async () => ({ superseded: [], error: "the wire dropped" }));
    s.answer = world({}) as never;
    const res = await createJobFromQuote("q1");
    expect(res.ok).toBe(true);
    expect(res.note).toContain("the wire dropped");
    expect(s.calls.filter((c) => c.table === "jobs")).toEqual([]);
    // Accepted again, with the supersede landing: the fill runs.
    s.calls = [];
    rules.supersedeRevised.mockImplementation(async () => ({ superseded: [] }));
    await createJobFromQuote("q1");
    expect(writes()).toHaveLength(1);
  });

  it("the fill lands before the paperwork and the job's rules, so the page they revalidate reads the scope", async () => {
    const order: string[] = [];
    rules.createWorkOrderFromQuote.mockImplementationOnce(async () => (order.push("work order"), { ok: true }));
    rules.syncJobTasks.mockImplementationOnce(async () => (order.push("tasks"), { inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false, sizeNow: null }));
    const base = world({});
    s.answer = ((c: Call) => (scopeWrite(c) && order.push("scope"), base(c))) as never;
    await createJobFromQuote("q1");
    expect(order).toEqual(["scope", "work order", "tasks"]);
  });
});

describe("a fill that fails is reported and never fails the acceptance", () => {
  const world = (o: { job?: unknown; write?: unknown | (() => unknown); again?: unknown }) => (c: Call): unknown => {
    if (quoteRead(c)) return { data: { ...QUOTE, job_id: "j1", description: TYPED }, error: null };
    if (scopeRead(c)) return s.calls.filter((x) => scopeRead(x as Call)).length === 1 ? (o.job ?? { data: { description: null }, error: null }) : (o.again ?? { data: null, error: null });
    if (scopeWrite(c)) return typeof o.write === "function" ? (o.write as () => unknown)() : (o.write ?? { data: [{ id: "j1" }], error: null });
    return { data: null, error: null };
  };
  const writes = () => s.calls.filter((c) => scopeWrite(c as Call));
  const boom = () => {
    throw new Error("socket hang up");
  };
  /** The acceptance answered as it would have with no fill at all, and went on to the paperwork and the follow. */
  const accepted = (res: { ok: boolean; id?: string; error?: string }) => {
    expect(res.ok).toBe(true);
    expect(res.id).toBe("j1");
    expect(res.error).toBeUndefined();
    expect(rules.createWorkOrderFromQuote).toHaveBeenCalledWith("q1");
    expect(rules.createMaterialListFromQuote).toHaveBeenCalledWith("q1");
    expect(rules.syncJobTasks).toHaveBeenCalledTimes(1);
  };

  it.each([
    ["the job's Description cannot be read", { job: { data: null, error: { message: "jobs read failed" } } }, 0, "jobs read failed"],
    ["the job is not there to read", { job: { data: null, error: null } }, 0, "the job could not be read"],
    ["the read throws", { job: boom }, 0, "socket hang up"],
    ["the write is refused", { write: { data: null, error: { message: "permission denied for table jobs" } } }, 1, "permission denied for table jobs"],
    ["the write throws", { write: boom }, 1, "socket hang up"],
    ["the write lands on no row and the job is still empty", { write: { data: [], error: null }, again: { data: { description: null }, error: null } }, 1, "zero rows"],
    ["the write lands on no row and the job cannot be read again", { write: { data: [], error: null }, again: { data: null, error: { message: "jobs read failed" } } }, 1, "jobs read failed"],
    ["the write lands on no row and the job is gone", { write: { data: [], error: null }, again: { data: null, error: null } }, 1, "zero rows"],
  ] as const)("%s: filed once, with the two ids and nothing else, and the estimate is still accepted onto its job", async (_name, o, wrote, why) => {
    const base = world(o as never);
    s.answer = ((c: Call) => {
      const a = base(c);
      return typeof a === "function" ? (a as () => unknown)() : a;
    }) as never;
    accepted(await createJobFromQuote("q1"));
    expect(writes()).toHaveLength(wrote);
    const filed = scopeReports();
    expect(filed).toHaveLength(1);
    expect(filed[0].extra).toEqual({ jobId: "j1", quoteId: "q1" });
    expect(String((filed[0].error as { message?: string })?.message ?? filed[0].error)).toContain(why);
    // The estimate's words are the customer's business: none of them rides in the report.
    expect(JSON.stringify(filed[0].extra)).not.toContain("panel");
  });

  it("ZERO ROWS BECAUSE SOMEBODY TYPED A SCOPE IN THAT MOMENT is not a failure: their words stand, nothing is written again, nothing is filed", async () => {
    s.answer = world({ write: { data: [], error: null }, again: { data: { description: "Rewire the garage." }, error: null } }) as never;
    accepted(await createJobFromQuote("q1"));
    expect(writes()).toHaveLength(1);
    // The one write was the compare-and-set on the empty value: it could not have landed on their words.
    expect(writes()[0].filters).toEqual([["eq", "id", "j1"], ["is", "description", null]]);
    expect(scopeReports()).toEqual([]);
  });
});

describe("the door in the source", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/actions.ts"), "utf8");
  const create = src.slice(src.indexOf("export async function createJobFromQuote("), src.indexOf("async function pushQuoteAccepted("));

  it("the rule is the one file's: this door imports it and trims nothing itself", () => {
    expect(src).toContain('import { jobTakesScope, scopeForJob } from "@/lib/estimate/job-scope";');
    expect(create).toContain("const bornScope = scopeForJob((q as { description?: unknown }).description);");
    expect(create).toContain("...(bornScope ? { description: bornScope } : {}),");
    expect(create).not.toMatch(/description[^\n]*\.trim\(/);
  });

  it("the fill is called once, in the branch that makes an existing job catch up, after the supersede and before the paperwork", () => {
    const call = "await jobTakesEstimateScope(supabase, { jobId: q.job_id, quoteId, estimateDescription: (q as { description?: unknown }).description });";
    expect(create.split("jobTakesEstimateScope(").length - 1).toBe(1);
    const linked = create.indexOf("if (q.job_id) {");
    const at = create.indexOf(call);
    expect(at).toBeGreaterThan(linked);
    expect(at).toBeGreaterThan(create.indexOf('status !== "accepted") return { ok: true, id: q.job_id }'));
    expect(at).toBeGreaterThan(create.indexOf('ws.say("qs_supersedeFailed"'));
    expect(at).toBeLessThan(create.indexOf("createWorkOrderFromQuote(quoteId)"));
    expect(at).toBeLessThan(create.indexOf('.from("jobs")'));
  });

  it("the fill is not a server action of its own: a 'use server' file exports only its doors", () => {
    expect(src).toContain("\nasync function jobTakesEstimateScope(");
    expect(src).not.toContain("export async function jobTakesEstimateScope(");
    const fill = src.slice(src.indexOf("\nasync function jobTakesEstimateScope("), src.indexOf("export async function createJobFromQuote("));
    // Read, compare-and-set, read back: the silent-write law.
    expect(fill).toContain('.from("jobs").select("description").eq("id", of.jobId).maybeSingle()');
    expect(fill).toContain('.from("jobs").update({ description: scope }).eq("id", of.jobId)');
    expect(fill).toContain('(had === null ? fill.is("description", null) : fill.eq("description", had)).select("id")');
    expect(fill).toContain("if (!jobTakesScope(had)) return;");
  });
});
