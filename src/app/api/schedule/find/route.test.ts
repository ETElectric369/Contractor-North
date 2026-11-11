import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADD TO SCHEDULE'S SEARCH ON THE SERVER (cn-v1159; Erik, 2026-11-10: "it wont let me add to schedule
 * unless its an open job not even an address or a person as it states it can find"). The route, against
 * a stand-in for the database that answers the way PostgREST does for the filters this route sends: an
 * `or` of ilikes on one word, an `in` on the status and on the customer ids, a limit. What is proven is
 * the route's own work: the office only, the words in the body, one word asked and every word matched,
 * a person's finished jobs reached through the customer, the caps, and a failed read said as a failure.
 */
type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  staff: true,
  jobs: [] as Row[],
  customers: [] as Row[],
  asked: [] as { table: string; or?: string; ins: Record<string, unknown[]>; limit?: number }[],
  fail: "" as "" | "jobs" | "customers",
}));

function builder(table: string) {
  const q = { table, or: undefined as string | undefined, ins: {} as Record<string, unknown[]>, limit: undefined as number | undefined };
  const run = () => {
    state.asked.push(q);
    if (state.fail === table) return { data: null, error: { message: "timeout" } };
    let rows: Row[] = table === "jobs" ? state.jobs : table === "customers" ? state.customers : [];
    for (const [col, vals] of Object.entries(q.ins)) rows = rows.filter((r) => vals.includes(r[col]));
    if (q.or) {
      // "name.ilike.%word%,address.ilike.%word%": any named column holds the word, case-blind.
      const parts = q.or.split(",").map((p) => p.match(/^([a-z_]+)\.ilike\.%(.*)%$/));
      rows = rows.filter((r) => parts.some((m) => m && String(r[m[1]] ?? "").toLowerCase().includes(m[2].toLowerCase())));
    }
    return { data: rows.slice(0, q.limit ?? rows.length).map((r) => ({ ...r })), error: null };
  };
  const b: any = {
    select: () => b,
    in: (col: string, vals: unknown[]) => ((q.ins[col] = vals), b),
    or: (f: string) => ((q.or = f), b),
    order: () => b,
    limit: (n: number) => ((q.limit = n), b),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: async () => (state.staff ? { supabase: { from: (t: string) => builder(t) }, userId: "office-1", orgId: "org-1", role: "owner" } : { error: "This action is staff-only." }),
}));

const { POST } = await import("./route");
const ask = async (q: unknown) => {
  const res = await POST(new Request("https://app.test/api/schedule/find", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q }) }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; jobs?: Row[]; customers?: Row[]; more?: boolean } };
};

beforeEach(() => {
  state.staff = true;
  state.fail = "";
  state.asked = [];
  state.customers = [
    { id: "c-rook", name: "Dana Rook", company_name: null, address: "9 Bayberry Ct", unit: null, city: "Truckee" },
    { id: "c-loam", name: "Casey Loam", company_name: "Catbird Builders", address: "77 Thistlewood Way", unit: null, city: "Kings Beach" },
  ];
  state.jobs = [
    { id: "done", name: "41 Larkspur Ln", status: "complete", address: "41 Larkspur Ln", unit: "5", city: "Truckee", job_number: "J-045", customer_id: "c-rook", customers: { name: "Dana Rook" } },
    { id: "off", name: "Panel Upgrade", status: "cancelled", address: "12 Snowbell Rd", unit: null, city: "Truckee", job_number: "J-050", customer_id: "c-loam", customers: { name: "Casey Loam" } },
    { id: "live", name: "41 Larkspur Ln", status: "in_progress", address: "41 Larkspur Ln", unit: "5", city: "Truckee", job_number: "J-064", customer_id: "c-rook", customers: { name: "Dana Rook" } },
  ];
});

describe("who may ask, and how", () => {
  it("the office only: anyone else is refused before anything is read", async () => {
    state.staff = false;
    expect(await ask("larkspur")).toEqual({ status: 403, body: { ok: false } });
    expect(state.asked).toEqual([]);
  });

  it("nothing long enough to ask with reads nothing; a body that is not JSON is nothing asked", async () => {
    expect(await ask("5")).toEqual({ status: 200, body: { ok: true, jobs: [], customers: [], more: false } });
    expect(await ask("")).toEqual({ status: 200, body: { ok: true, jobs: [], customers: [], more: false } });
    const res = await POST(new Request("https://app.test/api/schedule/find", { method: "POST", body: "not json" }));
    expect(await res.json()).toEqual({ ok: true, jobs: [], customers: [], more: false });
    expect(state.asked).toEqual([]);
  });

  it("the route file exports its handler and its runtime, nothing else, and takes the words in the BODY", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/schedule/find/route.ts"), "utf8");
    expect(src.match(/^export\s+(?:async\s+function|const|function)\s+(\w+)/gm)?.map((m) => m.split(/\s+/).pop())).toEqual(["runtime", "POST"]);
    expect(src).not.toMatch(/searchParams/);
    expect(src).toContain("const ctx = await requireStaff();");
    // No money column is ever named.
    expect(src).not.toMatch(/\b(total|amount|price|cost|rate|balance)\w*\b(?=[^"]*")/i);
  });
});

describe("what it finds", () => {
  it("a street whose job is finished: found; the job still in flight at the same street is the sheet's own list, never this one", async () => {
    const r = await ask("larkspur");
    expect(r.body.jobs?.map((j) => j.id)).toEqual(["done"]);
    expect(r.body.jobs?.[0]).toMatchObject({ status: "complete", address: "41 Larkspur Ln", unit: "5" });
    expect(r.body.customers).toEqual([]);
    // Every jobs read is limited to the statuses that ended a job.
    for (const q of state.asked.filter((a) => a.table === "jobs")) expect(q.ins.status).toEqual(["complete", "cancelled"]);
  });

  it("a person: the customer, and their finished jobs reached through them (the name is not on the job)", async () => {
    const r = await ask("rook");
    expect(r.body.customers?.map((c) => c.id)).toEqual(["c-rook"]);
    expect(r.body.jobs?.map((j) => j.id)).toEqual(["done"]);
    // Every column a customer is matched on is asked of the database, the unit included.
    expect(state.asked.find((a) => a.table === "customers")?.or).toBe("name.ilike.%rook%,company_name.ilike.%rook%,address.ilike.%rook%,unit.ilike.%rook%,city.ilike.%rook%");
    const second = state.asked.filter((a) => a.table === "jobs")[1];
    expect(second.ins.customer_id).toEqual(["c-rook"]);
  });

  it("one word is asked of the database (the longest); every word is matched on what came back", async () => {
    const r = await ask("12 Snowbell loam");
    expect(state.asked[0].or).toBe("name.ilike.%snowbell%,address.ilike.%snowbell%,unit.ilike.%snowbell%,city.ilike.%snowbell%,job_number.ilike.%snowbell%");
    expect(r.body.jobs?.map((j) => j.id)).toEqual(["off"]);
    // The same street with another person's name is nothing.
    expect((await ask("snowbell rook")).body.jobs).toEqual([]);
  });

  it("nothing typed can reach the filter as grammar: commas, brackets, wildcards, quotes and dots are gone before it is built", async () => {
    await ask('larkspur),status.eq.in_progress,(name.ilike.%"');
    for (const q of state.asked) expect(q.or ?? "").not.toMatch(/[()"]|status\.eq/);
    expect(state.asked[0].or).toContain("name.ilike.%in_progress%");
  });

  it("a company, a town, a job number", async () => {
    expect((await ask("catbird")).body.customers?.map((c) => c.id)).toEqual(["c-loam"]);
    expect((await ask("kings beach")).body.customers?.map((c) => c.id)).toEqual(["c-loam"]);
    expect((await ask("J-045")).body.jobs?.map((j) => j.id)).toEqual(["done"]);
  });
});

describe("bounded, and never short in silence", () => {
  it("more than the list shows says so; each read is limited", async () => {
    state.jobs = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, name: `${i} Thistlewood Way`, status: "complete", address: `${i} Thistlewood Way`, city: "Truckee", customer_id: null, customers: null }));
    const r = await ask("thistlewood");
    expect(r.body.jobs).toHaveLength(12);
    expect(r.body.more).toBe(true);
    for (const q of state.asked) expect(q.limit).toBe(60);
    // A short list is the whole answer.
    state.jobs = state.jobs.slice(0, 3);
    expect((await ask("thistlewood")).body).toMatchObject({ more: false });
  });

  it("a read that fails is a failure, never an empty answer", async () => {
    state.fail = "jobs";
    expect(await ask("larkspur")).toEqual({ status: 500, body: { ok: false } });
    state.fail = "customers";
    expect(await ask("larkspur")).toEqual({ status: 500, body: { ok: false } });
  });
});
