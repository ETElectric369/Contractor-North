import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE SERVER'S ONE READ OF A COMPANY'S STANDING (cn-v1137). Nort's chat route, the voice gate, the
 * texting doors and the AI ceiling ask orgAccess before they spend on a company's behalf; it reads
 * the billing columns on the service client and answers accessState. It FAILS OPEN (a billing read
 * that fails never locks a contractor out of his own assistant mid-job, and the failure is filed),
 * and with billing off there is nothing to lapse from, so nobody is read at all. The refusal names
 * ONE action: the owner is told the door, everyone else who holds the key.
 */
const state = vi.hoisted(() => ({
  billingEnabled: true,
  row: null as Record<string, unknown> | null,
  error: null as null | { message: string },
  throwOnRead: false,
  reads: [] as { table: string; cols: string; eq: [string, unknown] }[],
  reportError: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  get billingEnabled() {
    return state.billingEnabled;
  },
}));
vi.mock("@/lib/observe", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/observe")>()), reportError: state.reportError }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const rec = { table, cols: "", eq: ["", null] as [string, unknown] };
      const chain = {
        select: (cols: string) => {
          rec.cols = cols;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          rec.eq = [col, val];
          return chain;
        },
        maybeSingle: async () => {
          state.reads.push({ ...rec });
          if (state.throwOnRead) throw new Error("connection reset");
          return { data: state.row, error: state.error };
        },
      };
      return chain;
    },
  }),
}));

import { orgAccess, refusalWords, ORG_ACCESS_COLUMNS } from "./org-access";
import { BILLING_COLUMNS } from "./subscription";

const NOW = Date.parse("2026-10-28T17:00:00Z");
const days = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const ORG = "9f1c2c1e-7b2a-4c3e-9d0a-1b2c3d4e5f60";
const base = {
  id: ORG,
  subscription_status: "trialing",
  trial_ends_at: days(3),
  current_period_end: null,
  comped_until: null,
};

beforeEach(() => {
  state.billingEnabled = true;
  state.row = null;
  state.error = null;
  state.throwOnRead = false;
  state.reads = [];
  state.reportError.mockClear();
});

describe("orgAccess", () => {
  it("reads the id and the billing columns on the service client, by the one id, and answers the live standing", async () => {
    state.row = { ...base };
    const r = await orgAccess(ORG, NOW);
    expect(r).toEqual({ state: { active: true, reason: "trial", daysLeft: 3, compedBy: null }, org: base, readFailed: false });
    expect(state.reads).toEqual([{ table: "organizations", cols: ORG_ACCESS_COLUMNS, eq: ["id", ORG] }]);
    for (const c of BILLING_COLUMNS) expect(ORG_ACCESS_COLUMNS).toContain(c);
    // The hot path reads the id and the billing columns, nothing more (skeptic #43, S8).
    expect(ORG_ACCESS_COLUMNS).toBe("id, subscription_status, trial_ends_at, current_period_end, comped_until");
    expect(state.reportError).not.toHaveBeenCalled();
  });

  it("a lapsed row answers inactive with the reason — the trial that ended, the card not updated, the plan canceled", async () => {
    state.row = { ...base, trial_ends_at: days(-1) };
    expect((await orgAccess(ORG, NOW)).state).toEqual({ active: false, reason: "trial_ended", daysLeft: 0, compedBy: null });
    state.row = { ...base, subscription_status: "past_due", current_period_end: days(-40) };
    expect((await orgAccess(ORG, NOW)).state).toMatchObject({ active: false, reason: "grace_spent" });
    state.row = { ...base, subscription_status: "canceled" };
    const canceled = await orgAccess(ORG, NOW);
    expect(canceled.state).toEqual({ active: false, reason: "canceled", daysLeft: null, compedBy: null });
    expect(canceled.readFailed).toBe(false);
    expect(canceled.org?.id).toBe(ORG);
    // A comped column is access whatever Stripe says.
    state.row = { ...base, subscription_status: "canceled", comped_until: days(30) };
    expect((await orgAccess(ORG, NOW)).state).toMatchObject({ active: true, reason: "comped", compedBy: "column" });
  });

  it("a failed read FAILS OPEN: active, readFailed true, no row, and the failure filed once under org-access:read with the company", async () => {
    state.error = { message: "could not connect to server" };
    const r = await orgAccess(ORG, NOW);
    expect(r).toEqual({ state: { active: true, reason: "active", daysLeft: null, compedBy: null }, org: null, readFailed: true });
    expect(state.reportError).toHaveBeenCalledTimes(1);
    expect(state.reportError).toHaveBeenCalledWith("org-access:read", { message: "could not connect to server" }, { orgId: ORG });
    // A thrown read (the client itself) is the same open door.
    state.error = null;
    state.throwOnRead = true;
    state.reportError.mockClear();
    const thrown = await orgAccess(ORG, NOW);
    expect(thrown.readFailed).toBe(true);
    expect(thrown.state.active).toBe(true);
    expect(state.reportError).toHaveBeenCalledTimes(1);
    expect(state.reportError.mock.calls[0][0]).toBe("org-access:read");
    expect((state.reportError.mock.calls[0][1] as Error).message).toBe("connection reset");
  });

  it("billing off (no Stripe key): everyone is active and nobody is read", async () => {
    state.billingEnabled = false;
    state.row = { ...base, subscription_status: "canceled" };
    expect(await orgAccess(ORG, NOW)).toEqual({ state: { active: true, reason: "active", daysLeft: null, compedBy: null }, org: null, readFailed: false });
    expect(state.reads).toEqual([]);
    expect(state.reportError).not.toHaveBeenCalled();
  });

  it("no company id, or a company that is not there: open, no row, not a failure", async () => {
    expect(await orgAccess(null, NOW)).toEqual({ state: { active: true, reason: "active", daysLeft: null, compedBy: null }, org: null, readFailed: false });
    expect(await orgAccess("", NOW)).toMatchObject({ readFailed: false });
    expect(state.reads).toEqual([]);
    state.row = null;
    expect(await orgAccess(ORG, NOW)).toEqual({ state: { active: true, reason: "active", daysLeft: null, compedBy: null }, org: null, readFailed: false });
    expect(state.reads).toHaveLength(1);
    expect(state.reportError).not.toHaveBeenCalled();
  });
});

describe("refusalWords: one action, in the company's own words", () => {
  const trialEnded = { active: false, reason: "trial_ended", daysLeft: 0, compedBy: null } as const;
  const graceSpent = { active: false, reason: "grace_spent", daysLeft: 0, compedBy: null } as const;
  const canceled = { active: false, reason: "canceled", daysLeft: null, compedBy: null } as const;

  it("the owner (and an admin) is told the door", () => {
    expect(refusalWords(trialEnded, "owner")).toBe("This company's free trial has ended, so Nort is paused. Pick a plan in Settings › Getting Paid.");
    expect(refusalWords(graceSpent, "admin")).toBe("This company's card was not updated in time, so Nort is paused. Pick a plan in Settings › Getting Paid.");
    expect(refusalWords(canceled, "owner", "Larkspur")).toBe("This company's plan has ended, so Nort is paused. Pick a plan in Settings › Getting Paid.");
  });

  it("a tech (or the office) is told who holds the key, by first name when known", () => {
    expect(refusalWords(trialEnded, "tech", "Larkspur")).toBe("This company's free trial has ended, so Nort is paused. Ask Larkspur to pick a plan.");
    expect(refusalWords(graceSpent, "office", "  Snowbell ")).toBe("This company's card was not updated in time, so Nort is paused. Ask Snowbell to pick a plan.");
    expect(refusalWords(canceled, "tech")).toBe("This company's plan has ended, so Nort is paused. Ask the owner to pick a plan.");
    expect(refusalWords(canceled, "tech", "   ")).toBe("This company's plan has ended, so Nort is paused. Ask the owner to pick a plan.");
    expect(refusalWords(canceled, null, null)).toBe("This company's plan has ended, so Nort is paused. Ask the owner to pick a plan.");
  });

  it("every refusal names exactly one action and ends with it", () => {
    for (const s of [trialEnded, graceSpent, canceled]) {
      for (const role of ["owner", "tech"]) {
        const w = refusalWords(s, role, "Larkspur");
        expect(w).toMatch(/\. (Pick a plan in Settings › Getting Paid|Ask Larkspur to pick a plan)\.$/);
        expect(w.split(". ").length).toBe(2);
      }
    }
  });
});
