import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE ONE READ OF A COMPANY'S USAGE (cn-v1140, lib/usage-meter), against a fake service client:
 * the budget by the standing's reason (trial → Handyman, comped → Company, a plan → its tier, nothing
 * → Handyman), the month's spend read from the 1st of the company's own month, the top-ups by month
 * key, the window on the company's calendar — and that every failed read answers "fine" at 0%,
 * degraded, filed, never a throw; the percent is floored so 99.7% is not "out".
 */
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => fake.client(), createClient: async () => fake.client() }));

import { reportError } from "@/lib/observe";
import { usageFor, usageTierFor, USAGE_ORG_COLUMNS } from "./usage-meter";

const ORG = "11111111-1111-4111-8111-111111111111";
/** 8 PM Pacific on Oct 15, 2026. */
const NOW = Date.parse("2026-10-16T03:00:00Z");

type Fake = {
  org: Record<string, unknown> | null;
  orgError: unknown;
  spend: number | null;
  spendError: unknown;
  topup: number | null;
  topupError: unknown;
  rpcs: { fn: string; args: Record<string, unknown> }[];
  selects: string[];
  client: () => any;
};
const fake: Fake = {
  org: null,
  orgError: null,
  spend: 0,
  spendError: null,
  topup: 0,
  topupError: null,
  rpcs: [],
  selects: [],
  client: () => ({
    from: (table: string) => {
      const q: any = {};
      q.select = (cols: string) => {
        fake.selects.push(`${table}:${cols}`);
        return q;
      };
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: fake.org, error: fake.orgError });
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      fake.rpcs.push({ fn, args });
      if (fn === "ai_spend_from") return { data: fake.spend, error: fake.spendError };
      if (fn === "usage_topup_total") return { data: fake.topup, error: fake.topupError };
      return { data: null, error: new Error(`no such rpc ${fn}`) };
    },
  }),
};

const ACTIVE = { id: ORG, plan: "crew", settings: { timezone: "America/Los_Angeles" }, subscription_status: "active", trial_ends_at: null, current_period_end: null, comped_until: null };

beforeEach(() => {
  fake.org = ACTIVE;
  fake.orgError = null;
  fake.spend = 0;
  fake.spendError = null;
  fake.topup = 0;
  fake.topupError = null;
  fake.rpcs = [];
  fake.selects = [];
  vi.mocked(reportError).mockClear();
});

describe("usageTierFor — whose budget applies", () => {
  it("a trial runs on Handyman's line, a comped company on Company's, a plan on its own, nothing on Handyman's", () => {
    expect(usageTierFor({ reason: "trial" }, "company")).toBe("handyman");
    expect(usageTierFor({ reason: "comped" }, "handyman")).toBe("company");
    expect(usageTierFor({ reason: "comped" }, null)).toBe("company");
    expect(usageTierFor({ reason: "active" }, "crew")).toBe("crew");
    expect(usageTierFor({ reason: "active" }, "company")).toBe("company");
    expect(usageTierFor({ reason: "grace" }, "handyman")).toBe("handyman");
    expect(usageTierFor({ reason: "unknown" }, null)).toBe("handyman");
    expect(usageTierFor({ reason: "canceled" }, "mystery")).toBe("handyman");
  });
});

describe("usageFor — the read", () => {
  it("reads the company with the plan, the settings and the billing columns, then the month's spend from the 1st and the top-ups by month key", async () => {
    fake.spend = 7.5;
    fake.topup = 5;
    const m = await usageFor(ORG, undefined, { nowMs: NOW });
    expect(fake.selects).toEqual([`organizations:${USAGE_ORG_COLUMNS}`]);
    expect(USAGE_ORG_COLUMNS).toBe("id, plan, settings, subscription_status, trial_ends_at, current_period_end, comped_until");
    expect(fake.rpcs).toEqual([
      { fn: "ai_spend_from", args: { p_org_id: ORG, p_from: "2026-10-01" } },
      { fn: "usage_topup_total", args: { p_org: ORG, p_month: "2026-10" } },
    ]);
    // Crew: $30 + $5 bought = $35 cap; $7.5 spent = 21%; the 15th on the company's calendar.
    expect(m).toMatchObject({
      tier: "crew",
      planName: "Crew",
      budgetUsd: 30,
      spentUsd: 7.5,
      topupUsd: 5,
      pct: 21,
      state: "fine",
      today: "2026-10-15",
      monthKey: "2026-10",
      resetOn: "2026-11-01",
      timezone: "America/Los_Angeles",
      degraded: false,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a row the caller already read is taken as given: no second trip to the company", async () => {
    fake.spend = 31;
    const m = await usageFor(ORG, ACTIVE, { nowMs: NOW });
    expect(fake.selects).toEqual([]);
    expect(m).toMatchObject({ tier: "crew", pct: 100, state: "out", degraded: false });
  });

  it("the month is the company's own: at 8 PM Pacific on Oct 31 it reads October from Oct 1; a company in UTC is already in November", async () => {
    const lateOct = Date.parse("2026-11-01T03:00:00Z");
    await usageFor(ORG, ACTIVE, { nowMs: lateOct });
    expect(fake.rpcs[0].args.p_from).toBe("2026-10-01");
    expect(fake.rpcs[1].args.p_month).toBe("2026-10");
    fake.rpcs = [];
    const m = await usageFor(ORG, { ...ACTIVE, settings: { timezone: "UTC" } }, { nowMs: lateOct });
    expect(fake.rpcs[0].args.p_from).toBe("2026-11-01");
    expect(m.monthKey).toBe("2026-11");
    expect(m.resetOn).toBe("2026-12-01");
  });

  it("a trial runs on Handyman's budget and carries its last day on the company's calendar", async () => {
    fake.spend = 9;
    const m = await usageFor(ORG, { ...ACTIVE, plan: "trial", subscription_status: "trialing", trial_ends_at: "2026-10-25T02:00:00Z" }, { nowMs: NOW });
    expect(m).toMatchObject({ tier: "handyman", budgetUsd: 10, pct: 90, state: "almost", trialEndsOn: "2026-10-24" });
  });

  it("a comped company runs on Company's budget, whatever its plan says; the comp's end is not a trial's", async () => {
    fake.spend = 40;
    const m = await usageFor(ORG, { ...ACTIVE, plan: "handyman", subscription_status: "canceled", comped_until: "2099-01-01T00:00:00Z" }, { nowMs: NOW });
    expect(m).toMatchObject({ tier: "company", budgetUsd: 80, pct: 50, state: "watch" });
    expect("trialEndsOn" in m).toBe(false);
  });

  it("no plan and no standing reads as Handyman: the smallest honest meter, never none", async () => {
    fake.spend = 2;
    const m = await usageFor(ORG, { id: ORG, plan: null, settings: {}, subscription_status: null, trial_ends_at: null, current_period_end: null, comped_until: null }, { nowMs: NOW });
    expect(m).toMatchObject({ tier: "handyman", budgetUsd: 10, pct: 20, state: "fine", degraded: false });
  });

  it("no company id, or no such company, is the open answer: fine at 0%, degraded, no rpc", async () => {
    expect(await usageFor(null, undefined, { nowMs: NOW })).toMatchObject({ pct: 0, state: "fine", spentUsd: 0, degraded: true, tier: "handyman" });
    fake.org = null;
    expect(await usageFor(ORG, undefined, { nowMs: NOW })).toMatchObject({ pct: 0, state: "fine", degraded: true });
    expect(fake.rpcs).toEqual([]);
  });

  it("FAILS OPEN: a company read that fails, a ledger read that fails, a top-up read that fails — each is fine at 0%, degraded, filed", async () => {
    fake.orgError = new Error("connection reset");
    let m = await usageFor(ORG, undefined, { nowMs: NOW });
    expect(m).toMatchObject({ pct: 0, state: "fine", spentUsd: 0, degraded: true });
    expect(reportError).toHaveBeenCalledWith("usage-meter:org", expect.any(Error), { orgId: ORG });

    fake.orgError = null;
    fake.spend = 99;
    fake.spendError = new Error("timeout");
    m = await usageFor(ORG, ACTIVE, { nowMs: NOW });
    expect(m).toMatchObject({ pct: 0, state: "fine", spentUsd: 0, degraded: true, tier: "crew", today: "2026-10-15" });
    expect(reportError).toHaveBeenCalledWith("usage-meter:read", expect.any(Error), { orgId: ORG, monthKey: "2026-10" });

    fake.spendError = null;
    fake.topupError = new Error("timeout");
    m = await usageFor(ORG, ACTIVE, { nowMs: NOW });
    expect(m).toMatchObject({ pct: 0, state: "fine", degraded: true });
    // A client that throws on rpc is the same open answer.
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: ACTIVE, error: null }) }) }) }), rpc: async () => { throw new Error("down"); } };
    m = await usageFor(ORG, undefined, { nowMs: NOW, client: broken });
    expect(m).toMatchObject({ pct: 0, state: "fine", degraded: true });
  });

  it("nonsense from the ledger is zero, never NaN", async () => {
    fake.spend = null;
    fake.topup = null;
    expect(await usageFor(ORG, ACTIVE, { nowMs: NOW })).toMatchObject({ pct: 0, spentUsd: 0, topupUsd: 0, state: "fine", degraded: false });
  });
});

describe("out — the boundary the model pick reads (lib/ai-cost tierOfUsage)", () => {
  it("out only at 100%: the percent is FLOORED, so 99.7% is 99 and still almost; a top-up turns out back; a failed read is never out", async () => {
    fake.spend = 29.8; // 99.3% → 99
    expect(await usageFor(ORG, ACTIVE, { nowMs: NOW })).toMatchObject({ pct: 99, state: "almost" });
    fake.spend = 29.9; // 99.7% floors to 99: the ring says 99%, so the model stays full — the two agree
    expect(await usageFor(ORG, ACTIVE, { nowMs: NOW })).toMatchObject({ pct: 99, state: "almost" });
    fake.spend = 30;
    expect(await usageFor(ORG, ACTIVE, { nowMs: NOW })).toMatchObject({ pct: 100, state: "out" });
    fake.topup = 10;
    expect((await usageFor(ORG, ACTIVE, { nowMs: NOW })).state).not.toBe("out");
    fake.topup = 0;
    fake.spendError = new Error("down");
    expect(await usageFor(ORG, ACTIVE, { nowMs: NOW })).toMatchObject({ state: "fine", degraded: true });
    expect(await usageFor(null)).toMatchObject({ state: "fine", degraded: true });
  });
});
