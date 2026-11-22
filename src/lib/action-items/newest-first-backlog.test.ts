import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A BACKLOG PAST THE CAP NEVER HIDES THIS MONTH'S ROWS (skeptic #78, cn-v1175). Visits to Close Out
 * reads CLOSE_OUT_READ visits and Estimates Not Sent reads DRAFTS_READ drafts. Read OLDEST first, a
 * company with more old rows than the cap never read this month's at all: the board's half of the pile
 * was empty and nothing said so. Both reads are NEWEST first now, so only the Older fold's half can be
 * short, and it is the one that carries the "+".
 *
 * The fake database applies the filters it is sent (eq, is, in, the day window, the order and the
 * limit, the exact count taken before the limit), as the one in answered-visit-leaves-close-out does.
 */

type Call = [method: string, ...args: unknown[]];
type ReadLog = { table: string; cols: string; calls: Call[] };

const state = vi.hoisted(() => ({ visits: [] as any[], drafts: [] as any[], booksStart: null as string | null }));

vi.mock("@/app/(app)/bills/supplier-papers", async (orig) => ({
  ...(await orig<typeof import("@/app/(app)/bills/supplier-papers")>()),
  // The books' first day reaches back far enough for a visit to wait thirty days (the read's floor).
  readBooksStart: async () => state.booksStart,
}));

const when = (v: unknown) => Date.parse(String(v));

function topLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function arm(row: Record<string, unknown>, a: string): boolean {
  if (a.startsWith("and(")) return topLevel(a.slice(4, -1)).every((x) => arm(row, x));
  if (a.startsWith("or(")) return topLevel(a.slice(3, -1)).some((x) => arm(row, x));
  const [col, ...rest] = a.split(".");
  const op = rest.join(".");
  const v = row[col] ?? null;
  const list = (s: string) => s.slice(s.indexOf("(") + 1, -1).split(",");
  if (op.startsWith("not.in.")) return v !== null && !list(op).includes(String(v));
  if (op.startsWith("in.")) return list(op).includes(String(v));
  if (op === "is.null") return v === null;
  if (op.startsWith("eq.")) return String(v) === op.slice(3);
  throw new Error(`the fake was never taught ${a}`);
}

function keeps(row: Record<string, unknown>, [method, col, val]: Call): boolean {
  if (method === "or") return topLevel(String(col)).some((a) => arm(row, a));
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

function answer(read: ReadLog): { data: any; count: number } {
  if (read.table === "profiles") return { data: { org_id: "org-1", role: "owner" }, count: 1 };
  const source = read.table === "appointments" ? state.visits : read.table === "quotes" ? state.drafts : null;
  if (!source) return { data: [], count: 0 };
  let rows = source.filter((r) => read.calls.every((c) => keeps(r, c)));
  const order = read.calls.find((c) => c[0] === "order") as [string, string, { ascending?: boolean }?] | undefined;
  if (order) {
    const dir = order[2]?.ascending === false ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * (when(a[order[1]]) - when(b[order[1]])));
  }
  const count = rows.length;
  const limit = read.calls.find((c) => c[0] === "limit");
  return { data: limit ? rows.slice(0, Number(limit[1])) : rows, count };
}

function fakeClient() {
  const chain = (table: string) => {
    const read: ReadLog = { table, cols: "", calls: [] };
    const q: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const { data, count } = answer(read);
            return (ok: any, err: any) => Promise.resolve({ data, error: null, count }).then(ok, err);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              const { data } = answer(read);
              return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
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
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { getActionItems, CLOSE_OUT_READ, CLOSE_OUT_DRAWN, DRAFTS_READ, DRAFTS_DRAWN } = await import("./query");

const TZ = "America/Los_Angeles";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();
const dayStr = (n: number) => daysAgo(n).slice(0, 10);

/** A service call nobody closed out, `n` days ago. */
const callOut = (id: string, n: number) => ({
  id,
  type: "service_call",
  title: `Visit ${id}`,
  starts_at: daysAgo(n),
  status: "scheduled",
  job_id: null,
  inquiry_id: null,
  assigned_to: "tech-1",
  absorbed: false,
  outcome: null,
  customers: { name: "Sam Tillery" },
  jobs: null,
});

/** An estimate written `n` days ago and never sent. */
const draft = (id: string, n: number) => ({
  id,
  quote_number: `E-9${id}`,
  title: "Larkspur Panel",
  status: "draft",
  total: 1200,
  created_at: daysAgo(n),
  job_id: null,
  inquiry_id: null,
  jobs: null,
  quote_line_items: [{ count: 3 }],
  customer_name_snapshot: { name: "Dana Rook" },
  inquiries: null,
});

beforeEach(() => {
  state.visits = [];
  state.drafts = [];
  state.booksStart = dayStr(120);
});

const office = () => getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: TZ });
const pile = (rows: { id: string; title: string; children?: { id: string }[] }[], id: string) => rows.find((r) => r.id === id);

describe("Visits to Close Out: a backlog past the cap (newest first)", () => {
  it("still draws this month's visits, counted true; only the Older half is short and carries the '+'", async () => {
    // 20 this month, 230 from 31 to 110 days ago: 250 in all, past CLOSE_OUT_READ (200).
    const fresh = Array.from({ length: 20 }, (_, i) => callOut(`f${i}`, 1 + (i % 10)));
    const old = Array.from({ length: 230 }, (_, i) => callOut(`o${i}`, 31 + (i % 80)));
    state.visits = [...old, ...fresh];
    expect(state.visits.length).toBeGreaterThan(CLOSE_OUT_READ);
    const r = await office();
    const board = pile(r.now as any, "pile:visits_to_close_out");
    expect(board, "this month's visits are on the board").toBeTruthy();
    expect(board!.title).toBe("Visits to Close Out · 20");
    expect(board!.children!.map((c) => c.id).sort()).toEqual(fresh.map((v) => v.id).sort());
    const fold = pile(r.older as any, "pile:visits_to_close_out:older");
    expect(fold, "the old ones are in the Older fold").toBeTruthy();
    expect(fold!.title).toMatch(/ · \d+\+$/);
    expect(fold!.children!.length).toBeLessThanOrEqual(CLOSE_OUT_DRAWN);
  });
});

describe("Estimates Not Sent: a backlog past the cap (newest first)", () => {
  it("still draws this month's drafts, counted true; only the Older half is short and carries the '+'", async () => {
    const fresh = Array.from({ length: 6 }, (_, i) => draft(`1${i}`, 3 + i));
    const old = Array.from({ length: 170 }, (_, i) => draft(`5${i}`, 31 + i));
    state.drafts = [...old, ...fresh];
    expect(state.drafts.length).toBeGreaterThan(DRAFTS_READ);
    const r = await office();
    const freshRows = (r.now as any[]).flatMap((i) => i.children ?? [i]).filter((i) => i.kind === "quote_draft");
    expect(freshRows.map((i) => i.id).sort()).toEqual(fresh.map((d) => `qdraft-${d.id}`).sort());
    expect(freshRows.every((i) => !i.older)).toBe(true);
    const fold = pile(r.older as any, "pile:estimates_not_sent:older");
    expect(fold, "the old drafts are in the Older fold").toBeTruthy();
    expect(fold!.title).toMatch(/ · \d+\+$/);
    expect(fold!.children!.length).toBeLessThanOrEqual(DRAFTS_DRAWN);
  });
});

describe("the push order does not matter: the board is sorted after the rows are drawn", () => {
  it("the same rows read in either order draw the same board, in the same order", async () => {
    const rows = [callOut("a", 2), callOut("b", 5), callOut("c", 9)];
    state.visits = rows;
    const one = (await office()).now;
    state.visits = [...rows].reverse();
    const two = (await office()).now;
    const ids = (n: any[]) => n.flatMap((i) => [i.id, ...(i.children ?? []).map((c: any) => c.id)]);
    expect(ids(two as any[])).toEqual(ids(one as any[]));
    // And within the pile, sortActionItems' order: oldest first, whatever the read's order was.
    const kids = pile(one as any, "pile:visits_to_close_out")!.children!.map((c) => c.id);
    expect(kids).toEqual(["c", "b", "a"]);
  });

  it("in the source: both reads are newest first and both splits say so", () => {
    const q = readFileSync(join(process.cwd(), "src/lib/action-items/query.ts"), "utf8");
    const appt = q.slice(q.indexOf("const apptP"), q.indexOf("const inspP"));
    expect(appt).toContain('q.order("starts_at", { ascending: false }).limit(isStaff ? CLOSE_OUT_READ : CLOSE_OUT_DRAWN)');
    expect(q).toMatch(/\.eq\("status", "draft"\)[\s\S]{0,300}\.order\("created_at", \{ ascending: false \}\)[\s\S]{0,300}\.limit\(DRAFTS_READ\)/);
    expect(q).toContain('splitKeptCount(apptR, closeOutKept, CLOSE_OUT_DRAWN, "newestFirst",');
    expect(q).toContain('splitKeptCount(draftQuoteR, draftsKept, DRAFTS_DRAWN, "newestFirst",');
    expect(q).toContain('splitKeptCount(inspR, writeUpKept, null, "newestFirst",');
    expect(q).not.toContain('"oldestFirst"');
  });
});
