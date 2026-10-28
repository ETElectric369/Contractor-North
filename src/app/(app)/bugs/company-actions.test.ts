import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE COMPANIES DOOR IS NORTH'S OWN (cn-v1137, 0400). Only a platform admin reads every company's
 * standing or comps one. The read is on the SERVICE client (the viewer's own sees one company under
 * RLS), paged whole, and the standing is accessState computed on the server with the company's own
 * timezone — the component only words it. A failed read is said beside empty rows and filed; the
 * gate's nothing is a plain nothing (error null), like the reports and the errors. The comp is one
 * RPC door on the viewer's client (platform_set_comped_until checks the admin inside): its false is
 * said in words, never reported as done; its refusal passes through in its own words.
 */
const state = vi.hoisted(() => ({
  ctx: null as any,
  page: (() => ({ data: [] as unknown[], error: null as null | { message: string } })) as (from: number) => { data: unknown[] | null; error: null | { message: string } },
  reads: [] as { table: string; cols: string; order: unknown[]; range: [number, number] }[],
  rpc: { data: true as unknown, error: null as null | { code?: string; message?: string } },
  rpcCalls: [] as { fn: string; args: any }[],
  reportError: vi.fn(),
}));
vi.mock("@/lib/platform-admin", () => ({ requirePlatformAdmin: vi.fn(async () => state.ctx) }));
vi.mock("@/lib/observe", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/observe")>()), reportError: state.reportError }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const rec = { table, cols: "", order: [] as unknown[], range: [0, 0] as [number, number] };
      const chain: any = {
        select: (cols: string) => {
          rec.cols = cols;
          return chain;
        },
        order: (...a: unknown[]) => {
          rec.order = a;
          return chain;
        },
        range: (from: number, to: number) => {
          rec.range = [from, to];
          state.reads.push({ ...rec });
          return Promise.resolve(state.page(from));
        },
      };
      return chain;
    },
  }),
}));

import { listCompanies, setCompedUntil } from "./company-actions";

/** The viewer's own client: only the RPC, recorded. */
const viewer = () => ({
  rpc: (fn: string, args: any) => {
    state.rpcCalls.push({ fn, args });
    return Promise.resolve(state.rpc);
  },
});

const NOW = Date.parse("2026-10-28T17:00:00Z"); // 10:00 AM Pacific
const days = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const ORG = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const org = (n: number, o: Record<string, unknown>) => ({
  id: ORG(n),
  name: `Company ${n}`,
  plan: "trial",
  subscription_status: "trialing",
  trial_ends_at: days(3),
  current_period_end: null,
  comped_until: null,
  stripe_customer_id: null,
  created_at: "2026-10-01T00:00:00Z",
  settings: {},
  ...o,
});
const COLS = "id, name, plan, subscription_status, trial_ends_at, current_period_end, comped_until, stripe_customer_id, created_at, settings";

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  state.ctx = { supabase: viewer(), userId: "admin" };
  state.page = (from) => ({ data: from === 0 ? [] : [], error: null });
  state.reads = [];
  state.rpc = { data: true, error: null };
  state.rpcCalls = [];
  state.reportError.mockClear();
  delete process.env.COMPED_ORG_IDS;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.COMPED_ORG_IDS;
});

describe("listCompanies: every company's standing, or the read's error", () => {
  it("the gate: anyone but a platform admin gets nothing, and no error — and no read is made", async () => {
    state.ctx = { error: "Only North's own team can do that." };
    expect(await listCompanies()).toEqual({ rows: [], error: null });
    expect(state.reads).toEqual([]);
    expect(state.reportError).not.toHaveBeenCalled();
  });

  it("a failed read is NOT an empty list: no rows, the reason in words, and the failure filed", async () => {
    state.page = () => ({ data: null, error: { message: "could not connect to server" } });
    expect(await listCompanies()).toEqual({ rows: [], error: "organizations could not be read: could not connect to server" });
    expect(state.reportError).toHaveBeenCalledTimes(1);
    expect(state.reportError.mock.calls[0][0]).toBe("bug-watch:companies");
  });

  it("reads EVERY company on the service client, paged by id, with the standing's columns", async () => {
    state.page = (from) => ({ data: from === 0 ? [org(1, {}), org(2, {})] : from === 2 ? [org(3, {})] : [], error: null });
    const { rows, error } = await listCompanies();
    expect(error).toBeNull();
    expect(rows.map((r) => r.id)).toEqual([ORG(1), ORG(2), ORG(3)]);
    expect(state.reads.map((q) => q.table)).toEqual(["organizations", "organizations", "organizations"]);
    expect(state.reads.map((q) => q.range[0])).toEqual([0, 2, 3]);
    for (const q of state.reads) {
      expect(q.cols).toBe(COLS);
      expect(q.order).toEqual(["id"]);
    }
  });

  it("the standing is computed on the server, by reason, in the company's own timezone; rows come back by name", async () => {
    process.env.COMPED_ORG_IDS = ORG(4);
    state.page = (from) => ({
      data:
        from === 0
          ? [
              org(1, { name: "Thistlewood Plumbing", plan: "trial" }),
              org(2, { name: "Bayberry Builders", plan: "crew", subscription_status: "active", trial_ends_at: days(-20), stripe_customer_id: "cus_test" }),
              org(3, { name: "Catbird Electric", plan: "crew", subscription_status: "canceled", comped_until: days(40) }),
              org(4, { name: "Larkspur Decks", subscription_status: "canceled" }),
              org(5, { name: "Snowbell Roofing", plan: "handyman", subscription_status: "past_due", current_period_end: days(-3) }),
              org(6, { name: "Ended Trial Co", trial_ends_at: days(-1) }),
              org(7, { name: "Gone Co", subscription_status: "canceled" }),
              org(8, { name: "  ", subscription_status: null, settings: { timezone: "America/New_York" } }),
            ]
          : [],
      error: null,
    });
    const { rows, error } = await listCompanies();
    expect(error).toBeNull();
    expect(rows.map((r) => r.name)).toEqual([
      "Bayberry Builders",
      "Catbird Electric",
      "Ended Trial Co",
      "Gone Co",
      "Larkspur Decks",
      "Snowbell Roofing",
      "Thistlewood Plumbing",
      "Unnamed Company",
    ]);
    const by = (name: string) => rows.find((r) => r.name === name)!;
    expect(by("Thistlewood Plumbing")).toMatchObject({ active: true, reason: "trial", daysLeft: 3, compedBy: null, plan: "trial", status: "trialing", stripeCustomer: false, tz: "America/Los_Angeles" });
    expect(by("Bayberry Builders")).toMatchObject({ active: true, reason: "active", daysLeft: null, compedBy: null, plan: "crew", stripeCustomer: true });
    expect(by("Catbird Electric")).toMatchObject({ active: true, reason: "comped", daysLeft: 40, compedBy: "column", compedUntil: days(40) });
    // The standing without the comp rides along, for End Comp's optimistic row.
    expect(by("Catbird Electric").uncomped).toEqual({ active: false, reason: "canceled", daysLeft: null, compedBy: null });
    expect(by("Larkspur Decks")).toMatchObject({ active: true, reason: "comped", daysLeft: null, compedBy: "env" });
    expect(by("Larkspur Decks").uncomped).toMatchObject({ reason: "comped", compedBy: "env" });
    expect(by("Snowbell Roofing")).toMatchObject({ active: true, reason: "grace", daysLeft: 7, compedBy: null, periodEnd: days(-3) });
    expect(by("Ended Trial Co")).toMatchObject({ active: false, reason: "trial_ended", daysLeft: 0 });
    expect(by("Gone Co")).toMatchObject({ active: false, reason: "canceled" });
    expect(by("Unnamed Company")).toMatchObject({ active: false, reason: "unknown", tz: "America/New_York", status: null });
    expect(by("Thistlewood Plumbing").createdAt).toBe("2026-10-01T00:00:00Z");
  });

  it("the trial's days are the company's own calendar: an end at 10 PM Pacific tomorrow is 1 day, not the UTC ceiling's 2", async () => {
    // Tomorrow 10:00 PM PDT = 2026-10-30T05:00Z: 36 hours off, a UTC ceiling of 2, one calendar day in Truckee.
    state.page = (from) => ({ data: from === 0 ? [org(1, { trial_ends_at: "2026-10-30T05:00:00Z" })] : [], error: null });
    expect((await listCompanies()).rows[0]).toMatchObject({ reason: "trial", daysLeft: 1 });
    // The same instant for a company in London (GMT by late October) is two calendar days off: Oct 28 5 PM → Oct 30 5 AM local.
    state.page = (from) => ({ data: from === 0 ? [org(1, { trial_ends_at: "2026-10-30T05:00:00Z", settings: { timezone: "Europe/London" } })] : [], error: null });
    expect((await listCompanies()).rows[0]).toMatchObject({ reason: "trial", daysLeft: 2, tz: "Europe/London" });
  });
});

describe("setCompedUntil: one RPC door, on the viewer's own client", () => {
  const UNTIL = "2027-01-31T23:59:59.000Z";

  it("refuses a company's owner in words, and never reaches the RPC", async () => {
    state.ctx = { error: "Only North's own team can do that." };
    expect(await setCompedUntil(ORG(1), UNTIL)).toEqual({ ok: false, error: "Only North's own team can do that." });
    expect(state.rpcCalls).toEqual([]);
  });

  it("a company id that is not one, or a date nothing can parse, is refused before the RPC", async () => {
    expect(await setCompedUntil("", UNTIL)).toEqual({ ok: false, error: "Pick a company." });
    expect(await setCompedUntil("not-a-uuid", UNTIL)).toEqual({ ok: false, error: "Pick a company." });
    expect(await setCompedUntil(ORG(1), "garbage")).toEqual({ ok: false, error: "Pick a date." });
    expect(await setCompedUntil(ORG(1), "")).toEqual({ ok: false, error: "Pick a date." });
    expect(state.rpcCalls).toEqual([]);
  });

  it("a day that is not after today is refused in words before the RPC (skeptic #43, S11): a comp that ends in the past is no comp", async () => {
    expect(await setCompedUntil(ORG(1), "2026-10-28T16:59:59.000Z")).toEqual({ ok: false, error: "Pick a day after today." });
    expect(await setCompedUntil(ORG(1), "2026-10-28T17:00:00.000Z")).toEqual({ ok: false, error: "Pick a day after today." });
    expect(await setCompedUntil(ORG(1), "2026-10-01T07:00:00.000Z")).toEqual({ ok: false, error: "Pick a day after today." });
    expect(state.rpcCalls).toEqual([]);
    // One second later than now is a day after today as far as the rule goes; the calendar box only offers whole days.
    expect(await setCompedUntil(ORG(1), "2026-10-28T17:00:01.000Z")).toEqual({ ok: true, error: null });
  });

  it("sets through platform_set_comped_until, and clears on null", async () => {
    expect(await setCompedUntil(ORG(1), UNTIL)).toEqual({ ok: true, error: null });
    expect(await setCompedUntil(ORG(1), null)).toEqual({ ok: true, error: null });
    expect(state.rpcCalls).toEqual([
      { fn: "platform_set_comped_until", args: { p_org: ORG(1), p_until: UNTIL } },
      { fn: "platform_set_comped_until", args: { p_org: ORG(1), p_until: null } },
    ]);
  });

  it("the RPC's false — the company is not there — is said, never reported as done", async () => {
    state.rpc = { data: false, error: null };
    expect(await setCompedUntil(ORG(1), UNTIL)).toEqual({ ok: false, error: "That company isn't there any more." });
    state.rpc = { data: null, error: null };
    expect(await setCompedUntil(ORG(1), UNTIL)).toEqual({ ok: false, error: "That company isn't there any more." });
  });

  it("the RPC's own refusal passes through in its words; a bare permission denial is worded", async () => {
    state.rpc = { data: null, error: { code: "42501", message: "Only North's own team can comp a company." } };
    expect(await setCompedUntil(ORG(1), UNTIL)).toEqual({ ok: false, error: "Only North's own team can comp a company." });
    state.rpc = { data: null, error: { message: "permission denied for function platform_set_comped_until" } };
    const res = await setCompedUntil(ORG(1), UNTIL);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("You don't have access");
  });
});
