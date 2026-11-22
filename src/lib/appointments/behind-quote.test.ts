import { describe, it, expect } from "vitest";
import { closeVisitsBehindLead, closeVisitsBehindQuote, closingsFor, outcomeForQuoteStatus, visitsBehindQuoteFilter } from "./behind-quote";

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
        eq: (col: string, v: unknown) => (c.filters.push(["eq", col, v]), chain),
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

  it("with the company's id (the service client, which RLS does not fence) the read and both writes name it; without it none does (skeptic #39, S6)", async () => {
    const { client, calls } = fake([{ id: "a", job_id: null, outcome: null }]);
    expect(await closeVisitsBehindQuote(client, { id: "q1" }, { jobId: "j1", outcome: "won", orgId: "org-1" })).toEqual({ attached: 1, stamped: 1 });
    expect(calls[0].filters).toEqual([["eq", "org_id", "org-1"]]);
    expect(calls[1].filters).toEqual([["in", "id", ["a"]], ["is", "job_id", null], ["eq", "org_id", "org-1"]]);
    expect(calls[2].filters).toEqual([["in", "id", ["a"]], ["is", "outcome", null], ["eq", "org_id", "org-1"]]);
    const bare = fake([{ id: "a", job_id: null, outcome: null }]);
    await closeVisitsBehindQuote(bare.client, { id: "q1" }, { jobId: "j1", outcome: "won" });
    expect(bare.calls.flatMap((c) => c.filters).some(([op, col]) => op === "eq" && col === "org_id")).toBe(false);
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

/**
 * THE LEAD'S EARLIER VISITS CLOSE WHEN THE LEAD IS WON (cn-v1175, R2): one read of the lead's visits
 * booked or done BEFORE the deed, never cancelled, never one waiting on a pick, then the same guarded
 * writes as an estimate's deed. A stand-in client that records every call.
 */
describe("closeVisitsBehindLead", () => {
  function leadFake(rows: any[], fail: { read?: boolean } = {}) {
    const calls: { op: string; patch?: any; filters: [string, string, unknown][] }[] = [];
    const client = {
      from() {
        const c: (typeof calls)[number] = { op: "select", filters: [] };
        calls.push(c);
        const chain: any = {
          select: () => chain,
          update: (patch: any) => ((c.op = "update"), (c.patch = patch), chain),
          in: (col: string, v: unknown) => (c.filters.push(["in", col, v]), chain),
          is: (col: string, v: unknown) => (c.filters.push(["is", col, v]), chain),
          eq: (col: string, v: unknown) => (c.filters.push(["eq", col, v]), chain),
          lt: (col: string, v: unknown) => (c.filters.push(["lt", col, v]), chain),
          limit: () => chain,
          then: (res: (v: unknown) => unknown) => {
            if (c.op === "select") return Promise.resolve(fail.read ? { data: null, error: { message: "read failed" } } : { data: rows, error: null }).then(res);
            const ids = c.filters.find(([op, col]) => op === "in" && col === "id")?.[2] as string[];
            return Promise.resolve({ data: ids.map((id) => ({ id })), error: null }).then(res);
          },
        };
        return chain;
      },
    };
    return { client: client as any, calls };
  }

  it("reads the lead's visits before the deed, booked or done, not absorbed; attaches the job and stamps Won where nothing is", async () => {
    const { client, calls } = leadFake([
      { id: "insp", job_id: null, outcome: null, type: "inspection" },
      { id: "day", job_id: null, outcome: null, type: "job" },
      { id: "lost", job_id: null, outcome: "lost", type: "inspection" },
    ]);
    const r = await closeVisitsBehindLead(client, { inquiryId: "lead-1", before: "2026-11-21T18:00:00Z" }, { jobId: "job-9", outcome: "won" });
    expect(r).toEqual({ attached: 3, stamped: 1 });
    expect(calls[0].filters).toEqual([
      ["eq", "inquiry_id", "lead-1"],
      ["in", "status", ["scheduled", "completed"]],
      ["eq", "absorbed", false],
      ["lt", "starts_at", "2026-11-21T18:00:00Z"],
    ]);
    expect(calls[1]).toMatchObject({ op: "update", patch: { job_id: "job-9" } });
    expect(calls[1].filters).toContainEqual(["is", "job_id", null]);
    // Only a visit with a win to record takes Won (a job day is the job's), and only where none is.
    expect(calls[2]).toMatchObject({ op: "update", patch: { outcome: "won" } });
    expect(calls[2].filters).toEqual([["in", "id", ["insp"]], ["is", "outcome", null]]);
  });

  it("Won with no job (the lead marked Won): the stamp alone; a failed read is said, never thrown", async () => {
    const one = leadFake([{ id: "insp", job_id: null, outcome: null, type: "inspection" }]);
    expect(await closeVisitsBehindLead(one.client, { inquiryId: "lead-1", before: "2026-11-21T18:00:00Z" }, { outcome: "won" })).toEqual({ attached: 0, stamped: 1 });
    const bad = leadFake([], { read: true });
    expect(await closeVisitsBehindLead(bad.client, { inquiryId: "lead-1", before: "2026-11-21T18:00:00Z" }, { outcome: "won" })).toEqual({ attached: 0, stamped: 0, error: "read failed" });
  });

  it("the two lead doors call it after their deed: Won, and a lead turned into a job", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/actions.ts"), "utf8");
    expect(src).toContain('closeVisitsBehindLead(supabase, { inquiryId: id, before: new Date().toISOString() }, { outcome: "won" })');
    expect(src).toContain('closeVisitsBehindLead(supabase, { inquiryId: id, before: new Date().toISOString() }, { jobId: mintedJobId, outcome: "won" })');
    // The convert stamps only after the lead's own compare-and-set landed (the job exists and is kept).
    const guard = src.indexOf("if (!isContactOnly && !stamped?.length) {");
    expect(guard).toBeGreaterThan(0);
    expect(src.indexOf("if (target === \"job\" && mintedJobId) {")).toBeGreaterThan(guard);
  });
});
