import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE WRITE-UP PILE READS THE ESTIMATE LINKS OF ITS OWN VISITS (cn-v1180, audit E5). Needs You's
 * Inspections to Write Up decided "already written up" from every estimate of the company, read
 * unordered and cut at 2,000. Past that, a visit whose estimate fell outside the cut asked to be
 * written up here while the Inspections page, which reads its links whole, filed it. The links are read
 * now with `in` on the visits' leads, jobs and capture ids, chunked and paged, so nothing is cut.
 *
 * THE FAKE DATABASE HONOURS WHAT A READ ASKS FOR: eq / is / in / neq / the day window on each row, the
 * order, `range` pages and `limit`, so an estimate is found only when the QUERY reaches it.
 */
type Call = [method: string, ...args: unknown[]];
type ReadLog = { table: string; cols: string; calls: Call[] };

const state = vi.hoisted(() => ({
  visits: [] as any[],
  quotes: [] as any[],
  failQuotes: false,
  reads: [] as { table: string; cols: string; calls: [string, ...unknown[]][] }[],
  reportError: vi.fn(),
}));

const when = (v: unknown) => Date.parse(String(v));

function keeps(row: Record<string, unknown>, [method, col, val]: Call): boolean {
  if (method === "or") {
    // The write-up read's one arm: outcome.is.null,outcome.eq.won.
    return String(col)
      .split(",")
      .some((a) => {
        const [c, op, v] = a.split(".");
        return op === "is" ? (row[c] ?? null) === null : String(row[c]) === v;
      });
  }
  const v = row[String(col)];
  if (method === "neq") return v !== val;
  if (method === "eq") return v === val;
  if (method === "is") return val === null ? v === null || v === undefined : v === val;
  if (method === "in") return (val as unknown[]).includes(v);
  if (method === "gte") return when(v) >= when(val);
  if (method === "lte") return when(v) <= when(val);
  if (method === "lt") return when(v) < when(val);
  return true;
}

function answer(read: ReadLog): { data: any; count: number; error: unknown } {
  if (read.table === "profiles") return { data: { org_id: "org-1", role: "owner" }, count: 1, error: null };
  const source = read.table === "appointments" ? state.visits : read.table === "quotes" ? state.quotes : null;
  if (!source) return { data: [], count: 0, error: null };
  if (read.table === "quotes" && state.failQuotes) return { data: null, count: 0, error: { code: "57014", message: "timeout" } };
  let rows = source.filter((r) => read.calls.every((c) => keeps(r, c)));
  const order = read.calls.find((c) => c[0] === "order") as [string, string, { ascending?: boolean }?] | undefined;
  if (order) {
    const dir = order[2]?.ascending === false ? -1 : 1;
    const key = order[1];
    rows = [...rows].sort((a, b) => dir * (key === "id" ? String(a.id).localeCompare(String(b.id)) : when(a[key]) - when(b[key])));
  }
  const count = rows.length;
  const range = read.calls.find((c) => c[0] === "range");
  if (range) rows = rows.slice(Number(range[1]), Number(range[2]) + 1);
  const limit = read.calls.find((c) => c[0] === "limit");
  return { data: limit ? rows.slice(0, Number(limit[1])) : rows, count, error: null };
}

function fakeClient() {
  const chain = (table: string) => {
    const read: ReadLog = { table, cols: "", calls: [] };
    state.reads.push(read);
    const q: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const { data, count, error } = answer(read);
            return (ok: any, err: any) => Promise.resolve({ data, error, count }).then(ok, err);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              const { data, error } = answer(read);
              return { data: Array.isArray(data) ? (data[0] ?? null) : data, error };
            };
          }
          if (prop === "select") {
            return (c?: string) => {
              read.cols = c ?? "";
              return q;
            };
          }
          return (...args: unknown[]) => {
            read.calls.push([prop, ...args]);
            return q;
          };
        },
      },
    );
    return q;
  };
  return { from: (table: string) => chain(table), rpc: () => chain("rpc") };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeClient() }));
vi.mock("@/lib/observe", () => ({ reportError: state.reportError }));

import { getActionItems } from "./query";

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();
const NOTES = { notes: "Larkspur deck, 12 boards to replace.", measurements: "", materials: "", photos: [] };

/** A sales inspection that happened three days ago, with notes on it: a write-up row unless an estimate links it. */
const visit = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: "inspection",
  title: `Visit ${id}`,
  starts_at: daysAgo(3),
  status: "completed",
  job_id: null,
  inquiry_id: null,
  customer_id: null,
  assigned_to: "tech-1",
  absorbed: false,
  location: null,
  capture: NOTES,
  outcome: null,
  customers: { name: "Sam Tillery" },
  inquiries: null,
  ...over,
});

/** 2,500 estimates of other leads, written first, and then the one that answers the visit. */
const crowd = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `q-${String(i).padStart(5, "0")}`, inquiry_id: `lead-other-${i}`, job_id: null }));

beforeEach(() => {
  state.visits = [];
  state.quotes = [];
  state.failQuotes = false;
  state.reads = [];
  state.reportError.mockClear();
});

const office = () => getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
const writeUps = async () =>
  (await office()).now
    .flatMap((i) => i.children ?? [i])
    .filter((i) => i.kind === "inspection_writeup")
    .map((i) => i.id)
    .sort();

describe("the write-up pile reads the estimate links of its own visits, whole", () => {
  it("control: with no estimate the visits ask to be written up", async () => {
    state.visits = [visit("v-lead", { inquiry_id: "lead-9" }), visit("v-capture", { capture: { ...NOTES, quote_id: "q-zz-capture" } })];
    state.quotes = crowd(10);
    expect(await writeUps()).toEqual(["v-capture", "v-lead"]);
  });

  it("an estimate written after 2,500 others still files its visit, by its lead and by the capture's own id", async () => {
    state.visits = [visit("v-lead", { inquiry_id: "lead-9" }), visit("v-capture", { capture: { ...NOTES, quote_id: "q-zz-capture" } })];
    state.quotes = [...crowd(2500), { id: "q-zz-lead", inquiry_id: "lead-9", job_id: null }, { id: "q-zz-capture", inquiry_id: null, job_id: null }];
    expect(await writeUps()).toEqual([]);
  });

  it("the read names the visits in play: `in` on their leads and capture ids, never an unfiltered cut", async () => {
    state.visits = [visit("v-lead", { inquiry_id: "lead-9" }), visit("v-capture", { capture: { ...NOTES, quote_id: "q-zz-capture" } })];
    await office();
    const quoteReads = state.reads.filter((r) => r.table === "quotes" && r.cols === "id, inquiry_id, job_id");
    expect(quoteReads.length).toBeGreaterThan(0);
    for (const r of quoteReads) {
      expect(r.calls.some((c) => c[0] === "in"), JSON.stringify(r.calls)).toBe(true);
      expect(r.calls.some((c) => c[0] === "limit")).toBe(false);
    }
    expect(quoteReads.map((r) => r.calls.find((c) => c[0] === "in"))).toEqual(
      expect.arrayContaining([
        ["in", "inquiry_id", ["lead-9"]],
        ["in", "id", ["q-zz-capture"]],
      ]),
    );
  });

  it("a failed read is filed and links nothing: the visit is offered, never hidden on a guess", async () => {
    state.visits = [visit("v-lead", { inquiry_id: "lead-9" })];
    state.quotes = [{ id: "q-zz-lead", inquiry_id: "lead-9", job_id: null }];
    state.failQuotes = true;
    expect(await writeUps()).toContain("v-lead");
    expect(state.reportError).toHaveBeenCalledWith("action-items.writeUp.estimateLinks", expect.anything());
  });
});
