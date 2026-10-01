import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * "IT IS THAT BILL" (d1ff7c5a). linkReceiptToBill writes the one organized_items tie a loose receipt
 * is missing (document_id + bill_id, on the bill's job). Pinned without a database:
 *
 *   - a tech's Snap Or Note row (needs_review, no bill on it) naming the same document does NOT
 *     block the tie: only a row that already carries a bill (bill_id, or tied_bill_id) does;
 *   - a row already on THIS bill is a re-tap: ok, nothing stacked;
 *   - a row on ANOTHER bill is said, never silently kept;
 *   - the tie is written with source "job" (TD1: Undo or Delete of the bill never takes the
 *     job's own upload with it), and checked (.select("id"): a zero-row insert is a refusal);
 *   - job containment: a receipt on another job, or a bill with no job, is refused in words.
 *
 * The fake applies eq and the `or("bill_id.not.is.null,tied_bill_id.not.is.null")` filter itself,
 * so the short-circuit is tested as the query, not as a stub's answer.
 */
const state = vi.hoisted(() => ({
  staff: true,
  bills: {} as Record<string, any>,
  docs: {} as Record<string, any>,
  ties: [] as any[],
  inserted: [] as any[],
  insertAnswer: null as null | { data: any; error: any },
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => (state.staff ? { supabase: client(), userId: "user-erik", orgId: "org-et" } : { error: "This action is staff-only." })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(), deleteCalendarItem: vi.fn() }));
vi.mock("@/lib/crew-notify", () => ({ notifyJobCrewAdded: vi.fn() }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { linkReceiptToBill } from "./actions";

type Filter = { op: "eq" | "or"; col?: string; val?: unknown; expr?: string };

/** PostgREST's `a.not.is.null,b.not.is.null` (an OR of "not null" tests), as the query means it. */
function orMatches(expr: string, row: any): boolean {
  return expr.split(",").some((part) => {
    const m = part.match(/^(\w+)\.not\.is\.null$/);
    if (!m) throw new Error(`unsupported or() clause in the fake: ${part}`);
    return row[m[1]] != null;
  });
}

function client() {
  return {
    from(table: string) {
      const q: { op: string; payload?: any; filters: Filter[] } = { op: "select", filters: [] };
      const matches = (row: any) =>
        q.filters.every((f) => (f.op === "eq" ? row?.[f.col!] === f.val : orMatches(f.expr!, row)));
      const run = async (): Promise<{ data: any; error: any }> => {
        if (table === "bills") return { data: state.bills[q.filters.find((f) => f.col === "id")?.val as string] ?? null, error: null };
        if (table === "documents") return { data: state.docs[q.filters.find((f) => f.col === "id")?.val as string] ?? null, error: null };
        if (table === "organized_items") {
          if (q.op === "insert") {
            state.inserted.push(q.payload);
            return state.insertAnswer ?? { data: [{ id: `tie-${state.inserted.length}` }], error: null };
          }
          return { data: state.ties.find(matches) ?? null, error: null };
        }
        throw new Error(`unrouted: ${table} ${q.op}`);
      };
      const chain: any = {
        select: () => chain,
        insert(p: any) {
          q.op = "insert";
          q.payload = p;
          return chain;
        },
        eq(col: string, val: unknown) {
          q.filters.push({ op: "eq", col, val });
          return chain;
        },
        or(expr: string) {
          q.filters.push({ op: "or", expr });
          return chain;
        },
        limit: () => chain,
        maybeSingle: run,
        single: run,
        then: (ok: any, bad: any) => run().then(ok, bad),
      };
      return chain;
    },
  };
}

const BILL = "b-ced";
const DOC = "doc-ced";

beforeEach(() => {
  state.staff = true;
  state.bills = { [BILL]: { id: BILL, job_id: "j-013", supplier: "CED", amount: 301.81, bill_date: "2026-09-04", category: "Receipt" } };
  state.docs = { [DOC]: { id: DOC, job_id: "j-013", file_url: "org/j-013/ced.jpg" } };
  state.ties = [];
  state.inserted = [];
  state.insertAnswer = null;
});

describe("linkReceiptToBill: the tie a loose receipt is missing", () => {
  it("writes the tie, on the bill's job, with the bill's words and source job, and checks it landed", async () => {
    const res = await linkReceiptToBill(BILL, DOC);
    expect(res).toEqual({ ok: true });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      kind: "receipt",
      job_id: "j-013",
      document_id: DOC,
      bill_id: BILL,
      file_url: "org/j-013/ced.jpg",
      vendor: "CED",
      amount: 301.81,
      status: "filed",
      source: "job",
      created_by: "user-erik",
    });
  });

  it("a tech's Snap Or Note row naming the document, with no bill on it, does not block the tie", async () => {
    state.ties = [{ id: "t-note", document_id: DOC, bill_id: null, tied_bill_id: null, status: "needs_review" }];
    const res = await linkReceiptToBill(BILL, DOC);
    expect(res).toEqual({ ok: true });
    expect(state.inserted).toHaveLength(1);
  });

  it("a row already on this bill is a re-tap: ok, and nothing is stacked", async () => {
    state.ties = [{ id: "t-1", document_id: DOC, bill_id: BILL, tied_bill_id: null, status: "filed" }];
    expect(await linkReceiptToBill(BILL, DOC)).toEqual({ ok: true });
    // …and a tie made by File It (tied_bill_id) counts the same.
    state.ties = [{ id: "t-2", document_id: DOC, bill_id: null, tied_bill_id: BILL, status: "filed" }];
    expect(await linkReceiptToBill(BILL, DOC)).toEqual({ ok: true });
    expect(state.inserted).toHaveLength(0);
  });

  it("a row on another bill is said, never silently kept", async () => {
    state.ties = [{ id: "t-other", document_id: DOC, bill_id: "b-other", tied_bill_id: null, status: "filed" }];
    const res = await linkReceiptToBill(BILL, DOC);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already on another bill");
    expect(state.inserted).toHaveLength(0);
  });

  it("job containment: a receipt on another job, or a bill with no job, is refused in words", async () => {
    state.docs[DOC].job_id = "j-999";
    expect(await linkReceiptToBill(BILL, DOC)).toEqual({ ok: false, error: "That receipt isn't on this cost's job." });
    state.docs[DOC].job_id = "j-013";
    state.bills[BILL].job_id = null;
    expect(await linkReceiptToBill(BILL, DOC)).toEqual({ ok: false, error: "That receipt isn't on this cost's job." });
    expect(state.inserted).toHaveLength(0);
  });

  it("a vanished bill or receipt, a zero-row insert, and a tech are each refused in words", async () => {
    expect(await linkReceiptToBill("b-gone", DOC)).toEqual({ ok: false, error: "Couldn't find that cost or receipt." });
    state.insertAnswer = { data: [], error: null };
    expect(await linkReceiptToBill(BILL, DOC)).toEqual({ ok: false, error: "The tie didn't save. Try again." });
    state.staff = false;
    expect(await linkReceiptToBill(BILL, DOC)).toEqual({ ok: false, error: "This action is staff-only." });
  });
});
