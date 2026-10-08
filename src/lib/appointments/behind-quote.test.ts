import { describe, it, expect } from "vitest";
import { closeVisitsBehindQuote, closingsFor, outcomeForQuoteStatus, visitsBehindQuoteFilter } from "./behind-quote";

/**
 * THE VISIT CLOSES WHEN ITS ESTIMATE MOVES (cn-v1069). Pinned without a database: the three links
 * the match reads, which visits get which stamp, and that every write is guarded by the column
 * still being null (twice-safe), with a failed read said and never thrown.
 */
describe("the visits an estimate stands behind", () => {
  it("are found by the capture's own backlink always, and by the lead and the job when the estimate has them", () => {
    expect(visitsBehindQuoteFilter({ id: "q1" })).toBe("capture->>quote_id.eq.q1");
    expect(visitsBehindQuoteFilter({ id: "q1", inquiry_id: "l1" })).toBe("capture->>quote_id.eq.q1,inquiry_id.eq.l1");
    expect(visitsBehindQuoteFilter({ id: "q1", inquiry_id: null, job_id: "j1" })).toBe("capture->>quote_id.eq.q1,job_id.eq.j1");
    expect(visitsBehindQuoteFilter({ id: "q1", inquiry_id: "l1", job_id: "j1" })).toBe("capture->>quote_id.eq.q1,inquiry_id.eq.l1,job_id.eq.j1");
  });

  it("the estimate's status is the visit's outcome: accepted won, declined or expired lost, the rest nothing", () => {
    expect(outcomeForQuoteStatus("accepted")).toBe("won");
    expect(outcomeForQuoteStatus("declined")).toBe("lost");
    expect(outcomeForQuoteStatus("expired")).toBe("lost");
    expect(outcomeForQuoteStatus("sent")).toBeNull();
    expect(outcomeForQuoteStatus("draft")).toBeNull();
    expect(outcomeForQuoteStatus(null)).toBeNull();
  });

  it("a job attaches only where the visit has none; an outcome stamps only where none is", () => {
    const rows = [
      { id: "a", job_id: null, outcome: null },
      { id: "b", job_id: "j9", outcome: null },
      { id: "c", job_id: null, outcome: "lost" },
      { id: "d", job_id: "j9", outcome: "won" },
    ];
    expect(closingsFor(rows, { jobId: "j1", outcome: "won" })).toEqual({ attach: ["a", "c"], stamp: ["a", "b"] });
    expect(closingsFor(rows, { outcome: "lost" })).toEqual({ attach: [], stamp: ["a", "b"] });
    expect(closingsFor(rows, { jobId: "j1" })).toEqual({ attach: ["a", "c"], stamp: [] });
    expect(closingsFor(rows, {})).toEqual({ attach: [], stamp: [] });
  });
});

type Call = { table: string; op: string; patch?: any; filters: [string, string, unknown][]; or?: string };

function fake(rows: any[], fail: { read?: boolean; write?: boolean } = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const c: Call = { table, op: "select", filters: [] };
      calls.push(c);
      const chain: any = {
        select: () => chain,
        update: (patch: any) => ((c.op = "update"), (c.patch = patch), chain),
        or: (f: string) => ((c.or = f), chain),
        in: (col: string, v: unknown) => (c.filters.push(["in", col, v]), chain),
        is: (col: string, v: unknown) => (c.filters.push(["is", col, v]), chain),
        limit: () => chain,
        then: (res: (v: unknown) => unknown) => {
          if (c.op === "select") return Promise.resolve(fail.read ? { data: null, error: { message: "read failed" } } : { data: rows, error: null }).then(res);
          if (fail.write) return Promise.resolve({ data: null, error: { message: "write failed" } }).then(res);
          const ids = c.filters.find(([op]) => op === "in")?.[2] as string[];
          return Promise.resolve({ data: ids.map((id) => ({ id })), error: null }).then(res);
        },
      };
      return chain;
    },
  };
  return { client: client as any, calls };
}

describe("closeVisitsBehindQuote", () => {
  it("one read by all three links, then one guarded write per stamp, each proven by its rows", async () => {
    const { client, calls } = fake([
      { id: "a", job_id: null, outcome: null },
      { id: "b", job_id: "j9", outcome: null },
    ]);
    const out = await closeVisitsBehindQuote(client, { id: "q1", inquiry_id: "l1", job_id: null }, { jobId: "j1", outcome: "won" });
    expect(out).toEqual({ attached: 1, stamped: 2 });
    expect(calls[0]).toMatchObject({ table: "appointments", op: "select", or: "capture->>quote_id.eq.q1,inquiry_id.eq.l1" });
    const attach = calls[1];
    expect(attach.patch).toMatchObject({ job_id: "j1" });
    expect(attach.patch.absorbed).toBeUndefined(); // attached, never absorbed (0237)
    expect(attach.filters).toEqual([["in", "id", ["a"]], ["is", "job_id", null]]);
    const stamp = calls[2];
    expect(stamp.patch).toMatchObject({ outcome: "won" });
    expect(stamp.patch.outcome_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stamp.filters).toEqual([["in", "id", ["a", "b"]], ["is", "outcome", null]]);
  });

  it("nothing to decide means no read at all; nothing left open means no write", async () => {
    const { client, calls } = fake([{ id: "d", job_id: "j9", outcome: "won" }]);
    expect(await closeVisitsBehindQuote(client, { id: "q1" }, {})).toEqual({ attached: 0, stamped: 0 });
    expect(calls).toHaveLength(0);
    expect(await closeVisitsBehindQuote(client, { id: "q1" }, { jobId: "j1", outcome: "won" })).toEqual({ attached: 0, stamped: 0 });
    expect(calls).toHaveLength(1);
  });

  it("a failed read or write is said, never thrown (the estimate's own deed already landed)", async () => {
    const bad = fake([], { read: true });
    expect(await closeVisitsBehindQuote(bad.client, { id: "q1" }, { outcome: "lost" })).toEqual({ attached: 0, stamped: 0, error: "read failed" });
    const badWrite = fake([{ id: "a", job_id: null, outcome: null }], { write: true });
    expect(await closeVisitsBehindQuote(badWrite.client, { id: "q1" }, { outcome: "lost" })).toEqual({ attached: 0, stamped: 0, error: "write failed" });
  });
});
