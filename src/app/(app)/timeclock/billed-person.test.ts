import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A BILLED SHIFT STAYS WITH ITS PERSON (2026-09-26, labor claims by person).
 *
 * A labor line claims the shifts it billed by id (invoice_items.source_ids, 0255). The Timecards edit
 * modal's Team Member picker handed a shift to someone else with no look at that claim: Erik's shift,
 * billed on "Labor — Erik Taylor", moved to Brian, and Erik's line then claimed Brian's hours. Who
 * worked what, per-person hours and the payroll cross-checks read the line, so they read it wrong.
 * An owner's shift is never paid through payroll (0286), so the paid-period lock never stopped it.
 *
 * The rule is the job move's (claimedMoveRefusal, 0288): refused before anything is written, and the
 * sentence names the invoice. 0361's time_entries_billed_person_stays is the same rule underneath.
 *
 * The fake refuses any statement it was not told about, by name.
 */
const state = vi.hoisted(() => ({ client: null as any }));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "office-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("../schedule/actions", () => ({ setJobCrew: vi.fn(async () => ({ ok: true })) }));

import { updateTimeEntry } from "./actions";
import { claimedPersonRefusal } from "./claim-words";

type Q = { table: string; verb: "select" | "insert" | "update" | "delete"; cols: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;

function fakeSupabase(route: (q: Q) => Reply, calls: Q[]) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)} ${JSON.stringify(q.filters)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      calls.push(q);
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        delete() { q.verb = "delete"; return chain; },
        single() { return Promise.resolve(answer(q)); },
        maybeSingle() { return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) {
          try { resolve(answer(q)); } catch (e) { reject?.(e); }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "overlaps", "order", "limit", "contains"]) {
        chain[m] = (...args: any[]) => { q.filters.push([m, ...args]); return chain; };
      }
      return chain;
    },
  };
}

const SHIFT = "e0000000-0000-4000-8000-00000000000e";
const JOB = "d0000000-0000-4000-8000-00000000000d";
const ERIK = "erik-1";
const BRIAN = "brian-1";

/** Erik's 7/17 shift on J-033, closed, never paid (he is the owner: paid by draw). */
const stored = {
  job_id: JOB,
  clock_in: "2026-07-17T17:30:00Z",
  clock_out: "2026-07-17T22:30:00Z",
  lunch_minutes: 30,
  rate_override: null,
  profile_id: ERIK,
  miles: 0,
  paid_at: null,
  mileage_paid_at: null,
  auto_closed_reason: null,
  status: "closed",
  split_from: null,
  profiles: { full_name: "Erik Taylor" },
};
const edit = { id: SHIFT, clock_in: stored.clock_in, clock_out: stored.clock_out, lunch_minutes: 30, job_id: JOB, job_code: null, notes: "" };
const INV048 = { id: "inv-048", invoice_number: "INV-048", status: "paid", created_at: "2026-07-31T00:00:00Z" };

let calls: Q[] = [];
beforeEach(() => {
  calls = [];
});

/** The reads updateTimeEntry makes, with `claimedBy` the invoice whose line holds the shift (or none). */
function route(claimedBy: typeof INV048 | null) {
  return (q: Q): Reply => {
    if (q.table === "time_entries" && q.verb === "select" && q.cols.startsWith("job_id, clock_in")) return { data: stored };
    if (q.table === "time_entries" && q.verb === "select" && q.cols === "id") return { data: [] }; // no split pieces
    if (q.table === "time_entries" && q.verb === "select" && q.cols === "id, clock_in, clock_out") return { data: [] }; // a clear day
    if (q.table === "invoice_items" && q.verb === "select") return { data: claimedBy ? [{ source_ids: [SHIFT], invoices: claimedBy }] : [] };
    if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: SHIFT }] };
  };
}

describe("a shift an invoice bills stays with its person", () => {
  it("handing Erik's billed shift to Brian is refused, names the invoice, and writes nothing", async () => {
    state.client = fakeSupabase(route(INV048), calls);
    const r = await updateTimeEntry({ ...edit, profile_id: BRIAN });
    expect(r).toEqual({ ok: false, error: claimedPersonRefusal({ id: "inv-048", invoice_number: "INV-048" }, "Erik Taylor") });
    expect(r.error).toBe(
      "INV-048 already bills this shift as Erik Taylor's hours — void or adjust that invoice before handing the shift to someone else. Nothing was changed.",
    );
    expect(calls.some((c) => c.verb === "update")).toBe(false);
    // The claim was looked up by the shift's own id, void invoices left out (a void line bills nothing).
    const claimRead = calls.find((c) => c.table === "invoice_items")!;
    expect(claimRead.filters).toContainEqual(["overlaps", "source_ids", [SHIFT]]);
    expect(claimRead.filters).toContainEqual(["neq", "invoices.status", "void"]);
  });

  it("a shift no invoice bills is handed over as before", async () => {
    state.client = fakeSupabase(route(null), calls);
    const r = await updateTimeEntry({ ...edit, profile_id: BRIAN });
    expect(r).toEqual({ ok: true });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.table).toBe("time_entries");
    expect(upd.payload.profile_id).toBe(BRIAN);
  });

  it("a billed shift keeps taking the edits that leave its person alone (notes, the same person re-sent)", async () => {
    state.client = fakeSupabase(route(INV048), calls);
    const r = await updateTimeEntry({ ...edit, notes: "panel swap", profile_id: ERIK });
    expect(r).toEqual({ ok: true });
    const upd = calls.find((c) => c.verb === "update")!;
    expect(upd.payload.notes).toBe("panel swap");
  });
});
