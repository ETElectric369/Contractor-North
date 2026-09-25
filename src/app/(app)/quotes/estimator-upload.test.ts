import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ESTIMATOR'S TWO UPLOAD DOORS (Panel plan, phase 4; Erik's decision 3).
 *
 *   Upload Plans    the plans are KEPT: moved out of the stash and filed as a Plan on the customer
 *                   (and the job when there is one), so the job's Panel tab has something to read.
 *                   Where they went is said; why they weren't kept is said.
 *   Supplier Quote  still DELETED the moment it is read (audit 7): CED's net pricing must never sit
 *                   where a field tech can list and open it.
 *
 * And neither door reads (or deletes) a path outside the estimator's own stash. The model is a stub.
 */

const s = vi.hoisted(() => ({ client: null as any, model: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => s.client), createServiceClient: vi.fn(() => s.client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: s.client, userId: "user-1", orgId: ORG })) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/ai-cost", () => ({
  recordAiUsage: vi.fn(async () => {}),
  aiSpendExceeded: vi.fn(async () => false),
  currentOrgId: vi.fn(async () => ORG),
  modelFor: () => "claude-haiku-4-5",
}));
vi.mock("@/lib/anthropic", () => ({ getAnthropic: () => s.model, DEFAULT_MODEL: "claude-opus-4-8" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));

import { generateQuoteDraftFromPlan, generateQuoteDraftFromSupplier } from "./actions";

const ORG = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const CUST = "66666666-6666-4666-8666-666666666666";
const STASH = `${ORG}/ai-uploads/9b2c-Herringbone_E-sheets.pdf`;

type Ops = { removed: string[][]; moved: [string, string][]; downloads: string[]; inserts: { table: string; payload: any }[] };
let ops: Ops;

/** A permissive database: anything not named below answers "nothing", so the estimator's own
 *  reads (the org, the price book) run; the plan door's reads are answered by `rows`. */
function fakeSupabase(rows: Record<string, any>) {
  ops = { removed: [], moved: [], downloads: [], inserts: [] };
  const pdf = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" });
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    storage: {
      from: () => ({
        download: async (p: string) => {
          ops.downloads.push(p);
          return { data: pdf, error: null };
        },
        remove: async (paths: string[]) => {
          ops.removed.push(paths);
          return { data: null, error: null };
        },
        move: async (from: string, to: string) => {
          ops.moved.push([from, to]);
          return { data: null, error: null };
        },
      }),
    },
    from(table: string) {
      let verb = "select";
      const chain: any = {
        insert(payload: any) {
          verb = "insert";
          ops.inserts.push({ table, payload });
          return chain;
        },
        update() { verb = "update"; return chain; },
        select() { return chain; },
        eq() { return chain; },
        is() { return chain; },
        in() { return chain; },
        not() { return chain; },
        or() { return chain; },
        ilike() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        range() { return chain; },
        maybeSingle: async () => ({ data: rows[`${table}.${verb}.one`] ?? null, error: null }),
        single: async () => ({ data: rows[`${table}.${verb}.one`] ?? null, error: null }),
        then(ok: any, err: any) {
          return Promise.resolve({ data: rows[`${table}.${verb}`] ?? [], error: null }).then(ok, err);
        },
      };
      return chain;
    },
  };
}

function stubModel(text: string) {
  const create = vi.fn(async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } }));
  s.model = { messages: { create } };
  return create;
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  s.client = null;
  s.model = null;
});

describe("Upload Plans keeps the plans", () => {
  it("on the job (and its customer): moved into the job's folder, filed as a Plan, never removed from storage", async () => {
    s.client = fakeSupabase({
      "jobs.select.one": { id: JOB, job_number: "J-011", name: "13897 Herringbone", customer_id: CUST },
      "customers.select.one": { id: CUST, name: "Andrew Cohen" },
      "documents.insert": [{ id: "doc-1" }],
    });
    stubModel(JSON.stringify({ description: "", items: [], questions: [] }));
    const r = await generateQuoteDraftFromPlan(form({ storagePath: STASH, fileName: "Herringbone E-sheets.pdf", jobId: JOB }));
    expect(r.kept).toEqual({ kept: true, words: "Kept as a Plan on 13897 Herringbone.", documentId: "doc-1" });
    expect(ops.moved).toHaveLength(1);
    expect(ops.moved[0][0]).toBe(STASH);
    expect(ops.moved[0][1]).toMatch(new RegExp(`^${ORG}/${JOB}/\\d+-Herringbone_E-sheets\\.pdf$`));
    const doc = ops.inserts.find((i) => i.table === "documents")!;
    expect(doc.payload).toMatchObject({ org_id: ORG, job_id: JOB, customer_id: CUST, category: "Plan", kind: "other", name: "Herringbone E-sheets.pdf", uploaded_by: "user-1" });
    // The stash itself is never deleted out from under the filed plan.
    expect(ops.removed).toEqual([]);
  });

  it("an estimate with no customer yet: read, not kept, and said (the stash is cleared, nothing silent)", async () => {
    s.client = fakeSupabase({});
    stubModel(JSON.stringify({ description: "", items: [], questions: [] }));
    const r = await generateQuoteDraftFromPlan(form({ storagePath: STASH, fileName: "plans.pdf" }));
    expect(r.kept?.kept).toBe(false);
    expect(r.kept?.words).toMatch(/pick who the estimate is for first/);
    expect(ops.removed).toEqual([[STASH]]);
    expect(ops.inserts.filter((i) => i.table === "documents")).toEqual([]);
  });

  it("a path outside the estimator's stash is refused: not read, not moved, not deleted", async () => {
    s.client = fakeSupabase({});
    const create = stubModel("{}");
    const r = await generateQuoteDraftFromPlan(form({ storagePath: `${ORG}/${JOB}/1727-receipt.jpg`, fileName: "x.pdf", jobId: JOB }));
    expect(r).toMatchObject({ ok: false, error: "That upload isn't in the estimator's folder. Upload it again." });
    expect(ops.downloads).toEqual([]);
    expect(ops.removed).toEqual([]);
    expect(ops.moved).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("a supplier quote is still deleted on read", () => {
  it("read, then removed from the stash; never moved, never filed", async () => {
    s.client = fakeSupabase({});
    stubModel(JSON.stringify({ items: [{ description: "SIEM Q2020", quantity: 8, unit: "ea", unit_cost: 23.11 }], tax_total: null }));
    const r = await generateQuoteDraftFromSupplier(form({ storagePath: STASH, fileName: "CED 8802-SO-257555.pdf", jobId: JOB, customerId: CUST }));
    expect(r.ok).toBe(true);
    expect(ops.removed).toEqual([[STASH]]);
    expect(ops.moved).toEqual([]);
    expect(ops.inserts.filter((i) => i.table === "documents")).toEqual([]);
  });
});
