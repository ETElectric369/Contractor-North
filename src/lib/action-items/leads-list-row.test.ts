import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NEEDS YOU'S LEAD ROWS ARE THE LEADS LIST (cn-v1170). Erik, 2026-11-19: "if a lead is still on the
 * lead page that IS the reminder and the follow up reminders dont really work, one badge one list
 * simple". The inquiry kind reads through the one rule (lib/leads/new-intake loadNewIntake), never a
 * filter of its own: no follow-up day, no Waiting fold for a lead, one row per lead, its clock the
 * day it came in. The fake database applies the filters it is sent, so a lead leaves only because
 * the rule said so, and the Sales badge (countNewIntake) is read over the same rows.
 */

type Call = [method: string, ...args: unknown[]];
type ReadLog = { table: string; cols: string; calls: Call[] };

const state = vi.hoisted(() => ({
  leads: [] as any[],
  visits: [] as any[],
  failLeads: false,
  reads: [] as { table: string; cols: string; calls: [string, ...unknown[]][] }[],
}));

function keeps(row: Record<string, unknown>, [method, col, val]: Call): boolean {
  const v = row[String(col)];
  if (method === "eq") return v === val;
  if (method === "neq") return v !== val;
  if (method === "is") return val === null ? v === null || v === undefined : v === val;
  if (method === "in") return (val as unknown[]).includes(v);
  return true;
}

function answer(read: ReadLog): { data: any; count: number; error: unknown } {
  if (read.table === "profiles") return { data: { org_id: "org-1", role: "owner" }, count: 1, error: null };
  if (read.table === "inquiries" && state.failLeads) return { data: null, count: 0, error: { message: "boom" } };
  const table = read.table === "inquiries" ? state.leads : read.table === "appointments" ? state.visits : [];
  let rows = table.filter((r) => read.calls.every((c) => keeps(r, c)));
  const order = read.calls.find((c) => c[0] === "order") as [string, string, { ascending?: boolean }?] | undefined;
  if (order && order[1] === "created_at") {
    const dir = order[2]?.ascending === false ? -1 : 1;
    rows = [...rows].sort((a, b) => dir * (Date.parse(a.created_at) - Date.parse(b.created_at)));
  }
  const count = rows.length;
  const limit = read.calls.find((c) => c[0] === "limit");
  return { data: limit ? rows.slice(0, Number(limit[1])) : rows, count, error: null };
}

function fakeClient() {
  const chain = (table: string) => {
    const read: ReadLog = { table, cols: "", calls: [] };
    state.reads.push(read);
    const q: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const { data, count, error } = answer(read);
            return (ok: any, err: any) => Promise.resolve({ data, error, count }).then(ok, err);
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

import { getActionItems } from "./query";
import { countNewIntake } from "@/lib/leads/new-intake";

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T20:00:00Z`) - n * 86_400_000).toISOString();
const lead = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Lead ${id}`,
  phone: "(530) 555-0100",
  status: "new",
  converted_at: null,
  created_at: daysAgo(2),
  ...over,
});
const visitFor = (inquiry_id: string, over: Record<string, unknown> = {}) => ({ id: `v-${inquiry_id}`, inquiry_id, status: "scheduled", outcome: null, ...over });

beforeEach(() => {
  state.leads = [];
  state.visits = [];
  state.failLeads = false;
  state.reads = [];
});

const office = () => getActionItems({ todayStr: TODAY, isStaff: true, userId: "owner-1", tz: "America/Los_Angeles" });
const rows = (r: Awaited<ReturnType<typeof office>>) => r.now.flatMap((i) => i.children ?? [i]);
const leadIds = (r: Awaited<ReturnType<typeof office>>) => rows(r).filter((i) => i.kind === "inquiry").map((i) => i.id).sort();

describe("the inquiry kind lists exactly the leads on the Leads list", () => {
  it("open with no standing visit: listed; booked, Not Sold or converted: not; a dismissed or Not Sold visit puts it back", async () => {
    state.leads = [
      lead("fresh"),
      lead("reached", { status: "contacted" }),
      lead("booked"),
      lead("waiting-pick"),
      lead("visit-cancelled"),
      lead("visit-not-sold"),
      lead("not-sold", { status: "lost" }),
      lead("converted", { converted_at: daysAgo(1) }),
    ];
    state.visits = [
      visitFor("booked"),
      // Waiting on the pick while the first time offered is still ahead (new-intake visitStands).
      visitFor("waiting-pick", { status: "proposed", starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString() }),
      visitFor("visit-cancelled", { status: "cancelled" }),
      visitFor("visit-not-sold", { status: "completed", outcome: "lost" }),
    ];
    const r = await office();
    expect(leadIds(r)).toEqual(["fresh", "reached", "visit-cancelled", "visit-not-sold"]);
    // ONE BADGE, ONE LIST: the Sales badge counts the same leads over the same rows.
    expect(await countNewIntake(fakeClient() as any)).toBe(4);
    // No lead ever waits in the fold: a lead has no day.
    expect(r.waiting.filter((w) => w.kind === "inquiry")).toEqual([]);
  });

  it("each row's clock and day are the day it came in, and it opens the lead's file", async () => {
    state.leads = [lead("one", { created_at: daysAgo(3) }), lead("two", { created_at: daysAgo(1) })];
    const r = await office();
    const one = rows(r).find((i) => i.id === "one")!;
    expect(one.clock).toBe(daysAgo(3));
    expect(one.when).toBe(daysAgo(3));
    expect(one.href).toBe("/leads/one");
    expect(one.affordances).toEqual(["dismiss", "open"]);
  });

  it("a failed lead read is a Couldn't Check line that opens Leads, never an empty list", async () => {
    state.failLeads = true;
    const r = await office();
    const line = rows(r).find((i) => i.id === "leads-unread");
    expect(line).toMatchObject({ kind: "inquiry", href: "/leads", affordances: ["open"], what: { key: "ny_w_unreadLeads" } });
  });
});

describe("the wiring (source pins)", () => {
  const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const query = src("src/lib/action-items/query.ts");

  it("the build reads leads only through the one rule, with the badge's own cap", () => {
    expect(query).toContain("isStaff ? readLeadsList(supabase) : empty,");
    expect(query).toContain("loadNewIntake<InquiryRow>(supabase, INQUIRY_ROW_COLUMNS, { limit: NEW_INTAKE_COUNT_CAP })");
    expect(query).not.toMatch(/\.from\("inquiries"\)/);
    expect(query).not.toContain("next_follow_up_at");
  });

  it("the row reads no follow-up day", () => {
    expect(src("src/lib/action-items/switches.ts")).not.toContain("next_follow_up_at");
    expect(src("src/lib/action-items/due-filters.ts")).not.toContain("inquiryDueFilter");
  });

  it("the morning push names the leads on the list, oldest first, for this company", () => {
    const digest = src("src/lib/action-items/digest.ts");
    expect(digest).toMatch(/loadNewIntake<\{ id: string; name: string \| null \}>\(supabase, "id, name", \{\s*orgId: org\.id,\s*oldestFirst: true,/);
    expect(digest).toContain("data: r.leads.slice(0, 2)");
    expect(digest).not.toContain("next_follow_up_at");
  });
});
