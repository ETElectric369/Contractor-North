import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vi } from "vitest";
import { runDataTool } from "@/lib/assistant-tools";

/**
 * EVERY WAIT HAS A DAY, AND NORT'S SWEEP KNOWS IT (Wave 1 seam fix). Needs You keeps an estimate
 * given a day to ask again (quotes.follow_up_at) in its Waiting fold until that day, and the sweep
 * returns it under `waiting` with its day. A LEAD HAS NO DAY since cn-v1170: the sweep's lead bucket
 * is the Leads list itself (lib/leads/new-intake), the same list the page, the badge and Needs You read.
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
  it("the lead bucket is the Leads list: every open lead with no inspection standing, oldest first; a lead never waits", async () => {
    const db = fakeDb({
      organizations: { data: [ORG] },
      inquiries: {
        data: [
          { id: "l-1", name: "Dana Rook", phone: null, status: "new", last_contacted_at: null, created_at: OLD },
          { id: "l-2", name: "Theo Vance", phone: null, status: "contacted", last_contacted_at: OLD, created_at: OLD },
          { id: "l-3", name: "Casey Loam", phone: null, status: "new", last_contacted_at: null, created_at: OLD },
        ],
      },
      // Theo's inspection is on the books: he is off the list (the rule reads the visits).
      appointments: { data: [{ inquiry_id: "l-2", status: "scheduled", outcome: null }] },
    });
    const r = await sweep(db);
    expect(r.leads_on_the_list.map((l: any) => l.name)).toEqual(["Dana Rook", "Casey Loam"]);
    expect(r.leads_on_the_list[0]).toMatchObject({ never_contacted: true });
    expect(r.leads_to_follow_up).toBeUndefined();
    expect(r.waiting.leads).toBeUndefined();
    // The read is the rule's: no follow-up day is asked for.
    expect((db.selects.inquiries ?? []).join(" ")).not.toContain("next_follow_up_at");
  });

  it("a failed lead read is said, never an empty bucket", async () => {
    const db = fakeDb({ organizations: { data: [ORG] }, inquiries: { error: { message: "boom" } } });
    const r = await sweep(db);
    expect(r.leads_on_the_list).toEqual([]);
    expect(r.leads_note).toMatch(/could not be read/);
  });

  it("an estimate given a later day to ask again waits; a quiet one with no day, or a day that has come, is stale", async () => {
    const db = fakeDb({
      organizations: { data: [ORG] },
      quotes: {
        data: [
          { quote_number: "Q-101", total: "4200", updated_at: OLD, valid_until: null, follow_up_at: "2026-11-01", customers: { name: "Tupelo" } },
          { quote_number: "Q-102", total: "900", updated_at: OLD, valid_until: null, follow_up_at: null, customers: { name: "Birch" } },
          { quote_number: "Q-103", total: "1500", updated_at: OLD, valid_until: null, follow_up_at: "2026-09-20", customers: { name: "Alder" } },
        ],
      },
    });
    const r = await sweep(db);
    expect(r.stale_estimates.filter((e: any) => e.kind === "quote").map((e: any) => e.ref)).toEqual(["Q-102", "Q-103"]);
    expect(r.waiting.estimates).toEqual([{ ref: "Q-101", customer: "Tupelo", total: 4200, back_on: "2026-11-01" }]);
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

describe("list_inquiries is the Leads list, and says each lead's stage (cn-v1170)", () => {
  const list = async (db: any, input: Record<string, unknown> = {}) => JSON.parse(await runDataTool("list_inquiries", input, db));
  const LEADS = [
    { id: "l-1", name: "Dana Rook", status: "new", converted_at: null, created_at: OLD },
    { id: "l-2", name: "Theo Vance", status: "contacted", converted_at: null, created_at: OLD },
  ];

  it("with no id and no status: only the leads on the list, each 'on the Leads list', and no follow-up, kind or length field", async () => {
    const db = fakeDb({ inquiries: { data: LEADS }, appointments: { data: [{ inquiry_id: "l-2", status: "proposed", outcome: null, starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString() }] } });
    const r = await list(db);
    expect(r.inquiries.map((i: any) => [i.name, i.stage])).toEqual([["Dana Rook", "on the Leads list"]]);
    for (const gone of ["work_kind", "planned_minutes", "next_follow_up_at", "status"]) expect(r.inquiries[0], gone).not.toHaveProperty(gone);
    expect((db.selects.inquiries ?? []).join(" ")).not.toMatch(/work_kind|planned_minutes|next_follow_up_at/);
  });

  it("one lead by id says where it is: inspection booked, Not Sold, converted", async () => {
    const booked = fakeDb({ inquiries: { data: [LEADS[1]] }, appointments: { data: [{ inquiry_id: "l-2", status: "scheduled", outcome: null }] } });
    expect((await list(booked, { id: "l-2" })).inquiries[0].stage).toBe("inspection booked");
    const notSold = fakeDb({ inquiries: { data: [{ ...LEADS[0], status: "lost" }] } });
    expect((await list(notSold, { id: "l-1" })).inquiries[0].stage).toBe("Not Sold");
    const converted = fakeDb({ inquiries: { data: [{ ...LEADS[0], converted_at: OLD }] } });
    expect((await list(converted, { id: "l-1" })).inquiries[0].stage).toBe("converted");
  });
});
