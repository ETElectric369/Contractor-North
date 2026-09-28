import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vi } from "vitest";
import { runDataTool } from "@/lib/assistant-tools";

/**
 * EVERY WAIT HAS A DAY, AND NORT'S SWEEP KNOWS IT (Wave 1 seam fix). Needs You keeps a lead snoozed
 * to a later day (inquiry.snooze writes next_follow_up_at only, so a new lead stays "new") and an
 * estimate given a day to ask again (quotes.follow_up_at) in its Waiting fold until that day.
 * needs_attention used to return both as things to chase: a never-contacted lead whatever its day,
 * and a quiet estimate whatever its follow-up day. Now they come back under `waiting` with their day.
 */

type Answer = { data?: any; error?: any };

/** A pretend client: each table answers from `answers`; quotes can refuse the follow_up_at column. */
function fakeDb(answers: Record<string, Answer>, opts: { noFollowUpColumn?: boolean } = {}) {
  const selects: Record<string, string[]> = {};
  return {
    selects,
    from(table: string) {
      let cols = "";
      const q: any = {
        select(c: string) {
          cols = c;
          (selects[table] = selects[table] ?? []).push(c);
          return q;
        },
        maybeSingle: async () => ({ data: Array.isArray(answers[table]?.data) ? answers[table].data[0] ?? null : answers[table]?.data ?? null, error: null }),
        then: (ok: any, err: any) => {
          if (table === "quotes" && opts.noFollowUpColumn && cols.includes("follow_up_at"))
            return Promise.resolve({ data: null, error: { code: "42703" } }).then(ok, err);
          return Promise.resolve({ data: answers[table]?.data ?? [], error: answers[table]?.error ?? null }).then(ok, err);
        },
      };
      for (const m of ["eq", "in", "is", "not", "lt", "lte", "gt", "gte", "or", "order", "limit", "neq"]) q[m] = () => q;
      return q;
    },
  };
}

const ORG = { settings: { timezone: "America/Los_Angeles" } };
const OLD = "2026-08-01T12:00:00Z";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 6 PM Pacific on Sep 27: already Sep 28 in UTC, so the company's today is what must decide.
  vi.setSystemTime(new Date("2026-09-28T01:00:00Z"));
});
afterAll(() => vi.useRealTimers());

/** The sweep's own estimate reads (the money board reads quotes too). */
const sweepReads = (db: any): string[] => (db.selects.quotes ?? []).filter((c: string) => c.startsWith("quote_number, total, updated_at"));

const sweep = async (db: any) => JSON.parse(await runDataTool("needs_attention", {}, db));

describe("needs_attention honours the day a person picked", () => {
  it("a never-contacted lead snoozed to a later day waits; one with no day, or whose day has come, is due", async () => {
    const db = fakeDb({
      organizations: { data: [ORG] },
      inquiries: {
        data: [
          { name: "Karen", status: "new", next_follow_up_at: "2026-10-10", last_contacted_at: null, created_at: OLD },
          { name: "Dana", status: "new", next_follow_up_at: null, last_contacted_at: null, created_at: OLD },
          { name: "Luis", status: "contacted", next_follow_up_at: "2026-09-27", last_contacted_at: OLD, created_at: OLD },
          { name: "Ruth", status: "contacted", next_follow_up_at: "2026-09-28", last_contacted_at: OLD, created_at: OLD },
        ],
      },
    });
    const r = await sweep(db);
    expect(r.leads_to_follow_up.map((l: any) => l.name)).toEqual(["Dana", "Luis"]);
    // Ruth's day is tomorrow where the company is (UTC already says the 28th): she still waits.
    expect(r.waiting.leads).toEqual([
      { name: "Karen", status: "new", back_on: "2026-10-10" },
      { name: "Ruth", status: "contacted", back_on: "2026-09-28" },
    ]);
  });

  it("an estimate given a later day to ask again waits; a quiet one with no day, or a day that has come, is stale", async () => {
    const db = fakeDb({
      organizations: { data: [ORG] },
      quotes: {
        data: [
          { quote_number: "Q-101", total: "4200", updated_at: OLD, valid_until: null, follow_up_at: "2026-11-01", customers: { name: "Tanager" } },
          { quote_number: "Q-102", total: "900", updated_at: OLD, valid_until: null, follow_up_at: null, customers: { name: "Birch" } },
          { quote_number: "Q-103", total: "1500", updated_at: OLD, valid_until: null, follow_up_at: "2026-09-20", customers: { name: "Alder" } },
        ],
      },
    });
    const r = await sweep(db);
    expect(r.stale_estimates.filter((e: any) => e.kind === "quote").map((e: any) => e.ref)).toEqual(["Q-102", "Q-103"]);
    expect(r.waiting.estimates).toEqual([{ ref: "Q-101", customer: "Tanager", total: 4200, back_on: "2026-11-01" }]);
    expect(sweepReads(db)[0]).toContain("follow_up_at");
  });

  it("before 0366 (no follow_up_at column) the estimate read falls back and nothing is parked", async () => {
    const db = fakeDb(
      {
        organizations: { data: [ORG] },
        quotes: { data: [{ quote_number: "Q-102", total: "900", updated_at: OLD, valid_until: null, customers: { name: "Birch" } }] },
      },
      { noFollowUpColumn: true },
    );
    const r = await sweep(db);
    expect(r.stale_estimates.map((e: any) => e.ref)).toEqual(["Q-102"]);
    expect(r.waiting.estimates).toEqual([]);
    expect(sweepReads(db)).toHaveLength(2);
    expect(sweepReads(db)[1]).not.toContain("follow_up_at");
  });
});
