import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * NORT'S HOLD FILES A FAILED READ (cn-v1130, the deep review's ops finding: "a failed read is never
 * an empty run"). holdingFor's two reads — the person's own resolved reports through the service
 * client, the crew's daily reports under RLS — dropped their error on the floor. The greeting rightly
 * did not ask that time (nothing is stamped by looking; the next Talk asks again), but nothing was
 * filed, so a broken read of the held reports was invisible to ops. Now each failed read is one
 * error_events row under nort:holding, and the hold itself is what it was.
 */
const filed = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: filed.reportError }));

import { holdingFor, summarize } from "./updates";

type Answer = { data: unknown[] | null; error: { message: string } | null };

/** A client whose query chain answers per table however it is filtered and ordered: every builder
 *  returns the chain, and the chain is awaited the way PostgREST's is (thenable). */
function fakeClient(answers: Record<string, Answer>) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "gte", "order", "limit"]) chain[m] = () => chain;
      chain.then = (res: (a: Answer) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(answers[table] ?? { data: [], error: null }).then(res, rej);
      return chain;
    },
  };
}

const me = "user-1";
const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ok = (data: unknown[]): Answer => ({ data, error: null });
const refused = (message: string): Answer => ({ data: null, error: { message } });
const REPORTS = [
  { id: "b1", created_at: ago(1) },
  { id: "b2", created_at: ago(2) },
];
const DAILY = [
  { id: "n1", title: "Daily report from Snowbell Larkspur" },
  { id: "n2", title: "Daily report from Snowbell Larkspur" },
];

beforeEach(() => filed.reportError.mockReset());

describe("holdingFor files a failed read and holds what it always held", () => {
  it("a failed bug_reports read holds 0 reports and is filed once under nort:holding with the person", async () => {
    const service = fakeClient({ bug_reports: refused("could not connect to server") });
    const rls = fakeClient({ notifications: ok(DAILY) });
    const h = await holdingFor(me, service, rls);
    expect(h).toEqual({ reports: 0, dailyReports: [{ from: "Snowbell" }] });
    expect(filed.reportError).toHaveBeenCalledTimes(1);
    expect(filed.reportError).toHaveBeenCalledWith("nort:holding", { message: "could not connect to server" }, { userId: me });
  });

  it("a failed notifications read is filed naming the daily_report read; the reports still count", async () => {
    const service = fakeClient({ bug_reports: ok(REPORTS) });
    const rls = fakeClient({ notifications: refused("connection reset") });
    const h = await holdingFor(me, service, rls);
    expect(h).toEqual({ reports: 2, dailyReports: [] });
    expect(filed.reportError).toHaveBeenCalledTimes(1);
    expect(filed.reportError).toHaveBeenCalledWith("nort:holding", { message: "connection reset" }, { userId: me, read: "daily_report" });
  });

  it("both reads failed: one row per read, and an empty hold the next greeting asks about again", async () => {
    const h = await holdingFor(me, fakeClient({ bug_reports: refused("a") }), fakeClient({ notifications: refused("b") }));
    expect(h).toEqual({ reports: 0, dailyReports: [] });
    expect(filed.reportError).toHaveBeenCalledTimes(2);
    expect(filed.reportError.mock.calls.map((c) => c[0])).toEqual(["nort:holding", "nort:holding"]);
  });

  it("both reads fine: nothing filed, two reports held, one crew name for two daily reports", async () => {
    const h = await holdingFor(me, fakeClient({ bug_reports: ok(REPORTS) }), fakeClient({ notifications: ok(DAILY) }));
    expect(h).toEqual({ reports: 2, dailyReports: [{ from: "Snowbell" }] });
    expect(filed.reportError).not.toHaveBeenCalled();
  });
});

describe("summarize is unchanged", () => {
  it("counts the outcomes in code and bounds the filing days", () => {
    const s = summarize([
      { status: "fixed", created_at: "2026-10-20T12:00:00Z" },
      { status: "wontfix", created_at: "2026-10-01T12:00:00Z" },
      { status: "closed", created_at: "2026-10-10T12:00:00Z" },
      { status: "fixed" },
    ]);
    expect(s).toEqual({ total: 4, shipped: 2, notBeingBuilt: 1, closed: 1, filedFrom: "Oct 1", filedTo: "Oct 20" });
    expect(summarize([])).toEqual({ total: 0, shipped: 0, notBeingBuilt: 0, closed: 0, filedFrom: null, filedTo: null });
  });
});
