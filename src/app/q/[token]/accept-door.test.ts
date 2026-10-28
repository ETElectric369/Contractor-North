import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE CUSTOMER'S ACCEPT, IN ONE SERVER CALL (cn-v1133). The button used to run accept_public_quote
 * from the customer's browser and fire the finish without waiting: a closed tab left a job with no
 * tasks, no work order and no list. Now acceptPublicQuote runs the RPC through the token page's own
 * client, AWAITS the finish (the same rules as the office's accept, with the service client and the
 * company's id, and — parity — the visit behind the estimate closed as won), then rings the office.
 * Driven against a recording fake: what each piece was handed, and in what order, is the point.
 */
type Call = { via: "anon" | "service"; table: string; verb: "select" | "rpc"; payload?: unknown; select?: string; filters: unknown[][] };
const s = vi.hoisted(() => ({
  calls: [] as Call[],
  events: [] as string[],
  rpc: null as null | (() => unknown),
  quote: null as null | Record<string, unknown>,
}));

function fakeClient(via: "anon" | "service") {
  const builder = (table: string) => {
    const c: Call = { via, table, verb: "select", filters: [] };
    const run = () => {
      s.calls.push(c);
      // The two reads by token (the finish's, the bell's) answer the one quote; anything else is empty.
      if (table === "quotes" && c.filters.some((f) => f[0] === "eq" && f[1] === "public_token")) return { data: s.quote, error: null };
      return { data: null, error: null };
    };
    const b: any = {
      select: (cols?: string) => ((c.select = cols), b),
      maybeSingle: async () => run(),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, err),
    };
    for (const m of ["eq", "in", "is", "or", "order", "limit"]) b[m] = (...a: unknown[]) => (c.filters.push([m, ...a]), b);
    return b;
  };
  return {
    from: builder,
    rpc: async (fn: string, args: unknown) => {
      s.calls.push({ via, table: fn, verb: "rpc", payload: args, filters: [] });
      s.events.push(`rpc:${via}`);
      return s.rpc?.() ?? { data: { ok: true }, error: null };
    },
  };
}
const anon = fakeClient("anon");
const service = fakeClient("service");
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => anon), createServiceClient: vi.fn(() => service) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sink = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: sink.reportError }));

// Each rule behind the door is its own suite's; here each records that it ran, in order, with what it was handed.
const rules = vi.hoisted(() => ({
  estimateLines: vi.fn(async () => (s.events.push("estimateLines"), { lines: [], minutes: 120, taskMinutes: new Map([["line:l1", 120]]), partCounts: new Map([["line:l1#R1", 2]]) })),
  syncJobTasks: vi.fn(async () => (s.events.push("syncTasks"), { inserted: 1, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false })),
  syncJobMaterials: vi.fn(async () => (s.events.push("syncMaterials"), { inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] })),
  supersedeRevised: vi.fn(async () => (s.events.push("supersede"), { superseded: [] })),
  workOrderFromQuote: vi.fn(async () => (s.events.push("workOrder"), { ok: true })),
  takeOffFromQuote: vi.fn(async () => (s.events.push("takeOff"), { ok: true, id: "ml-1", adopted: true, follow: { added: 1, carried: 0, recounted: [], removed: [], kept: [], countsDiffer: [], failed: [] } })),
  closeVisitsBehindQuote: vi.fn(async () => (s.events.push("closeVisits"), { attached: 1, stamped: 1 })),
  createNotifications: vi.fn(async () => (s.events.push("bell"), undefined)),
  sendPushToProfiles: vi.fn(async () => (s.events.push("push"), undefined)),
  orgStaffIds: vi.fn(async () => ["u1"]),
}));
vi.mock("@/lib/estimate/sync-job-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), estimateLines: rules.estimateLines, syncJobTasks: rules.syncJobTasks }));
vi.mock("@/lib/estimate/sync-job-materials", async (importOriginal) => ({ ...(await importOriginal<object>()), syncJobMaterials: rules.syncJobMaterials }));
vi.mock("@/lib/estimate/revision", async (importOriginal) => ({ ...(await importOriginal<object>()), supersedeRevised: rules.supersedeRevised }));
vi.mock("@/lib/estimate/work-order-from-quote", async (importOriginal) => ({ ...(await importOriginal<object>()), workOrderFromQuote: rules.workOrderFromQuote }));
vi.mock("@/lib/estimate/take-off-from-quote", async (importOriginal) => ({ ...(await importOriginal<object>()), takeOffFromQuote: rules.takeOffFromQuote }));
vi.mock("@/lib/appointments/behind-quote", async (importOriginal) => ({ ...(await importOriginal<object>()), closeVisitsBehindQuote: rules.closeVisitsBehindQuote }));
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<object>()), createNotifications: rules.createNotifications }));
vi.mock("@/lib/push", async (importOriginal) => ({ ...(await importOriginal<object>()), sendPushToProfiles: rules.sendPushToProfiles, orgStaffIds: rules.orgStaffIds }));

const { acceptPublicQuote } = await import("./actions");

const ACCEPTED = () => ({
  id: "q1", quote_number: "E-001", status: "accepted", org_id: "org-1", job_id: "j1", created_by: "u1",
  accepted_at: new Date().toISOString(), inquiry_id: "i1", revises_quote_id: "q0", customers: { name: "Larkspur" },
});

beforeEach(() => {
  s.calls = [];
  s.events = [];
  s.rpc = null;
  s.quote = ACCEPTED();
  for (const spy of Object.values(rules)) spy.mockClear();
  sink.reportError.mockClear();
});

describe("acceptPublicQuote", () => {
  it("runs the RPC through the token page's client, then the finish with the service client and the company's id, then the bell — in that order", async () => {
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: true });
    expect(s.events).toEqual(["rpc:anon", "estimateLines", "supersede", "syncTasks", "workOrder", "takeOff", "syncMaterials", "closeVisits", "bell", "push"]);
    const rpc = s.calls.find((c) => c.verb === "rpc")!;
    expect(rpc).toMatchObject({ via: "anon", table: "accept_public_quote", payload: { p_token: "tok-1" } });
    // The finish reads the quote by its token with the service client, naming the two links the visit closer needs.
    const read = s.calls.find((c) => c.via === "service" && c.table === "quotes" && c.verb === "select")!;
    expect(read.select).toBe("id, status, org_id, job_id, created_by, accepted_at, inquiry_id, revises_quote_id");
    expect(read.filters).toEqual([["eq", "public_token", "tok-1"]]);
    // Each rule is handed the service client and the company's id; the figure before is the job's OTHER accepted estimates'.
    expect(rules.estimateLines).toHaveBeenCalledWith(service, { jobId: "j1", orgId: "org-1", except: "q1" });
    expect(rules.supersedeRevised).toHaveBeenCalledWith(service, { revisionId: "q1", orgId: "org-1" });
    expect(rules.syncJobTasks).toHaveBeenCalledWith(service, { jobId: "j1", orgId: "org-1", createdBy: "u1", sizeBefore: 120, tasksBefore: new Map([["line:l1", 120]]) });
    expect(rules.workOrderFromQuote).toHaveBeenCalledWith(service, { quoteId: "q1", orgId: "org-1", userId: "u1" });
    expect(rules.takeOffFromQuote).toHaveBeenCalledWith(service, { quoteId: "q1", orgId: "org-1", userId: "u1" });
    expect(rules.syncJobMaterials).toHaveBeenCalledWith(service, { jobId: "j1", orgId: "org-1", userId: "u1", partsBefore: new Map([["line:l1#R1", 2]]) });
    // PARITY with the office door: the visit behind the estimate — by the lead, the job and the estimate it revises — is won.
    // The service client is not fenced by RLS, so the company's id scopes the visit closer's read and writes (S6).
    expect(rules.closeVisitsBehindQuote).toHaveBeenCalledWith(service, { id: "q1", inquiry_id: "i1", job_id: "j1", revises_quote_id: "q0" }, { jobId: "j1", outcome: "won", orgId: "org-1" });
    // The office hears what the list did, deep-linked to the job.
    expect(rules.createNotifications).toHaveBeenCalledWith("org-1", ["u1"], {
      type: "quote_accepted",
      title: "Estimate accepted",
      body: "E-001 was accepted from Larkspur — schedule the job. The crew's list is this estimate's now: 1 line added.",
      url: "/jobs/j1",
    });
    expect(sink.reportError).not.toHaveBeenCalled();
  });

  it("the RPC's refusal is the button's own words, and nothing follows it; a transport error keeps its message; no answer at all is the plain sentence", async () => {
    s.rpc = () => ({ data: { ok: false, error: "This quote is no longer available to accept." }, error: null });
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: false, error: "This quote is no longer available to accept." });
    expect(s.events).toEqual(["rpc:anon"]);
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
    expect(rules.createNotifications).not.toHaveBeenCalled();
    s.events = [];
    s.rpc = () => ({ data: null, error: { message: "the wire dropped" } });
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: false, error: "the wire dropped" });
    s.rpc = () => ({ data: null, error: null });
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: false, error: "Could not accept. Please try again." });
    expect(await acceptPublicQuote("")).toEqual({ ok: false, error: "Could not accept. Please try again." });
    expect(s.calls.filter((c) => c.verb === "rpc")).toHaveLength(3); // the empty token never reaches the database
  });

  it("the acceptance is committed by the RPC whatever follows: a finish that fails is filed, the customer still sees accepted, and the office is still rung", async () => {
    rules.syncJobTasks.mockImplementationOnce(async () => { s.events.push("syncTasks"); throw new Error("the task list is locked"); });
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: true });
    expect(sink.reportError).toHaveBeenCalledWith("finishPublicAcceptance", expect.objectContaining({ message: "the task list is locked" }));
    expect(s.events).toEqual(["rpc:anon", "estimateLines", "supersede", "syncTasks", "bell", "push"]);
    // A piece that REFUSES (no throw) is filed by name and the rest still run.
    s.events = [];
    sink.reportError.mockClear();
    rules.workOrderFromQuote.mockImplementationOnce(async () => (s.events.push("workOrder"), { ok: false, error: "no work order today" }) as never);
    rules.closeVisitsBehindQuote.mockImplementationOnce(async () => (s.events.push("closeVisits"), { attached: 0, stamped: 0, error: "visits unreadable" }) as never);
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: true });
    expect(sink.reportError).toHaveBeenCalledWith("finishPublicAcceptance:workOrder", expect.objectContaining({ message: "no work order today" }), { quoteId: "q1", jobId: "j1" });
    expect(sink.reportError).toHaveBeenCalledWith("finishPublicAcceptance:visits", expect.objectContaining({ message: "visits unreadable" }), { quoteId: "q1", jobId: "j1" });
    expect(s.events).toEqual(["rpc:anon", "estimateLines", "supersede", "syncTasks", "workOrder", "takeOff", "syncMaterials", "closeVisits", "bell", "push"]);
  });

  it("what the list did on the link reaches the bell's body in the office door's own words (S5): a rebuilt estimate's re-counted or renamed row is said, never silent", async () => {
    rules.syncJobMaterials.mockImplementationOnce(
      async () =>
        (s.events.push("syncMaterials"),
        { inserted: 0, rekeyed: 1, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [], moved: ["Transfer switch, 200A"], renamed: ["Bayberry clips"] }) as never,
    );
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: true });
    expect(rules.createNotifications).toHaveBeenCalledWith(
      "org-1",
      ["u1"],
      expect.objectContaining({
        body: "E-001 was accepted from Larkspur — schedule the job. The crew's list is this estimate's now: 1 line added. The estimate's materials list follows too: 1 matched · 1 re-counted (Transfer switch, 200A) · 1 renamed (Bayberry clips).",
      }),
    );
    // A sync that changed nothing adds no words (the first test's body); one that failed is filed, not said.
    s.events = [];
    rules.createNotifications.mockClear();
    rules.syncJobMaterials.mockImplementationOnce(async () => (s.events.push("syncMaterials"), { inserted: 0, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [], error: "the list is locked" }) as never);
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: true });
    expect(sink.reportError).toHaveBeenCalledWith("finishPublicAcceptance:materialsSync", expect.objectContaining({ message: "the list is locked" }), { quoteId: "q1", jobId: "j1" });
    expect(rules.createNotifications).toHaveBeenCalledWith("org-1", ["u1"], expect.objectContaining({ body: "E-001 was accepted from Larkspur — schedule the job. The crew's list is this estimate's now: 1 line added." }));
  });

  it("the module's only export is acceptPublicQuote (S4): the bell is not a server action anyone holding the link could POST to re-ring", async () => {
    const mod = await import("./actions");
    expect(Object.keys(mod).sort()).toEqual(["acceptPublicQuote"]);
  });

  it("the token page gives the tap the time it needs (S3): maxDuration beside the route's dynamic segment config, since a server action runs under its route's limit", () => {
    const page = readFileSync(join(process.cwd(), "src/app/q/[token]/page.tsx"), "utf8");
    expect(page).toContain('export const dynamic = "force-dynamic";');
    expect(page).toContain("export const maxDuration = 60;");
    expect(page.indexOf("export const maxDuration = 60;")).toBeGreaterThan(page.indexOf('export const dynamic = "force-dynamic";'));
  });

  it("0396 (the RPC the tap runs): the customer's address is the site's third fallback, and the new job's link is compare-and-set with the losing door's empty job removed — the customer-door half of the two-doors race (B5)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0396_the_customers_address_on_the_public_accept.sql"), "utf8");
    expect(sql).toContain("elsif cust.id is not null and coalesce(cust.address, '') <> '' then");
    expect(sql).toContain(
      "update public.quotes set job_id = new_job where id = q.id and job_id is null;\n    if not found then\n      select job_id into q.job_id from public.quotes where id = q.id;\n      delete from public.jobs where id = new_job and org_id = q.org_id;\n    end if;",
    );
    expect(sql).not.toMatch(/set job_id = new_job where id = q\.id;/); // no unguarded link left
    expect(sql).toContain("< 2 then"); // the self-check counts the guard twice: the revision pin's and the new job's
  });

  it("a quote the finish must not touch (no job yet, or accepted too long ago) finishes nothing — and the bell's own guard holds — but the tap still answers ok", async () => {
    s.quote = { ...ACCEPTED(), job_id: null };
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: true });
    expect(s.events).toEqual(["rpc:anon", "bell", "push"]); // the bell deep-links to /quotes when there is no job
    expect(rules.createNotifications).toHaveBeenCalledWith("org-1", ["u1"], expect.objectContaining({ url: "/quotes" }));
    s.events = [];
    s.quote = { ...ACCEPTED(), accepted_at: "2026-01-01T00:00:00Z" };
    expect(await acceptPublicQuote("tok-1")).toEqual({ ok: true });
    expect(s.events).toEqual(["rpc:anon"]); // past the finishing window: nothing re-made, nobody rung
  });
});
