import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vi } from "vitest";
import { runDataTool } from "@/lib/assistant-tools";

/**
 * NORT'S SWEEP READS THE LISTS THE PAGES READ. A LEAD HAS NO DAY since cn-v1170: the sweep's lead
 * bucket is the Leads list itself (lib/leads/new-intake), the same list the page, the badge and Needs
 * You read. AN ESTIMATE HAS NO DAY since cn-v1172 ("Closing is the reminder yes"): the sweep's sent
 * estimates are the Closing list's that need a person (lib/estimate/closing loadClosing), and nothing
 * is parked with a day.
 */

type Answer = { data?: any; error?: any };

/** A pretend client: each table answers from `answers`, or from `opts.pick` by table and columns. */
function fakeDb(answers: Record<string, Answer>, opts: { pick?: (table: string, cols: string) => Answer | undefined } = {}) {
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
          const picked = opts.pick?.(table, cols);
          if (picked) return Promise.resolve({ data: picked.data ?? [], error: picked.error ?? null }).then(ok, err);
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

import { CLOSING_COLUMNS } from "@/lib/estimate/closing";

const sweep = async (db: any) => JSON.parse(await runDataTool("needs_attention", {}, db));

describe("needs_attention reads the lists the pages read", () => {
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
    expect(r.waiting).toBeUndefined();
    // The read is the rule's: no follow-up day is asked for.
    expect((db.selects.inquiries ?? []).join(" ")).not.toContain("next_follow_up_at");
  });

  it("a failed lead read is said, never an empty bucket", async () => {
    const db = fakeDb({ organizations: { data: [ORG] }, inquiries: { error: { message: "boom" } } });
    const r = await sweep(db);
    expect(r.leads_on_the_list).toEqual([]);
    expect(r.leads_note).toMatch(/could not be read/);
  });

  it("the sent estimates are the Closing list's that need a person; a stale draft is its own; nothing is parked", async () => {
    // Company today: Sep 27 (Pacific).
    const sent = [
      // Written in August, sent again two days ago: the customer has it fresh. Not stale.
      { id: "q-1", quote_number: "E-901", title: "Larkspur Panel", status: "sent", total: "4200", valid_until: null, created_at: OLD, job_id: null, customer_id: "c-1", inquiry_id: null, customers: { name: "Dana Rook" }, jobs: null },
      // Written in August, no send on record: quiet.
      { id: "q-2", quote_number: "E-902", title: "Snowbell Shed", status: "sent", total: "900", valid_until: null, created_at: OLD, job_id: null, customer_id: "c-2", inquiry_id: null, customers: { name: "Theo Vance" }, jobs: null },
      // Written yesterday, its offer ended: needs a person.
      { id: "q-3", quote_number: "E-903", title: "Bayberry Gate", status: "sent", total: "1500", valid_until: "2026-09-20", created_at: "2026-09-26T18:00:00Z", job_id: null, customer_id: null, inquiry_id: "l-9", customers: null, jobs: null },
    ];
    const db = fakeDb(
      { organizations: { data: [ORG] } },
      {
        pick: (table, cols) => {
          if (table === "quotes" && cols === CLOSING_COLUMNS) return { data: sent };
          if (table === "quotes" && cols.startsWith("quote_number, total, updated_at"))
            return { data: [{ quote_number: "E-904", total: "300", updated_at: OLD, valid_until: null, customers: { name: "Casey Loam" } }] };
          if (table === "quotes") return { data: [] };
          if (table === "sent_messages") return { data: [{ doc_id: "q-1", sent_at: "2026-09-25T17:00:00Z" }] };
          return undefined;
        },
      },
    );
    const r = await sweep(db);
    const out = r.stale_estimates.filter((e: any) => e.kind === "sent");
    // The Closing list's own order: the longest wait first.
    expect(out.map((e: any) => [e.ref, e.why])).toEqual([
      ["E-902", "quiet"],
      ["E-903", "offer_ended"],
    ]);
    expect(out[0]).toMatchObject({ customer: "Theo Vance", total: 900, sent_on_record: false });
    expect(r.stale_estimates.filter((e: any) => e.kind === "draft").map((e: any) => e.ref)).toEqual(["E-904"]);
    expect(r.waiting).toBeUndefined();
    expect(r.closing_note).toMatch(/Sales > Closing/);
    // No read names the follow-up day; the draft read asks for drafts only.
    expect((db.selects.quotes ?? []).join(" ")).not.toContain("follow_up_at");
  });

  it("a failed Closing read is said, never an empty bucket", async () => {
    const db = fakeDb(
      { organizations: { data: [ORG] } },
      { pick: (table, cols) => (table === "quotes" && cols === CLOSING_COLUMNS ? { error: { message: "boom" } } : undefined) },
    );
    const r = await sweep(db);
    expect(r.stale_estimates.filter((e: any) => e.kind === "sent")).toEqual([]);
    expect(r.estimates_note).toMatch(/could not be read/);
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
