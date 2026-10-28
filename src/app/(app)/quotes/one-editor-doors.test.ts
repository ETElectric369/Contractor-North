import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ONE ESTIMATE EDITOR'S SERVER DOORS (cn-v1132), driven against a recording fake client — the
 * Part 1 lesson: a green source-text pin proved nothing, so every door here is CALLED and what it wrote
 * is read back off the recording.
 *
 *   appendQuoteLines    one insert for the batch, each line under the id the editor chose (B2): sort_order
 *                       continues after the estimate's last line, the group lands as category and the task
 *                       as detail (coerced); the primary key taken is a batch that LANDED (re-read, ids
 *                       handed back) unless a row is not this estimate's; an empty list, a blank line, a
 *                       line with no usable id, a locked estimate and a short insert are refused in words.
 *   updateQuoteItem     the patch's two new keys: null clears, undefined leaves the column alone, a junk
 *                       breakdown is refused; zero rows is a refusal (silent-write law); a figure change
 *                       (the breakdown, the count, the price) on an accepted, job-linked estimate reads the
 *                       job's figure BEFORE the write and runs the job's two rules after it (S5).
 *   deleteQuoteItem     zero rows is the one sentence the editor reads as "already gone" (LINE_GONE).
 *   saveQuote           idempotent by the client's id: the same id twice is one insert and one update;
 *                       a foreign company's id is "Quote not found."; a twin save in flight converges on
 *                       the one row; a standing non-draft is refused before the RPC is asked.
 *   readQuoteForEditor  staff only (0056 keeps quote reads staff-only); named columns on both reads
 *                       (projection law), scoped to the company; detail coerced, the money as numbers;
 *                       not found and a failed read are said.
 *   readQuoteLineIds    the lean read-back after birth: ids and their order, nothing else.
 */
type Call = { table: string; verb: "select" | "insert" | "update" | "delete" | "rpc"; payload?: unknown; select?: string; filters: unknown[][] };
const s = vi.hoisted(() => ({ calls: [] as Call[], answer: null as null | ((c: Call) => unknown) }));

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
    then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => (s.calls.push(c), Promise.resolve(run()).then(ok, err)),
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
// Every door here is the OFFICE's: the quotes table is staff-only under RLS (0056), so the editor's
// reads gate on requireStaff too — a member gate would only ever hand a tech "Quote not found."
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", async (importOriginal) => ({ ...(await importOriginal<object>()), bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
// THE JOB'S TWO RULES, as spies (their own suites drive them): what this door hands them is the point.
const rules = vi.hoisted(() => ({
  estimateLines: vi.fn(async () => ({ lines: [], minutes: 120, taskMinutes: new Map([["line:l1", 120]]), partCounts: new Map([["line:l1#JH-1", 4]]) })),
  syncJobTasks: vi.fn(async () => ({ inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 1, keptNames: [], leftOff: [], twice: [], sizeSet: true, sizeNow: 180 })),
  syncJobMaterials: vi.fn(async () => ({ inserted: 1, rekeyed: 0, removed: 0, removedNames: [], kept: 0, keptNames: [], leftOff: [], countsDiffer: [] })),
  // The birth and the paperwork doors behind createJobFromQuote (their own suites drive them): what this door does around them is the point.
  bornWithTasks: vi.fn(async () => ({ inserted: 1, plannedSet: true, birth: { tasks: [], plannedMinutes: null, parts: [] } })),
  createWorkOrderFromQuote: vi.fn(async () => ({ ok: true })),
  createMaterialListFromQuote: vi.fn(async () => ({ ok: true })),
  supersedeRevised: vi.fn(async () => ({ superseded: [] })),
}));
vi.mock("@/lib/estimate/sync-job-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), estimateLines: rules.estimateLines, syncJobTasks: rules.syncJobTasks }));
vi.mock("@/lib/estimate/sync-job-materials", async (importOriginal) => ({ ...(await importOriginal<object>()), syncJobMaterials: rules.syncJobMaterials }));
vi.mock("@/lib/estimate/born-with-tasks", async (importOriginal) => ({ ...(await importOriginal<object>()), bornWithTasks: rules.bornWithTasks }));
vi.mock("@/lib/estimate/revision", async (importOriginal) => ({ ...(await importOriginal<object>()), supersedeRevised: rules.supersedeRevised }));
vi.mock("@/app/(app)/work-orders/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createWorkOrderFromQuote: rules.createWorkOrderFromQuote }));
vi.mock("@/app/(app)/materials/actions", async (importOriginal) => ({ ...(await importOriginal<object>()), createMaterialListFromQuote: rules.createMaterialListFromQuote }));

const { appendQuoteLines, updateQuoteItem, deleteQuoteItem, saveQuote, readQuoteForEditor, readQuoteLineIds, createJobFromQuote } = await import("./actions");
const { LINE_GONE } = await import("./use-quote-writes");

const gate = (c: Call) => c.table === "quotes" && c.verb === "select" && c.select === "status, job_id, quote_number, doc_type";
const lastLine = (c: Call) => c.table === "quote_line_items" && c.verb === "select" && c.select === "sort_order";
const lineInsert = (c: Call) => c.table === "quote_line_items" && c.verb === "insert";
const lineUpdate = (c: Call) => c.table === "quote_line_items" && c.verb === "update";
const quoteInsert = (c: Call) => c.table === "quotes" && c.verb === "insert";
const standingRead = (c: Call) => c.table === "quotes" && c.verb === "select" && c.select === "id, status, inquiry_id";
const draftRpc = (c: Call) => c.verb === "rpc" && c.table === "save_quote_draft";
const totalsWrite = (c: Call) => c.table === "quotes" && c.verb === "update" && "subtotal" in (c.payload as object);

/** The reads every door makes on the way (the gate, recalcQuote), answered plainly: a draft, no lines yet. */
const base = (c: Call): unknown => {
  if (gate(c)) return { data: { status: "draft", job_id: null, quote_number: "E-001", doc_type: "estimate" }, error: null };
  if (lastLine(c)) return { data: { sort_order: 4 }, error: null };
  if (lineInsert(c)) return { data: (c.payload as unknown[]).map((_, i) => ({ id: `l-${i + 1}` })), error: null };
  if (lineUpdate(c)) return { data: [{ id: "l1" }], error: null };
  if (c.table === "quotes" && c.verb === "select" && c.select === "tax_rate") return { data: { tax_rate: 0 }, error: null };
  if (c.table === "quote_line_items" && c.verb === "select") return { data: [], error: null };
  if (c.table === "quotes" && c.verb === "update") return { data: [{ id: "q1" }], error: null };
  if (quoteInsert(c)) return { data: { id: (c.payload as { id?: string }).id ?? "q-new", quote_number: "E-010" }, error: null };
  if (draftRpc(c)) return { data: [{ id: (c.payload as { p_id: string }).p_id, quote_number: "E-001" }], error: null };
  return { data: null, error: null };
};

/** A task line's breakdown as the builder sends it (one labor row, one part) and as the row stores it. */
const DETAIL = {
  task_id: "t-footings",
  labor: [{ label: null, person_id: null, hours: 2, rate: 135, rate_from: "rule" as const }],
  units: null,
  kit_id: null,
  materials: [{ code: "JH-1", name: "Joist hanger", qty: 4, cost: 1.5, sell: 2 }],
};
// The ids the editor chose (crypto.randomUUID on the phone; fixed here).
const A = "a0000000-0000-4000-8000-000000000001";
const B = "a0000000-0000-4000-8000-000000000002";
const plain = { id: A, description: "Trench", quantity: 1, unit: "ea", unit_price: 290 };
const task = { id: B, description: "Footings", quantity: 1, unit: "ea", unit_price: 278, group: "Decking", detail: DETAIL };

beforeEach(() => {
  s.calls = [];
  s.answer = base;
  for (const spy of Object.values(rules)) spy.mockClear();
});

/** The figure every rule-running door hands the two rules (jobFollows): whole, per task line, per part. */
const FIGURE = { sizeBefore: 120, tasksBefore: new Map([["line:l1", 120]]), partsBefore: new Map([["line:l1#JH-1", 4]]) };

describe("appendQuoteLines", () => {
  it("one insert for the batch under the editor's ids: sort_order continues after the last line, the group and the task land, ids in the lines' order, then a recalc", async () => {
    const res = await appendQuoteLines("q1", [plain, task]);
    expect(res).toEqual({ ok: true, ids: [A, B] });
    const ins = s.calls.filter(lineInsert);
    expect(ins).toHaveLength(1);
    expect(ins[0].select).toBe("id");
    expect(ins[0].payload).toEqual([
      { id: A, quote_id: "q1", description: "Trench", quantity: 1, unit: "ea", unit_price: 290, sort_order: 5, category: null, detail: null },
      { id: B, quote_id: "q1", description: "Footings", quantity: 1, unit: "ea", unit_price: 278, sort_order: 6, category: "Decking", detail: DETAIL },
    ]);
    // The last line was asked for, newest first, before the insert; the totals were rewritten after it.
    const last = s.calls.findIndex(lastLine);
    expect(last).toBeGreaterThan(-1);
    expect(s.calls[last].filters).toEqual([["eq", "quote_id", "q1"], ["order", "sort_order", { ascending: false }], ["limit", 1]]);
    expect(s.calls.findIndex(totalsWrite)).toBeGreaterThan(s.calls.findIndex(lineInsert));
  });

  it("the first line of an empty estimate starts at 0; a breakdown is coerced on the way in (an unnamed part is dropped, a bad rate_from reads as legacy)", async () => {
    s.answer = (c) => (lastLine(c) ? { data: null, error: null } : base(c));
    const messy = { ...task, detail: { ...DETAIL, labor: [{ hours: "2", rate: "135", rate_from: "guess" }], materials: [...DETAIL.materials, { code: null, name: "", qty: 1, cost: 0, sell: 0 }] } };
    expect((await appendQuoteLines("q1", [messy as never])).ok).toBe(true);
    const [row] = s.calls.find(lineInsert)!.payload as { sort_order: number; detail: typeof DETAIL }[];
    expect(row.sort_order).toBe(0);
    expect(row.detail.labor).toEqual([{ label: null, person_id: null, hours: 2, rate: 135, rate_from: "legacy" }]);
    expect(row.detail.materials).toEqual(DETAIL.materials);
  });

  it("an empty list, a blank line, a line with no usable id and two lines under one id are refused in words, before any read", async () => {
    expect(await appendQuoteLines("q1", [])).toEqual({ ok: false, error: "There are no lines to add." });
    expect(await appendQuoteLines("q1", [plain, { ...plain, id: B, description: "   " }])).toEqual({ ok: false, error: "Line 2 has no description." });
    expect(await appendQuoteLines("q1", [plain, { ...task, id: "not-an-id" }])).toEqual({ ok: false, error: "Line 2 has no id to save under — reload the estimate and try again." });
    expect(await appendQuoteLines("q1", [plain, { ...task, id: "" as string }])).toEqual({ ok: false, error: "Line 2 has no id to save under — reload the estimate and try again." });
    expect(await appendQuoteLines("q1", [plain, { ...task, id: A.toUpperCase() }])).toEqual({ ok: false, error: "Two of those lines carry the same id — reload the estimate and try again." });
    expect(s.calls).toEqual([]);
  });

  it("the primary key taken is this estimate's rows already there (an earlier try's lost answer): each row is UPDATED from the batch — never sort_order, never an upsert — scoped and read back, the ids handed back, the totals rewritten; a row that is not this estimate's is a refusal", async () => {
    const taken = { code: "23505", message: 'duplicate key value violates unique constraint "quote_line_items_pkey"' };
    const reRead = (c: Call) => c.table === "quote_line_items" && c.verb === "select" && c.select === "id" && c.filters.some((f) => f[0] === "in");
    s.answer = (c) => (lineInsert(c) ? { data: null, error: taken } : reRead(c) ? { data: [{ id: A }, { id: B }], error: null } : base(c));
    // The retry carries NEWER words than the first landing (skeptic #37, B1): they must reach the row.
    expect(await appendQuoteLines("q1", [{ ...plain, description: "Trench, deeper", unit_price: 310 }, task])).toEqual({ ok: true, ids: [A, B] });
    const read = s.calls.find(reRead)!;
    expect(read.filters).toEqual([["eq", "quote_id", "q1"], ["in", "id", [A, B]]]);
    const rewrites = s.calls.filter(lineUpdate);
    expect(rewrites).toHaveLength(2);
    expect(rewrites[0]).toMatchObject({ payload: { description: "Trench, deeper", quantity: 1, unit: "ea", unit_price: 310, category: null, detail: null }, select: "id", filters: [["eq", "quote_id", "q1"], ["eq", "id", A]] });
    expect(rewrites[1]).toMatchObject({ payload: { description: "Footings", quantity: 1, unit: "ea", unit_price: 278, category: "Decking", detail: DETAIL }, filters: [["eq", "quote_id", "q1"], ["eq", "id", B]] });
    for (const w of rewrites) expect(w.payload).not.toHaveProperty("sort_order");
    expect(s.calls.findIndex(totalsWrite)).toBeGreaterThan(s.calls.findIndex(lineUpdate));
    // One of the ids belongs to a row this estimate does not hold: nothing landed here, nothing rewritten, said.
    s.calls = [];
    s.answer = (c) => (lineInsert(c) ? { data: null, error: taken } : reRead(c) ? { data: [{ id: A }], error: null } : base(c));
    expect(await appendQuoteLines("q1", [plain, task])).toEqual({ ok: false, error: "Those lines didn't save — one of their ids is already taken. Reload the estimate and try again." });
    expect(s.calls.filter(lineUpdate)).toEqual([]);
    expect(s.calls.filter(totalsWrite)).toEqual([]);
    // Both ids are ours but a rewrite lands on zero rows (moved meanwhile): the same refusal, no totals.
    s.calls = [];
    s.answer = (c) => (lineInsert(c) ? { data: null, error: taken } : reRead(c) ? { data: [{ id: A }, { id: B }], error: null } : lineUpdate(c) ? { data: [], error: null } : base(c));
    expect(await appendQuoteLines("q1", [plain, task])).toEqual({ ok: false, error: "Those lines didn't save — one of their ids is already taken. Reload the estimate and try again." });
    expect(s.calls.filter(totalsWrite)).toEqual([]);
    // Any other unique-key refusal keeps dbError's words.
    s.answer = (c) => (lineInsert(c) ? { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "something_else"' } } : base(c));
    const other = await appendQuoteLines("q1", [plain]);
    expect(other.ok).toBe(false);
    expect((other as { error: string }).error).not.toContain("already taken");
  });

  it("on an ACCEPTED, job-linked estimate the job follows (cn-v1133): the figure is read BEFORE the insert, the two rules run after it, and their words ride back with the ids", async () => {
    const behind = (c: Call) => c.table === "quotes" && c.verb === "select" && c.select === "job_id, status";
    s.answer = (c) => {
      if (gate(c)) return { data: { status: "accepted", job_id: "j1", quote_number: "E-001", doc_type: "estimate" }, error: null };
      if (behind(c)) return { data: { job_id: "j1", status: "accepted" }, error: null };
      if (c.table === "contracts" || c.table === "payment_milestones") return { data: null, error: null };
      return base(c);
    };
    const res = await appendQuoteLines("q1", [task]);
    expect(res).toEqual({ ok: true, ids: [B], said: "The job's list follows the estimate: 1 task's hours updated · the job's length is now 3 h. The estimate's materials list follows too: 1 part added." });
    expect(s.calls.findIndex(behind)).toBeLessThan(s.calls.findIndex(lineInsert));
    expect(rules.estimateLines).toHaveBeenCalledWith(client, { jobId: "j1", orgId: "org-1" });
    expect(rules.syncJobTasks).toHaveBeenCalledWith(client, { jobId: "j1", orgId: "org-1", createdBy: "office-1", sizeBefore: 120, tasksBefore: FIGURE.tasksBefore });
    expect(rules.syncJobMaterials).toHaveBeenCalledWith(client, { jobId: "j1", orgId: "org-1", userId: "office-1", partsBefore: FIGURE.partsBefore });
    expect(rules.syncJobTasks.mock.invocationCallOrder[0]).toBeGreaterThan(rules.estimateLines.mock.invocationCallOrder[0]);
    // A draft runs nothing and says nothing: the shape the editor codes against is unchanged.
    s.calls = [];
    rules.syncJobTasks.mockClear();
    s.answer = base;
    expect(await appendQuoteLines("q1", [task])).toEqual({ ok: true, ids: [B] });
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
  });

  it("a short insert is refused in words and the totals are left alone", async () => {
    s.answer = (c) => (lineInsert(c) ? { data: [{ id: "l-1" }], error: null } : base(c));
    expect(await appendQuoteLines("q1", [plain, task])).toEqual({ ok: false, error: "Only 1 of 2 lines saved. Reload the estimate to see what landed." });
    s.answer = (c) => (lineInsert(c) ? { data: [], error: null } : base(c));
    expect(await appendQuoteLines("q1", [plain])).toEqual({ ok: false, error: "Those lines didn't save. Reload the estimate and try again." });
    expect(s.calls.filter(totalsWrite)).toEqual([]);
  });

  it("a failed last-line read is said (the new lines would otherwise land at the top)", async () => {
    s.answer = (c) => (lastLine(c) ? { data: null, error: { code: "XX000", message: "the reader tripped" } } : base(c));
    expect(await appendQuoteLines("q1", [plain])).toEqual({ ok: false, error: "the reader tripped" });
    expect(s.calls.filter(lineInsert)).toEqual([]);
  });

  it("the gate refuses a superseded estimate, and an accepted one priced into a signed contract, in its own words; nothing is written", async () => {
    s.answer = (c) => {
      if (gate(c)) return { data: { status: "superseded", job_id: null, quote_number: "E-001", doc_type: "estimate" }, error: null };
      if (c.table === "quotes" && c.verb === "select" && c.select?.includes("accepted_at")) return { data: { id: "q2", quote_number: "E-002", accepted_at: "2026-10-20", status: "accepted" }, error: null };
      return base(c);
    };
    expect(await appendQuoteLines("q1", [plain])).toEqual({ ok: false, error: "E-001 is superseded by E-002 — edit that one instead." });
    s.answer = (c) => {
      if (gate(c)) return { data: { status: "accepted", job_id: "j1", quote_number: "E-001", doc_type: "estimate" }, error: null };
      if (c.table === "contracts") return { data: { contract_number: "C-001", signed_at: "2026-10-21" }, error: null };
      return base(c);
    };
    const locked = await appendQuoteLines("q1", [plain]);
    expect(locked.ok).toBe(false);
    expect((locked as { error: string }).error).toContain("E-001 priced contract C-001, which the customer has already signed");
    expect(s.calls.filter(lineInsert)).toEqual([]);
  });
});

describe("updateQuoteItem with detail and category", () => {
  it("null clears both; a breakdown is coerced on the way in; a word is trimmed", async () => {
    expect(await updateQuoteItem("l1", "q1", { detail: null, category: null })).toEqual({ ok: true });
    expect(s.calls.find(lineUpdate)).toMatchObject({ payload: { detail: null, category: null }, select: "id", filters: [["eq", "id", "l1"], ["eq", "quote_id", "q1"]] });
    s.calls = [];
    const messy = { ...DETAIL, labor: [{ hours: "2", rate: "135", rate_from: "guess" }] };
    expect(await updateQuoteItem("l1", "q1", { detail: messy as never, category: "  Decking " })).toEqual({ ok: true });
    const wrote = s.calls.find(lineUpdate)!.payload as { detail: typeof DETAIL; category: string };
    expect(wrote.category).toBe("Decking");
    expect(wrote.detail.labor).toEqual([{ label: null, person_id: null, hours: 2, rate: 135, rate_from: "legacy" }]);
    expect(wrote.detail.task_id).toBe("t-footings");
  });

  it("undefined leaves the column alone (a price change carries no detail or category key); a blank word is none", async () => {
    expect(await updateQuoteItem("l1", "q1", { unit_price: 300 })).toEqual({ ok: true });
    expect(s.calls.find(lineUpdate)!.payload).toEqual({ unit_price: 300 });
    s.calls = [];
    await updateQuoteItem("l1", "q1", { category: "   " });
    expect(s.calls.find(lineUpdate)!.payload).toEqual({ category: null });
  });

  it("a breakdown that does not read as one is refused, never stored as null; zero rows is refused", async () => {
    expect(await updateQuoteItem("l1", "q1", { detail: "junk" as never })).toEqual({ ok: false, error: "That line's breakdown couldn't be read — nothing was changed." });
    expect(s.calls.filter(lineUpdate)).toEqual([]);
    s.answer = (c) => (lineUpdate(c) ? { data: [], error: null } : base(c));
    expect(await updateQuoteItem("l-other", "q1", { detail: DETAIL })).toEqual({ ok: false, error: "That line isn't on this estimate." });
  });
});

describe("updateQuoteItem: the job follows a figure change (S5)", () => {
  const behind = (c: Call) => c.table === "quotes" && c.verb === "select" && c.select === "job_id, status";
  // What the line said BEFORE the write — the words for the retitle, the figure for "does it move" (cn-v1133).
  const wasRead = (c: Call) => c.table === "quote_line_items" && c.verb === "select" && c.select === "description, quantity, unit_price, detail";
  const STORED = { description: "Footings", quantity: "1", unit_price: "278", detail: DETAIL };
  const accepted = (c: Call) => {
    if (gate(c)) return { data: { status: "accepted", job_id: "j1", quote_number: "E-001", doc_type: "estimate" }, error: null };
    if (behind(c)) return { data: { job_id: "j1", status: "accepted" }, error: null };
    if (wasRead(c)) return { data: STORED, error: null };
    if (c.table === "contracts" || c.table === "payment_milestones") return { data: null, error: null };
    return base(c);
  };

  it("hours or parts changed on an accepted, job-linked estimate: the job's figure is read BEFORE the write, the two rules run after it with that figure, and what they did is said", async () => {
    s.answer = accepted;
    const res = await updateQuoteItem("l1", "q1", { detail: { ...DETAIL, labor: [{ ...DETAIL.labor[0], hours: 3 }] } });
    expect(res).toEqual({ ok: true, said: "The job's list follows the estimate: 1 task's hours updated · the job's length is now 3 h. The estimate's materials list follows too: 1 part added." });
    expect(rules.estimateLines).toHaveBeenCalledTimes(1);
    expect(rules.estimateLines).toHaveBeenCalledWith(client, { jobId: "j1", orgId: "org-1" });
    // The figure was read before the line was written: the behind read sits before the update.
    expect(s.calls.findIndex(behind)).toBeLessThan(s.calls.findIndex(lineUpdate));
    expect(rules.syncJobTasks).toHaveBeenCalledWith(client, { jobId: "j1", orgId: "org-1", createdBy: "office-1", sizeBefore: 120, tasksBefore: FIGURE.tasksBefore });
    expect(rules.syncJobMaterials).toHaveBeenCalledWith(client, { jobId: "j1", orgId: "org-1", userId: "office-1", partsBefore: FIGURE.partsBefore });
    // The rules ran after the write landed.
    expect(rules.syncJobTasks.mock.invocationCallOrder[0]).toBeGreaterThan(rules.estimateLines.mock.invocationCallOrder[0]);
  });

  it("ONLY WHAT DIFFERS MOVES THE FIGURE (cn-v1133): the editor sends the count, the price and the breakdown on every write — a description-only edit, or the same figures again, runs NO sync", async () => {
    s.answer = accepted;
    // The editor's whole-line write: new words, the stored figures unchanged.
    const res = await updateQuoteItem("l1", "q1", { description: "Footings, deeper", quantity: 1, unit_price: 278, detail: DETAIL, category: "Decking" });
    expect(res.ok).toBe(true);
    expect(res.said).toBeUndefined();
    expect(rules.estimateLines).not.toHaveBeenCalled();
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
    expect(rules.syncJobMaterials).not.toHaveBeenCalled();
    // The breakdown is compared as the one reader stores it: a junk rate_from that coerces to the stored row's is the same figure.
    expect((await updateQuoteItem("l1", "q1", { detail: { ...DETAIL, labor: [{ ...DETAIL.labor[0], hours: "2", rate: "135" }] } as never })).ok).toBe(true);
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
    // A row that could not be read falls back to the old rule: a key present is a figure that moves.
    s.answer = (c) => (wasRead(c) ? { data: null, error: null } : accepted(c));
    expect((await updateQuoteItem("l1", "q1", { detail: DETAIL })).ok).toBe(true);
    expect(rules.syncJobTasks).toHaveBeenCalledTimes(1);
  });

  it("the count and the price are figure changes too (when they differ); a rename alone is not (the retitle rule only); a draft's or a job-less estimate's change runs nothing", async () => {
    s.answer = accepted;
    expect((await updateQuoteItem("l1", "q1", { quantity: 2 })).ok).toBe(true);
    expect((await updateQuoteItem("l1", "q1", { unit_price: 300 })).ok).toBe(true);
    expect(rules.syncJobTasks).toHaveBeenCalledTimes(2);
    // A breakdown made null, or a plain line given one, moves the figure too.
    expect((await updateQuoteItem("l1", "q1", { detail: null })).ok).toBe(true);
    expect(rules.syncJobTasks).toHaveBeenCalledTimes(3);
    rules.syncJobTasks.mockClear();
    rules.estimateLines.mockClear();
    // A rename: the line's old words are read for the retitle; the figure does not move.
    expect((await updateQuoteItem("l1", "q1", { description: "Footings, 7" })).ok).toBe(true);
    expect(s.calls.some(wasRead)).toBe(true);
    expect(rules.estimateLines).not.toHaveBeenCalled();
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
    // A draft, and an accepted estimate with no job: no figure to follow.
    s.answer = (c) => (behind(c) ? { data: { job_id: "j1", status: "draft" }, error: null } : base(c));
    expect((await updateQuoteItem("l1", "q1", { detail: DETAIL })).ok).toBe(true);
    s.answer = (c) => (behind(c) ? { data: { job_id: null, status: "accepted" }, error: null } : accepted(c));
    expect((await updateQuoteItem("l1", "q1", { detail: DETAIL })).ok).toBe(true);
    expect(rules.estimateLines).not.toHaveBeenCalled();
    expect(rules.syncJobTasks).not.toHaveBeenCalled();
  });

  it("a rule that could not follow is a note beside the ok, never a swallowed failure", async () => {
    s.answer = accepted;
    rules.syncJobTasks.mockResolvedValueOnce({ inserted: 0, rekeyed: 0, removed: 0, kept: 0, timed: 0, keptNames: [], leftOff: [], twice: [], sizeSet: false, error: "the list is locked" } as never);
    // The hours differ from the stored row: the figure moves, so the rules run (cn-v1133 gates them on that).
    const res = await updateQuoteItem("l1", "q1", { detail: { ...DETAIL, labor: [{ ...DETAIL.labor[0], hours: 3 }] } });
    expect(res.ok).toBe(true);
    expect(res.note).toBe("The job's list could not follow this change (the list is locked). Check its tasks.");
    expect(res.said).toBe("The estimate's materials list follows too: 1 part added.");
  });
});

describe("deleteQuoteItem", () => {
  it("zero rows is the one sentence the editor reads as 'already gone' (LINE_GONE), after the lock and the detail read; a delete that lands says what the job's list did", async () => {
    s.answer = (c) => (c.table === "quote_line_items" && c.verb === "delete" ? { data: [], error: null } : base(c));
    expect(await deleteQuoteItem("l-gone", "q1")).toEqual({ ok: false, error: LINE_GONE });
    const del = s.calls.find((c) => c.table === "quote_line_items" && c.verb === "delete")!;
    expect(del).toMatchObject({ select: "id", filters: [["eq", "id", "l-gone"], ["eq", "quote_id", "q1"]] });
    s.calls = [];
    s.answer = (c) => (c.table === "quote_line_items" && c.verb === "delete" ? { data: [{ id: "l1" }], error: null } : base(c));
    expect(await deleteQuoteItem("l1", "q1")).toEqual({ ok: true });
    expect(s.calls.findIndex(totalsWrite)).toBeGreaterThan(-1);
  });
});

describe("readQuoteLineIds", () => {
  const idsRead = (c: Call) => c.table === "quote_line_items" && c.verb === "select" && c.select === "id, sort_order, description";
  it("reads the ids, their order and their words only, scoped to the company, in order; the numbers as numbers", async () => {
    s.answer = (c) => (idsRead(c) ? { data: [{ id: "l1", sort_order: "0", description: "Trench" }, { id: "l2", sort_order: null, description: null }], error: null } : base(c));
    expect(await readQuoteLineIds("q1")).toEqual({ ok: true, items: [{ id: "l1", sort_order: 0, description: "Trench" }, { id: "l2", sort_order: null, description: "" }] });
    expect(s.calls.find(idsRead)!.filters).toEqual([["eq", "quote_id", "q1"], ["eq", "org_id", "org-1"], ["order", "sort_order"]]);
  });
  it("a failed read is said; an estimate with no lines is an empty list, not a refusal", async () => {
    s.answer = (c) => (idsRead(c) ? { data: null, error: { code: "XX000", message: "the reader tripped" } } : base(c));
    expect(await readQuoteLineIds("q1")).toEqual({ ok: false, error: "the reader tripped" });
    s.answer = (c) => (idsRead(c) ? { data: [], error: null } : base(c));
    expect(await readQuoteLineIds("q1")).toEqual({ ok: true, items: [] });
  });
});

describe("saveQuote is idempotent by the client's id", () => {
  const header = { customer_id: null, job_id: null, title: "Larkspur panel", notes: "", tax_rate: 0, valid_until: null, items: [plain] };

  it("the same id twice is ONE insert (with that id) and then ONE update — never two estimates", async () => {
    let landed: { id: string; status: string; inquiry_id: null } | null = null;
    s.answer = (c) => {
      if (standingRead(c)) return { data: landed, error: null };
      if (quoteInsert(c)) {
        landed = { id: (c.payload as { id: string }).id, status: "draft", inquiry_id: null };
        return base(c);
      }
      return base(c);
    };
    const first = await saveQuote({ ...header, id: "q-client" });
    expect(first).toMatchObject({ ok: true, id: "q-client", quote_number: "E-010" });
    const ins = s.calls.filter(quoteInsert);
    expect(ins).toHaveLength(1);
    expect(ins[0].payload).toMatchObject({ id: "q-client", title: "Larkspur panel" });
    expect(ins[0].payload).not.toHaveProperty("status");
    expect(s.calls.filter(draftRpc)).toEqual([]);
    // The retry under the same id (the first answer lost on the wire).
    s.calls = [];
    const second = await saveQuote({ ...header, id: "q-client", title: "Larkspur panel, revised" });
    expect(second).toMatchObject({ ok: true, id: "q-client" });
    expect(s.calls.filter(quoteInsert)).toEqual([]);
    const rpc = s.calls.filter(draftRpc);
    expect(rpc).toHaveLength(1);
    expect(rpc[0].payload).toMatchObject({ p_id: "q-client", p_fields: { title: "Larkspur panel, revised" } });
  });

  it("no id: the insert carries none (the database mints it), as before", async () => {
    expect((await saveQuote(header)).ok).toBe(true);
    expect(s.calls.filter(standingRead)).toEqual([]);
    expect(s.calls.find(quoteInsert)!.payload).not.toHaveProperty("id");
  });

  it("another company's id: nothing stands here, the insert finds the key taken, and the answer is 'Quote not found.' — no second estimate", async () => {
    s.answer = (c) => {
      if (standingRead(c)) return { data: null, error: null };
      if (quoteInsert(c)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "quotes_pkey"' } };
      return base(c);
    };
    expect(await saveQuote({ ...header, id: "q-theirs" })).toEqual({ ok: false, error: "Quote not found." });
    expect(s.calls.filter(quoteInsert)).toHaveLength(1);
    expect(s.calls.filter(draftRpc)).toEqual([]);
    // Read, tried, read again: the second read is what tells a twin from a foreign row.
    expect(s.calls.filter(standingRead)).toHaveLength(2);
  });

  it("a twin save in flight: the insert finds the key taken, the row proves ours, and this save updates it", async () => {
    let reads = 0;
    s.answer = (c) => {
      if (standingRead(c)) return { data: ++reads === 1 ? null : { id: "q-client", status: "draft", inquiry_id: null }, error: null };
      if (quoteInsert(c)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "quotes_pkey"' } };
      return base(c);
    };
    expect(await saveQuote({ ...header, id: "q-client" })).toMatchObject({ ok: true, id: "q-client" });
    expect(s.calls.filter(quoteInsert)).toHaveLength(1);
    expect(s.calls.filter(draftRpc)).toHaveLength(1);
  });

  it("a standing non-draft is refused before the RPC is asked; any other key collision keeps dbError's words", async () => {
    s.answer = (c) => (standingRead(c) ? { data: { id: "q1", status: "sent", inquiry_id: null }, error: null } : base(c));
    expect(await saveQuote({ ...header, id: "q1" })).toEqual({ ok: false, code: "not_editable", error: "That draft was sent — it can't be edited from the builder anymore." });
    expect(s.calls.filter(draftRpc)).toEqual([]);
    s.answer = (c) => {
      if (standingRead(c)) return { data: null, error: null };
      if (quoteInsert(c)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "quotes_org_number_key"' } };
      return base(c);
    };
    expect(await saveQuote({ ...header, id: "q-client" })).toEqual({ ok: false, error: "That estimate number is already in use. Try saving again — it'll take the next one." });
  });

  it("a failed standing read is said, and nothing is written", async () => {
    s.answer = (c) => (standingRead(c) ? { data: null, error: { code: "XX000", message: "the reader tripped" } } : base(c));
    expect(await saveQuote({ ...header, id: "q1" })).toEqual({ ok: false, error: "the reader tripped" });
    expect(s.calls.filter((c) => c.verb !== "select")).toEqual([]);
  });
});

describe("readQuoteForEditor", () => {
  const editorQuote = (c: Call) => c.table === "quotes" && c.verb === "select" && !!c.select?.includes("quote_number, customer_id");
  const editorItems = (c: Call) => c.table === "quote_line_items" && c.verb === "select" && !!c.select?.includes("line_total");
  const row = {
    id: "q1", quote_number: "E-001", customer_id: "c1", job_id: null, inquiry_id: "i1", status: "draft", doc_type: "estimate",
    title: "Snowbell deck", description: null, notes: null, tax_rate: "0.0825", subtotal: "568", tax: "46.86", total: "614.86",
    valid_until: null, follow_up_at: "2026-11-02", estimate_format: "detailed", revises_quote_id: null, public_token: "tok", circuits: null,
    address: "12 Bayberry Ln", unit: null, city: "Thistlewood", state: "CA", zip: "96000", accepted_at: null, declined_at: null,
    created_by: "office-1", created_at: "2026-10-27", updated_at: "2026-10-27",
  };
  const lines = [
    { id: "l1", quote_id: "q1", description: "Trench", quantity: "1", unit: "ea", unit_price: "290", line_total: "290", sort_order: 0, category: null, detail: null },
    // A line saved before cn-v1131: the one-figure shape, read as one legacy row.
    { id: "l2", quote_id: "q1", description: "Footings", quantity: "1", unit: "ea", unit_price: "278", line_total: "278", sort_order: 1, category: "Decking", detail: { task_id: "t1", hours: 2, rate: 139, materials: [] } },
  ];
  const found = (c: Call) => (editorQuote(c) ? { data: row, error: null } : editorItems(c) ? { data: lines, error: null } : base(c));

  it("names its columns on both reads, scoped to the company; the money is numbers and every breakdown is coerced", async () => {
    s.answer = found;
    const res = await readQuoteForEditor("q1");
    if (!res.ok) throw new Error(res.error);
    const { quote, items } = res;
    const q = s.calls.find(editorQuote)!;
    expect(q.select).not.toContain("*");
    for (const col of ["id", "quote_number", "customer_id", "job_id", "inquiry_id", "status", "doc_type", "title", "description", "notes", "tax_rate", "subtotal", "tax", "total", "valid_until", "follow_up_at", "estimate_format", "revises_quote_id", "public_token", "circuits", "address", "created_at"])
      expect(q.select!.split(", ")).toContain(col);
    expect(q.filters).toEqual([["eq", "id", "q1"], ["eq", "org_id", "org-1"]]);
    const li = s.calls.find(editorItems)!;
    expect(li.select).toBe("id, quote_id, description, quantity, unit, unit_price, line_total, sort_order, category, detail");
    expect(li.filters).toEqual([["eq", "quote_id", "q1"], ["eq", "org_id", "org-1"], ["order", "sort_order"]]);
    expect(quote).toMatchObject({ id: "q1", estimate_format: "detailed", follow_up_at: "2026-11-02", public_token: "tok", tax_rate: 0.0825, subtotal: 568, tax: 46.86, total: 614.86 });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "l1", quantity: 1, unit_price: 290, line_total: 290, category: null, detail: null });
    expect(items[1]).toMatchObject({ id: "l2", category: "Decking", detail: { task_id: "t1", labor: [{ label: null, person_id: null, hours: 2, rate: 139, rate_from: "legacy" }], units: null, kit_id: null, materials: [] } });
  });

  it("not found is said in the file's words; a failed read on either side is said, never an empty editor", async () => {
    s.answer = (c) => (editorQuote(c) ? { data: null, error: null } : found(c));
    expect(await readQuoteForEditor("q-gone")).toEqual({ ok: false, error: "Quote not found." });
    s.answer = (c) => (editorQuote(c) ? { data: null, error: { code: "42703", message: "column quotes.follow_up_at does not exist" } } : found(c));
    expect(await readQuoteForEditor("q1")).toEqual({ ok: false, error: "This part of the app is mid-update. Give it a minute and try again." });
    s.answer = (c) => (editorItems(c) ? { data: null, error: { code: "XX000", message: "the reader tripped" } } : found(c));
    expect(await readQuoteForEditor("q1")).toEqual({ ok: false, error: "the reader tripped" });
  });
});

describe("createJobFromQuote: the link is compare-and-set (cn-v1133)", () => {
  const quoteRead = (c: Call) => c.table === "quotes" && c.verb === "select" && !!c.select?.startsWith("id, job_id, status,");
  const jobInsert = (c: Call) => c.table === "jobs" && c.verb === "insert";
  const link = (c: Call) => c.table === "quotes" && c.verb === "update" && "job_id" in (c.payload as object);
  const jobIdRead = (c: Call) => c.table === "quotes" && c.verb === "select" && c.select === "job_id";
  const jobDelete = (c: Call) => c.table === "jobs" && c.verb === "delete";
  const QUOTE = { id: "q1", job_id: null, status: "accepted", customer_id: "c1", title: "Snowbell deck", quote_number: "E-001", inquiry_id: null, address: null, unit: null, city: null, state: null, zip: null, revises_quote_id: null };
  const world = (linkAnswer: unknown[]) => (c: Call): unknown => {
    if (quoteRead(c)) return { data: QUOTE, error: null };
    if (jobInsert(c)) return { data: { id: "j-new" }, error: null };
    if (link(c)) return { data: linkAnswer, error: null };
    if (jobIdRead(c)) return { data: { job_id: "j-other" }, error: null };
    if (jobDelete(c)) return { data: [{ id: "j-new" }], error: null };
    if (c.table === "customers" && c.select === "name, company_name, type") return { data: { name: "Larkspur Holdings", company_name: null, type: "residential" }, error: null };
    return base(c);
  };

  it("the link lands only while job_id is still null, read back; then the birth and the paperwork run for THIS job", async () => {
    s.answer = world([{ id: "q1" }]);
    const res = await createJobFromQuote("q1");
    expect(res).toEqual({ ok: true, id: "j-new" });
    const w = s.calls.find(link)!;
    expect(w).toMatchObject({ payload: { job_id: "j-new" }, select: "id", filters: [["eq", "id", "q1"], ["is", "job_id", null]] });
    expect(s.calls.findIndex(link)).toBeGreaterThan(s.calls.findIndex(jobInsert));
    expect(rules.bornWithTasks).toHaveBeenCalledTimes(1);
    expect(rules.bornWithTasks).toHaveBeenCalledWith(client, { jobId: "j-new", quoteId: "q1", orgId: "org-1", createdBy: "office-1" });
    expect(rules.createWorkOrderFromQuote).toHaveBeenCalledWith("q1");
    expect(rules.createMaterialListFromQuote).toHaveBeenCalledWith("q1");
    expect(s.calls.filter(jobDelete)).toEqual([]);
  });

  it("zero rows = another door won in the same moment: the job this call made is removed (by id and company, read back), the other job is the answer, and nothing is born twice", async () => {
    s.answer = world([]);
    const res = await createJobFromQuote("q1");
    expect(res).toEqual({ ok: true, id: "j-other" });
    expect(s.calls.findIndex(jobIdRead)).toBeGreaterThan(s.calls.findIndex(link));
    const del = s.calls.find(jobDelete)!;
    expect(del).toMatchObject({ select: "id", filters: [["eq", "id", "j-new"], ["eq", "org_id", "org-1"]] });
    expect(rules.bornWithTasks).not.toHaveBeenCalled();
    expect(rules.createWorkOrderFromQuote).not.toHaveBeenCalled();
    expect(rules.createMaterialListFromQuote).not.toHaveBeenCalled();
    expect(s.calls.filter((c) => c.table === "appointments")).toEqual([]);
    // The twin could not be removed: still the other job, with a note naming the one thing to do.
    s.calls = [];
    const base2 = world([]);
    s.answer = (c) => (jobDelete(c) ? { data: [], error: null } : base2(c));
    const stuck = await createJobFromQuote("q1");
    expect(stuck).toEqual({ ok: true, id: "j-other", note: "Another door made this estimate's job in the same moment; a second, empty job could not be removed — delete it on Jobs." });
  });

  it("the link write ERRORS (skeptic #39, S7): the just-made empty job is removed — by id and company, read back — before the refusal, so a retry never makes a second; a removal that fails is said", async () => {
    const base3 = world([]);
    s.answer = (c) => (link(c) ? { data: null, error: { message: "the wire dropped" } } : base3(c));
    const res = await createJobFromQuote("q1");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("the wire dropped");
    expect(res.error).not.toContain("left behind");
    const del = s.calls.find(jobDelete)!;
    expect(del).toMatchObject({ select: "id", filters: [["eq", "id", "j-new"], ["eq", "org_id", "org-1"]] });
    expect(s.calls.findIndex(jobDelete)).toBeGreaterThan(s.calls.findIndex(link));
    expect(rules.bornWithTasks).not.toHaveBeenCalled();
    expect(rules.createWorkOrderFromQuote).not.toHaveBeenCalled();
    s.calls = [];
    s.answer = (c) => (link(c) ? { data: null, error: { message: "the wire dropped" } } : jobDelete(c) ? { data: [], error: null } : base3(c));
    const stuck = await createJobFromQuote("q1");
    expect(stuck.ok).toBe(false);
    expect(stuck.error).toContain("An empty job was left behind — delete it on Jobs.");
  });
});
