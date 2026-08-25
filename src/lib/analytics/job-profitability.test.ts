import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { laborCostForJob } from "@/lib/labor-billing";
import { computeJobProfitRows, computeProfitByType, isLaborBudgetLine, mergeBudgetActual, type JobProfitRow } from "@/lib/analytics/job-profitability";

describe("mergeBudgetActual — per-scope budget vs actual", () => {
  it("joins budget + actual by scope and flags over/under (the masked-overrun catch)", () => {
    const rows = mergeBudgetActual(
      [
        { category: "Framing", budget: 26510 },
        { category: "Decking", budget: 40350 },
        { category: "Demo", budget: 10500 },
      ],
      [
        { category: "Framing", actual: 48390 },
        { category: "Demo", actual: 25600 },
        // Decking not started → no actual row
      ],
    );
    const framing = rows.find((r) => r.category === "Framing")!;
    expect(framing.overBudget).toBe(true);
    expect(framing.burnPct).toBe(183); // 48390/26510
    expect(framing.remaining).toBe(26510 - 48390);
    const decking = rows.find((r) => r.category === "Decking")!;
    expect(decking.actual).toBe(0); // not started — the money hiding spot
    expect(decking.overBudget).toBe(false);
  });
  it("actual-only scope (e.g. an unbudgeted 'Uncategorized' spend) surfaces with null burnPct", () => {
    const rows = mergeBudgetActual([], [{ category: "Uncategorized", actual: 2286 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].budget).toBe(0);
    expect(rows[0].burnPct).toBeNull();
    expect(rows[0].overBudget).toBe(false);
  });
});

const job = (id: string, status = "in_progress") => ({ id, job_number: `J-${id}`, name: `Job ${id}`, status });
// a closed entry fully allocated to `jobId` for `hours` at pay rate `rate`
const laborEntry = (jobId: string, hours: number, rate: number) => ({
  job_id: jobId,
  status: "closed",
  profiles: { hourly_rate: rate },
  time_allocations: [{ job_id: jobId, hours }],
});
// a payment of `amount` on `jobId`'s invoice (THE cash definition — not invoices.amount_paid)
const pay = (jobId: string, amount: number, status = "paid") => ({ amount, invoices: { job_id: jobId, status } });
const empty = { jobs: [], payments: [], pos: [], bills: [], jobRefunds: [], entries: [], pettyCash: [] };

describe("computeJobProfitRows — job profit SSOT (reconciles /analytics + Nort)", () => {
  it("profit = revenue collected − (labor at pay rate + materials)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      bills: [{ job_id: "A", amount: 200 }],
      entries: [laborEntry("A", 8, 50)], // 8h × $50 = 400
    });
    expect(rows).toEqual([{ id: "A", job_number: "J-A", name: "Job A", status: "in_progress", rev: 1000, cost: 600, profit: 400 }]);
  });

  it("revenue is the PAYMENTS ledger, not invoices.amount_paid — a credit writeoff is no cash", () => {
    // The regression: amount_paid folds a non-cash account credit in, so a disputed invoice
    // written off as a credit used to inflate the job's revenue. With no payment row, it's $0.
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [], // the invoice's amount_paid was raised by a credit, not cash
      bills: [{ job_id: "A", amount: 50 }], // keeps the row past the zero-zero filter
    });
    expect(rows[0].rev).toBe(0);
  });

  it("nets refunds out of revenue (keyed via the invoice's job)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      jobRefunds: [{ amount: 150, invoices: { job_id: "A" } }],
    });
    expect(rows[0].rev).toBe(850);
    expect(rows[0].profit).toBe(850);
  });

  it("excludes void-invoice payments from revenue", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000, "void"), pay("A", 300, "paid")],
    });
    expect(rows[0].rev).toBe(300);
  });

  it("counts an UNLINKED PO and bill both — they're two separate costs until linked", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pos: [{ id: "po-1", job_id: "A", total: 100 }],
      bills: [{ job_id: "A", amount: 100, po_id: null }],
    });
    expect(rows[0].cost).toBe(200);
  });

  it("a bill that names its PO SUPERSEDES it — one delivery, counted once (0142)", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pos: [{ id: "po-1", job_id: "A", total: 2400, status: "received" }],
      bills: [{ job_id: "A", amount: 2400, po_id: "po-1" }],
    });
    expect(rows[0].cost).toBe(2400); // NOT 4800
  });

  it("a cancelled PO is not a cost, but a draft (the default) one IS", () => {
    // Per the 2026-07-20 re-review of livePurchaseOrders: only a KILLED (cancelled) order is
    // a non-cost; a PO the office left in the default 'draft' status is still real committed
    // material and must count, so the job hub can't under-report materials.
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pos: [
        { id: "po-1", job_id: "A", total: 500, status: "cancelled" },
        { id: "po-2", job_id: "A", total: 300, status: "draft" },
        { id: "po-3", job_id: "A", total: 200, status: "received" },
      ],
      bills: [],
    });
    expect(rows[0].cost).toBe(500); // 300 (draft) + 200 (received); cancelled excluded
  });

  it("only counts THIS job's allocated hours from a split shift", () => {
    // one shift split across two jobs; A's cost is only its 3 allocated hours
    const shift = {
      job_id: "OTHER",
      status: "closed",
      profiles: { hourly_rate: 40 },
      time_allocations: [{ job_id: "A", hours: 3 }, { job_id: "OTHER", hours: 5 }],
    };
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 500)],
      entries: [shift],
    });
    expect(rows[0].cost).toBe(120); // 3h × $40
  });

  it("drops jobs with zero revenue AND zero cost", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A"), job("EMPTY")],
      payments: [pay("A", 500)],
    });
    expect(rows.map((r) => r.id)).toEqual(["A"]);
  });

  it("ranks most-profitable first", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("LOW"), job("HIGH")],
      payments: [pay("LOW", 100), pay("HIGH", 900)],
    });
    expect(rows.map((r) => r.id)).toEqual(["HIGH", "LOW"]);
  });

  it("floors revenue at zero when refunds exceed collections", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 100)],
      bills: [{ job_id: "A", amount: 50 }], // keeps the row past the zero-zero filter
      jobRefunds: [{ amount: 300, invoices: { job_id: "A" } }],
    });
    expect(rows[0].rev).toBe(0);
    expect(rows[0].profit).toBe(-50);
  });
});

describe("computeProfitByType — margin by work type", () => {
  const row = (id: string, rev: number, cost: number): JobProfitRow => ({ id, job_number: `J-${id}`, name: `Job ${id}`, status: "complete", rev, cost, profit: rev - cost });

  it("groups jobs by type, sums money, computes margin %, sorts by profit", () => {
    const rows = [row("a", 1000, 600), row("b", 500, 450), row("c", 2000, 1000)];
    const typeOf = new Map([["a", "Panel swap"], ["b", "Panel swap"], ["c", "Service call"]]);
    const out = computeProfitByType(rows, typeOf);
    expect(out).toEqual([
      { type: "Service call", jobs: 1, revenue: 2000, cost: 1000, profit: 1000, marginPct: 50 },
      { type: "Panel swap", jobs: 2, revenue: 1500, cost: 1050, profit: 450, marginPct: 30 },
    ]);
  });

  it("jobs with no type fall under 'Uncategorized'; null margin when zero revenue", () => {
    const out = computeProfitByType([row("x", 0, 200)], new Map());
    expect(out).toEqual([{ type: "Uncategorized", jobs: 1, revenue: 0, cost: 200, profit: -200, marginPct: null }]);
  });
});

/**
 * BUDGET-VS-ACTUAL WAS COMPARING TWO DIFFERENT THINGS (audit v800 wave B).
 *
 * The budget summed every estimate line — labour included. The actual summed only bills and
 * purchase orders. So every scope read wildly under budget, and on a service job (mostly labour)
 * a job 90% through its hours reported as barely started. Production carried $141k of hourly
 * estimate lines against $0 of labour actual.
 */
describe("isLaborBudgetLine — which estimate lines are labour", () => {
  it("an hourly unit is labour — the signal that was 41-for-41 in production", () => {
    expect(isLaborBudgetLine({ unit: "hr", description: "Rough-in: home-run branch circuits" })).toBe(true);
    expect(isLaborBudgetLine({ unit: "hrs", description: "Back Steps (in ground Pressure Treated)" })).toBe(true);
    expect(isLaborBudgetLine({ unit: "Hours", description: "anything" })).toBe(true);
  });

  it("a flat-rate line that SAYS labour is labour — what the unit alone misses", () => {
    // Real row: "Labor - 2 guys for one full day", unit ea, $2,000.
    expect(isLaborBudgetLine({ unit: "ea", description: "Labor - 2 guys for one full day" })).toBe(true);
    expect(isLaborBudgetLine({ unit: "ea", description: "Labour and materials" })).toBe(true);
  });

  it("materials are not labour", () => {
    expect(isLaborBudgetLine({ unit: "ea", description: "200A panel, flush mount" })).toBe(false);
    expect(isLaborBudgetLine({ unit: "LF", description: "Composite decking" })).toBe(false);
    expect(isLaborBudgetLine({ unit: "", description: "Permit fee" })).toBe(false);
  });

  it("does not fire on a word that merely contains 'labor'", () => {
    // Word-boundary matched, so a product name can't drag a materials line into the labour row.
    expect(isLaborBudgetLine({ unit: "ea", description: "Elaborate trim package" })).toBe(false);
    expect(isLaborBudgetLine({ unit: "ea", description: "Collaborative design fee" })).toBe(false);
  });

  it("survives nulls without throwing on a half-filled line", () => {
    expect(isLaborBudgetLine({})).toBe(false);
    expect(isLaborBudgetLine({ unit: null, description: null })).toBe(false);
  });
});

describe("mergeBudgetActual — labour compares against labour", () => {
  it("labour now has a counterpart instead of reading 0% spent", () => {
    const rows = mergeBudgetActual(
      [{ category: "Labor", budget: 10000 }, { category: "Decks", budget: 4000 }],
      [{ category: "Labor", actual: 9200 }, { category: "Decks", actual: 3100 }],
    );
    const labor = rows.find((r) => r.category === "Labor")!;
    expect(labor).toMatchObject({ budget: 10000, actual: 9200, remaining: 800, burnPct: 92, overBudget: false });
  });

  it("catches labour running hot — the case that used to be invisible", () => {
    const rows = mergeBudgetActual([{ category: "Labor", budget: 5000 }], [{ category: "Labor", actual: 7400 }]);
    expect(rows[0]).toMatchObject({ burnPct: 148, overBudget: true, remaining: -2400 });
  });

  it("a misfiled line moves a row but NEVER the totals — the safe failure mode", () => {
    // An hourly equipment rental booked as labour is the heuristic's known blind spot. It shifts
    // $800 between two rows that are both on screen; the job's totals are identical either way.
    const asLabor = mergeBudgetActual(
      [{ category: "Labor", budget: 5800 }, { category: "Decks", budget: 4000 }], [],
    );
    const asMaterials = mergeBudgetActual(
      [{ category: "Labor", budget: 5000 }, { category: "Decks", budget: 4800 }], [],
    );
    const total = (rs: { budget: number }[]) => rs.reduce((s, r) => s + r.budget, 0);
    expect(total(asLabor)).toBe(total(asMaterials));
    expect(total(asLabor)).toBe(9800);
  });
});

/**
 * PETTY CASH IS COST (audit v800 wave B). A tech buys 35 ft of 10/3 Romex out of the tin and tags
 * it to the job — a real production row — and every profit reader in the app ignored it. The job
 * read more profitable by exactly the amount that had left the business.
 */
describe("computeJobProfitRows — petty cash finally counts", () => {
  it("a job-linked petty-cash expense is job cost", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pettyCash: [{ job_id: "A", amount: 90, kind: "expense" }],
    });
    expect(rows[0].cost).toBe(90);
    expect(rows[0].profit).toBe(910);
  });

  it("a REPLENISH is a transfer, not a cost — counting it would double-count the same dollars", () => {
    // Refilling the tin is money moving between two of your own pockets. Booking it as job cost
    // charges the job once when the tin is filled and again when the tech spends it.
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pettyCash: [
        { job_id: "A", amount: 90, kind: "expense" },
        { job_id: "A", amount: 500, kind: "replenish" },
      ],
    });
    expect(rows[0].cost).toBe(90);
  });

  it("adds on top of materials and labour rather than replacing them", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 2000)],
      bills: [{ job_id: "A", amount: 200 }],
      entries: [laborEntry("A", 8, 50)], // $400
      pettyCash: [{ job_id: "A", amount: 90, kind: "expense" }],
    });
    expect(rows[0].cost).toBe(690);
  });

  it("petty cash with no job is overhead and never lands on a job", () => {
    const rows = computeJobProfitRows({
      ...empty,
      jobs: [job("A")],
      payments: [pay("A", 1000)],
      pettyCash: [{ job_id: null, amount: 379.35, kind: "expense" }],
    });
    expect(rows[0].cost).toBe(0);
  });
});

/**
 * THE PROJECTION LAW, ON THE FIX FOR THE PROJECTION LAW (audit v824).
 *
 * cn-v821 added a Labor row to both sides of budget-vs-actual and fed the actual side with
 * `.from("time_entries").select("*")`. In PostgREST `*` is THIS TABLE'S COLUMNS — it does not
 * expand embeds. So the rows reached laborCostForJob carrying no `profiles` (no pay rate) and no
 * `time_allocations` (no split), every hour priced at $0, and the Labor row read `actual: 0` on
 * every job in every tenant. The commit claimed the two readers "can never report two different
 * labour numbers" and was false in the same breath that made it.
 *
 * It was silent because laborCostForJob is entirely input-driven: hand it rows with no embeds and
 * it returns a confident $0 rather than an error. The first test below pins that behaviour so the
 * silence is documented; the second pins the projection itself, which is the only thing that
 * actually prevents recurrence — a unit test on the helper can never catch a bad query.
 */
describe("laborCostForJob is input-driven — a thin projection returns a confident $0", () => {
  it("prices every hour at zero when the profiles embed is missing", () => {
    // Exactly the shape `select("*")` returns: real columns, no embeds.
    const bare = [{ job_id: "A", clock_in: "2026-08-01T08:00:00Z", clock_out: "2026-08-01T16:00:00Z", status: "closed" }];
    const out = laborCostForJob(bare as never[], "A");
    expect(out.cost).toBe(0);
    // The hours ARE counted — which is what made it look like it was working.
    expect(out.hours).toBeGreaterThan(0);
    // And it says so, rather than swallowing it.
    expect(out.unratedHours).toBeGreaterThan(0);
  });

  it("prices correctly once the embed carries a rate", () => {
    const withRate = [{
      job_id: "A", clock_in: "2026-08-01T08:00:00Z", clock_out: "2026-08-01T16:00:00Z",
      status: "closed", profiles: { id: "p1", hourly_rate: 50 },
    }];
    const out = laborCostForJob(withRate as never[], "A");
    expect(out.cost).toBeGreaterThan(0);
    expect(out.unratedHours).toBe(0);
  });
});

describe("the two time_entries projections must stay identical", () => {
  it("budget-vs-actual asks for the same embeds job profitability does", () => {
    // A SOURCE-LEVEL invariant, deliberately. The bug was a QUERY, and no unit test on the
    // helper could ever have caught it — the helper was correct and shared, which is exactly
    // what made the commit's reasoning feel safe. Two readers of one number must ask the
    // database the same question.
    const src = readFileSync(new URL("./job-profitability.ts", import.meta.url), "utf8");
    const selects = [...src.matchAll(/from\("time_entries"\)\s*\.?\s*\n?\s*\.select\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const sel of selects) {
      expect(sel, `a time_entries projection is missing the profiles embed: ${sel}`).toContain("profiles(");
      expect(sel, `a time_entries projection is missing time_allocations: ${sel}`).toContain("time_allocations(");
      expect(sel, "select(\"*\") does not expand embeds in PostgREST").not.toBe("*");
    }
  });
});
