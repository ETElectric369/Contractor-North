import { describe, it, expect, vi, beforeEach } from "vitest";
import { saleHasMoney } from "./due-filters";

/**
 * A PAYMENT REQUEST IS NEVER CHASED BY AGE, AND IS MONEY ON A JOB ONLY ONCE SOMETHING WAS PAID ON IT
 * (cn-v1178, E3 and E4's tail; the owner's decision 5).
 *
 *   E3  Needs You's Late Invoices read took every unpaid bill with no due date, 30 days after it was
 *       made, as late. A request has no due date on purpose: it turned up as late at day 30 and as a red
 *       NOW row at day 60, while Billing never called it late. The read leaves it out, IN the read, so
 *       the pile's count is still the count of its rows.
 *   E4  A job whose every estimate was declined, with no time and no bill on it, stops asking for a day
 *       (the sale went away). An unpaid deposit request counted as "a bill" and kept it asking. It
 *       counts now only once money was paid on it.
 *
 * The fake database answers each read by the filters it is sent (eq, neq, in, is, the day window, the
 * or() arms, order, limit, an exact count before the limit), as newest-first-backlog's does.
 */
type Call = [method: string, ...args: unknown[]];
type ReadLog = { table: string; cols: string; calls: Call[] };
const state = vi.hoisted(() => ({ tables: {} as Record<string, any[]>, booksStart: null as string | null }));

vi.mock("@/app/(app)/bills/supplier-papers", async (orig) => ({
  ...(await orig<typeof import("@/app/(app)/bills/supplier-papers")>()),
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
  if (op.startsWith("lte.")) return v !== null && when(v) <= when(op.slice(4));
  if (op.startsWith("lt.")) return v !== null && when(v) < when(op.slice(3));
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
  const source = state.tables[read.table];
  if (!source) return { data: [], count: 0 };
  let rows = source.filter((r) => read.calls.every((c) => keeps(r, c)));
  const order = read.calls.find((c) => c[0] === "order") as [string, string, { ascending?: boolean }?] | undefined;
  if (order) {
    const dir = order[2]?.ascending === false ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * (when(a[order[1]]) - when(b[order[1]])));
  }
  const count = rows.length;
  const limit = read.calls.find((c) => c[0] === "limit" && c.length === 2);
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

const { getActionItems } = await import("./query");

const TZ = "America/Los_Angeles";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();

const bill = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
  id,
  invoice_number: id.toUpperCase(),
  invoice_kind: kind,
  total: 1000,
  amount_paid: 0,
  due_date: null,
  status: "sent",
  created_at: daysAgo(45),
  job_id: null,
  customers: { name: "Dana Rook" },
  ...over,
});

beforeEach(() => {
  state.tables = { invoices: [], jobs: [], quotes: [] };
  state.booksStart = new Date(Date.parse(`${TODAY}T20:00:00Z`) - 400 * 86_400_000).toISOString().slice(0, 10);
});

const office = () => getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: TZ });
const flat = (r: any) => [...(r.now ?? []), ...(r.older ?? [])].flatMap((i: any) => [i, ...(i.children ?? [])]);

describe("E3: Late Invoices never lists a payment request", () => {
  it("an undated request 45 days old is not late; an undated invoice the same age is, and the pile counts what it shows", async () => {
    state.tables.invoices = [
      bill("inv-900", "standard"),
      bill("inv-901", "standard", { created_at: daysAgo(50) }),
      bill("inv-902", "prepayment", { created_at: daysAgo(70) }),
    ];
    const r = await office();
    const pile = flat(r).find((i: any) => i.id === "pile:late_invoices");
    expect(pile?.children?.map((c: any) => c.id).sort()).toEqual(["inv-900", "inv-901"]);
    expect(flat(r).some((i: any) => i.id === "inv-902")).toBe(false);
    // A number agrees with its rows: the pile's title counts the two it draws, never the request.
    expect(pile?.title).toMatch(/ · 2$/);
  });
});

describe("E4: a job whose sale went away stops asking for a day, an unpaid request or not", () => {
  const job = (id: string) => ({
    id,
    job_number: `J-90${id.slice(-1)}`,
    name: "Larkspur Panel",
    status: "to_be_scheduled",
    scheduled_start: null,
    scheduled_end: null,
    created_at: daysAgo(10),
    blocked_on: null,
    blocked_since: null,
    customers: { name: "Sam Tillery" },
    job_schedule_segments: [],
    time_entries: [],
  });
  const asking = async () => flat(await office()).filter((i: any) => i.kind === "job_to_schedule").map((i: any) => i.id).sort();

  it("every estimate declined and only an unpaid deposit request on it: it stops asking", async () => {
    state.tables.jobs = [job("job-1")];
    state.tables.quotes = [{ id: "q-1", job_id: "job-1", status: "declined" }];
    state.tables.invoices = [bill("inv-903", "prepayment", { job_id: "job-1", created_at: daysAgo(5) })];
    expect(await asking()).toEqual([]);
  });

  it("money paid on the request is money on the job: it keeps asking", async () => {
    state.tables.jobs = [job("job-1")];
    state.tables.quotes = [{ id: "q-1", job_id: "job-1", status: "declined" }];
    state.tables.invoices = [bill("inv-903", "prepayment", { job_id: "job-1", status: "paid", amount_paid: 1000, created_at: daysAgo(5) })];
    expect(await asking()).toEqual(["job-1"]);
  });

  it("any other live bill keeps it asking, as it always did", async () => {
    state.tables.jobs = [job("job-1")];
    state.tables.quotes = [{ id: "q-1", job_id: "job-1", status: "declined" }];
    state.tables.invoices = [bill("inv-904", "deposit", { job_id: "job-1", created_at: daysAgo(5) })];
    expect(await asking()).toEqual(["job-1"]);
  });
});

describe("saleHasMoney, the rule", () => {
  it.each([
    ["a standard bill", { invoice_kind: "standard", amount_paid: 0 }, true],
    ["a draw", { invoice_kind: "deposit", amount_paid: 0 }, true],
    ["no kind (older rows)", { invoice_kind: null, amount_paid: 0 }, true],
    ["an unpaid request", { invoice_kind: "prepayment", amount_paid: 0 }, false],
    ["a request with nothing recorded", { invoice_kind: "prepayment", amount_paid: null }, false],
    ["a partly paid request", { invoice_kind: "prepayment", amount_paid: 250 }, true],
    ["a paid request, read as text", { invoice_kind: "prepayment", amount_paid: "1000.00" }, true],
  ] as const)("%s", (_n, row, want) => {
    expect(saleHasMoney(row)).toBe(want);
  });
});
