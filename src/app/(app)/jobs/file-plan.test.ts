import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE PLANS DOOR'S SERVER HALF, PINNED (Erik 2026-09-25: "uploading a plan file from a dropdown in
 * the costs tab is the most unituitive thing ive seen on this app in a while"). filePlan files a
 * file the browser already put in the job's folder as a Plan, and nothing more: it never reads the
 * paper as a receipt, never writes a bill or a cost, never puts anything on the customer's page. It
 * is office only, org-scoped, and refuses a path outside THIS job's folder before writing anything.
 * Unscripted calls throw, so every statement it makes is accounted for.
 */

const state = vi.hoisted(() => ({ client: null as any, guard: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.guard) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/signed-docs", () => ({
  signDocumentUrls: vi.fn(async (_s: unknown, paths: (string | null)[]) => new Map(paths.filter(Boolean).map((p) => [p as string, `https://signed/${p}`]))),
}));
// The receipt reader: filePlan must never reach it (it isn't even imported; this proves no door does).
const billJobReceipt = vi.hoisted(() => vi.fn());
vi.mock("@/app/(app)/organize/actions", () => ({ billJobReceipt }));

import { filePlan } from "./portal-share-actions";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const OTHER_JOB = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG = "44444444-4444-4444-8444-444444444444";
const PATH = `${ORG}/${JOB}/1727312345678-Panel_Schedule_v2.pdf`;

type Call = { table: string; verb: string; payload?: any; eqs: [string, unknown][] };

function fakeSupabase(script: Record<string, any[]>, calls: Call[], removed: string[][]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    rpc: async (fn: string) => next(`rpc.${fn}`),
    storage: { from: () => ({ remove: async (paths: string[]) => { removed.push(paths); return { error: null }; } }) },
    from(table: string) {
      const mine: Call = { table, verb: "select", eqs: [] };
      calls.push(mine);
      const chain: any = {
        insert(payload: any) { mine.verb = "insert"; mine.payload = payload; return chain; },
        update(payload: any) { mine.verb = "update"; mine.payload = payload; return chain; },
        delete() { mine.verb = "delete"; return chain; },
        select() { return chain; },
        eq(col: string, val: unknown) { mine.eqs.push([col, val]); return chain; },
        limit() { return chain; },
        maybeSingle: () => Promise.resolve(next(`${table}.${mine.verb}`)),
        single: () => Promise.resolve(next(`${table}.${mine.verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${mine.verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

let calls: Call[];
let removed: string[][];
function staffWith(script: Record<string, any[]>) {
  calls = [];
  removed = [];
  state.client = fakeSupabase(script, calls, removed);
  state.guard = { supabase: state.client, userId: "user-1", orgId: ORG };
}

const ROW = {
  id: "55555555-5555-4555-8555-555555555555",
  job_id: JOB,
  name: "Panel_Schedule_v2.pdf",
  category: "Plan",
  file_url: PATH,
  created_at: "2026-09-25T08:00:00Z",
};

/** The path checks: no paper and no supplier invoice names this file yet. */
const freePath = () => ({
  "documents.select": [{ data: [], error: null }],
  "supplier_invoices.select": [{ data: [], error: null }],
});

beforeEach(() => billJobReceipt.mockReset());

describe("filePlan", () => {
  it("files the paper on the job as a Plan, org-scoped, and hands back the paper for the sheet", async () => {
    staffWith({ "jobs.select": [{ data: { id: JOB } }], ...freePath(), "documents.insert": [{ data: [ROW], error: null }] });
    const res = await filePlan(JOB, { path: PATH, name: "Panel_Schedule_v2.pdf", sizeBytes: 412_000 });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The job is looked up in THIS org.
    expect(calls[0]).toMatchObject({ table: "jobs", verb: "select" });
    expect(calls[0].eqs).toEqual(expect.arrayContaining([["id", JOB], ["org_id", ORG]]));
    // One documents row, category Plan, on this org and job, by this person.
    const ins = calls.find((c) => c.verb === "insert")!;
    expect(ins.table).toBe("documents");
    expect(ins.payload).toMatchObject({ org_id: ORG, job_id: JOB, category: "Plan", file_url: PATH, size_bytes: 412_000, uploaded_by: "user-1" });
    // The paper the sheet opens on: showable (no refusal), a PDF, signed for the office's preview.
    expect(res.paper).toMatchObject({ id: ROW.id, category: "Plan", format: "pdf", refusal: null, signedUrl: `https://signed/${PATH}` });
  });

  it("never reads it as a cost: no receipt reader, no bill, no organize row, no share, nothing on the portal", async () => {
    staffWith({ "jobs.select": [{ data: { id: JOB } }], ...freePath(), "documents.insert": [{ data: [ROW], error: null }] });
    await filePlan(JOB, { path: PATH, name: "receipt.jpg" });
    expect(billJobReceipt).not.toHaveBeenCalled();
    expect(calls.map((c) => c.table)).toEqual(["jobs", "documents", "supplier_invoices", "documents"]);
    for (const t of ["bills", "bill_lines", "organized_items", "job_shared_documents", "petty_cash"]) {
      expect(calls.some((c) => c.table === t)).toBe(false);
    }
    // Even a file named like a receipt is filed as a Plan.
    expect(calls.find((c) => c.verb === "insert")!.payload.category).toBe("Plan");
  });

  it("refuses a tech (requireStaff says no) before touching anything", async () => {
    calls = [];
    removed = [];
    state.client = fakeSupabase({}, calls, removed);
    state.guard = { error: "This action is staff-only." };
    const res = await filePlan(JOB, { path: PATH });
    expect(res).toEqual({ ok: false, error: "This action is staff-only." });
    expect(calls).toEqual([]);
  });

  it("refuses a job that isn't this org's, and writes nothing", async () => {
    staffWith({ "jobs.select": [{ data: null }] });
    const res = await filePlan(JOB, { path: PATH });
    expect(res).toEqual({ ok: false, error: "That job isn't in your book." });
    expect(calls.some((c) => c.verb === "insert")).toBe(false);
  });

  it("refuses a file outside THIS job's folder (another org's, another job's, a climb out), and writes nothing", async () => {
    for (const path of [
      `${OTHER_ORG}/${JOB}/1-plan.pdf`,
      `${ORG}/${OTHER_JOB}/1-plan.pdf`,
      `${ORG}/${JOB}/../${OTHER_JOB}/1-plan.pdf`,
      "",
      42,
    ]) {
      staffWith({ "jobs.select": [{ data: { id: JOB } }] });
      const res = await filePlan(JOB, { path });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/isn't in this job's folder/);
      expect(calls.some((c) => c.verb === "insert")).toBe(false);
    }
  });

  it("a row that doesn't land takes its file back out of the bucket and says so", async () => {
    staffWith({ "jobs.select": [{ data: { id: JOB } }], ...freePath(), "documents.insert": [{ data: [], error: null }] });
    const res = await filePlan(JOB, { path: PATH });
    expect(res).toEqual({ ok: false, error: "It uploaded but wasn't filed on the job. Try again." });
    expect(removed).toEqual([[PATH]]);
  });

  it("names the paper from its stored file when the browser sent no name", async () => {
    staffWith({ "jobs.select": [{ data: { id: JOB } }], ...freePath(), "documents.insert": [{ data: [ROW], error: null }] });
    await filePlan(JOB, { path: PATH });
    expect(calls.find((c) => c.verb === "insert")!.payload.name).toBe("Panel_Schedule_v2.pdf");
  });

  it("refuses a path a receipt (or any paper) already names, and never removes that file", async () => {
    // A crafted call naming the receipt's own file: a second row would slip past the portal's
    // money-paper guard, and undoing it would delete the file the receipt and its bill point at.
    const RECEIPT = `${ORG}/${JOB}/1727300000000-CED_receipt.jpg`;
    staffWith({
      "jobs.select": [{ data: { id: JOB } }],
      "documents.select": [{ data: [{ id: "receipt-doc" }], error: null }],
      "supplier_invoices.select": [{ data: [], error: null }],
    });
    const res = await filePlan(JOB, { path: RECEIPT });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already filed on this job/);
    // Looked up in THIS org by that exact file.
    const look = calls.find((c) => c.table === "documents" && c.verb === "select")!;
    expect(look.eqs).toEqual(expect.arrayContaining([["org_id", ORG], ["file_url", RECEIPT]]));
    expect(calls.some((c) => c.verb === "insert")).toBe(false);
    expect(removed).toEqual([]);
  });

  it("refuses a supplier invoice's source file the same way", async () => {
    const SRC = `${ORG}/${JOB}/1727300000000-statement.pdf`;
    staffWith({
      "jobs.select": [{ data: { id: JOB } }],
      "documents.select": [{ data: [], error: null }],
      "supplier_invoices.select": [{ data: [{ id: "si-1" }], error: null }],
    });
    const res = await filePlan(JOB, { path: SRC });
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.verb === "insert")).toBe(false);
    expect(removed).toEqual([]);
  });

  it("a check that fails refuses without writing or removing anything", async () => {
    staffWith({
      "jobs.select": [{ data: { id: JOB } }],
      "documents.select": [{ data: null, error: { message: "boom" } }],
      "supplier_invoices.select": [{ data: [], error: null }],
    });
    const res = await filePlan(JOB, { path: PATH });
    expect(res).toEqual({ ok: false, error: "It couldn't check that file. Try again." });
    expect(calls.some((c) => c.verb === "insert")).toBe(false);
    expect(removed).toEqual([]);
  });
});
