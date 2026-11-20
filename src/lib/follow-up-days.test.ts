import { describe, it, expect, vi } from "vitest";

/**
 * EVERY WAIT HAS A DAY (NY-feeders, 0366), AND TWO WAITS NO LONGER HAVE ONE.
 *
 * A lead's follow-up day (snoozeInquiry) is gone since cn-v1170: the Leads list is the reminder.
 * An estimate's (setQuoteFollowUp, quote.followUp) is gone since cn-v1172: the Closing list is the
 * reminder (Erik, 2026-11-19: "Closing is the reminder yes"). The column stays in the database.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  writes: [] as { table: string; patch: Row; filters: unknown[][] }[],
  hits: 1,
  missing: false,
  tz: "America/Los_Angeles",
}));

function builder(table: string) {
  const filters: unknown[][] = [];
  let patch: Row | null = null;
  const run = () => {
    if (table === "organizations") return { data: { settings: { timezone: s.tz } }, error: null };
    if (patch) {
      if (s.missing && "follow_up_at" in patch) return { data: null, error: { code: "PGRST204", message: "Could not find the 'follow_up_at' column of 'quotes' in the schema cache" } };
      s.writes.push({ table, patch, filters });
      return { data: Array.from({ length: s.hits }, (_, i) => ({ id: `row-${i}` })), error: null };
    }
    return { data: null, error: null };
  };
  const b: any = {
    select: () => b,
    update: (p: Row) => ((patch = p), b),
    limit: () => b,
    maybeSingle: async () => run(),
    then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
  };
  for (const m of ["eq", "in", "is", "order"]) b[m] = (...a: unknown[]) => (filters.push([m, ...a]), b);
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

describe("an estimate has no follow-up day (cn-v1172)", () => {
  it("the server action is gone, and nothing the estimate doors write names follow_up_at", async () => {
    const actions = await import("@/app/(app)/quotes/actions");
    expect("setQuoteFollowUp" in actions).toBe(false);
    expect(s.writes.some((w) => "follow_up_at" in w.patch)).toBe(false);
  }, 30_000);
});

describe("the registry and Nort", () => {
  // cn-v1170: a lead has no follow-up day any more (a lead on the Leads list IS the reminder), so
  // inquiry.snooze left the registry; inquiry.markLost (Not Sold) stays.
  it("inquiry.markLost is a registry write Nort may run behind its switch; inquiry.snooze and quote.followUp are gone", async () => {
    const { AGENT_WRITE_ALLOWED, AGENT_TOOL_FEATURE } = await import("@/lib/actions/agent-tools");
    const { quoteActions } = await import("@/lib/actions/entities/quote");
    const { inquiryActions } = await import("@/lib/actions/entities/inquiry");
    expect(AGENT_WRITE_ALLOWED.has("inquiry.markLost")).toBe(true);
    expect(AGENT_WRITE_ALLOWED.has("quote.followUp")).toBe(false);
    expect("quote.followUp" in AGENT_TOOL_FEATURE).toBe(false);
    expect(AGENT_TOOL_FEATURE["inquiry.markLost"]).toBe("leads");
    expect(quoteActions["quote.followUp"]).toBeUndefined();
    expect(inquiryActions["inquiry.markLost"]).toMatchObject({ auth: "staff", effect: "write" });
    expect(inquiryActions["inquiry.snooze"]).toBeUndefined();
    expect(AGENT_WRITE_ALLOWED.has("inquiry.snooze")).toBe(false);
    expect("inquiry.snooze" in AGENT_TOOL_FEATURE).toBe(false);
    // inquiry.delete stays (it lives on /leads behind its ⋯), and stays out of Nort's reach.
    expect(inquiryActions["inquiry.delete"]).toBeDefined();
    expect(AGENT_WRITE_ALLOWED.has("inquiry.delete")).toBe(false);
    // The imports above load the whole action registry cold, inside the test: alone that takes about
    // 2 s, and in the full parallel run it once took past the 5 s default (the test itself is instant).
  }, 30_000);
});
