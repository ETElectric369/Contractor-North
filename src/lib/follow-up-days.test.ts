import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * EVERY WAIT HAS A DAY (NY-feeders, 0366): the server piece Needs You wires (lane 5).
 *
 *   setQuoteFollowUp  the day to ask again about an unanswered estimate: writes follow_up_at and
 *                     NOTHING else (never valid_until, the customer's offer window), today or later,
 *                     a zero-row write said, and before 0366 a refusal in words.
 *
 * A lead's follow-up day (snoozeInquiry) is gone since cn-v1170: the Leads list is the reminder.
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

const { setQuoteFollowUp } = await import("@/app/(app)/quotes/actions");
const { todayStrInTz } = await import("@/lib/tz");
const { addDays } = await import("@/lib/come-back-days");
const today = () => todayStrInTz(s.tz);

beforeEach(() => {
  s.writes = [];
  s.hits = 1;
  s.missing = false;
});

describe("setQuoteFollowUp", () => {
  it("writes the follow-up day and nothing else: never valid_until", async () => {
    expect(await setQuoteFollowUp("q-1", addDays(today(), 3))).toEqual({ ok: true });
    expect(s.writes).toEqual([{ table: "quotes", patch: { follow_up_at: addDays(today(), 3) }, filters: [["eq", "id", "q-1"]] }]);
  });

  it("a past day is refused and nothing is written", async () => {
    expect(await setQuoteFollowUp("q-1", addDays(today(), -1))).toEqual({ ok: false, error: "Pick today or later" });
    expect(await setQuoteFollowUp("q-1", "next tuesday")).toEqual({ ok: false, error: "Pick a day." });
    expect(s.writes).toEqual([]);
  });

  it("a zero-row write is said", async () => {
    s.hits = 0;
    expect(await setQuoteFollowUp("q-gone", today())).toEqual({ ok: false, error: "That estimate could not be found." });
  });

  it("before 0366 (no follow_up_at column) the refusal says the database needs its update", async () => {
    s.missing = true;
    expect(await setQuoteFollowUp("q-1", today())).toEqual({
      ok: false,
      error: "This needs a quick database update before an estimate can take a follow-up day.",
    });
  });
});

describe("the registry and Nort", () => {
  // cn-v1170: a lead has no follow-up day any more (a lead on the Leads list IS the reminder), so
  // inquiry.snooze left the registry; inquiry.markLost (Not Sold) stays.
  it("quote.followUp and inquiry.markLost are registry writes Nort may run, each behind its switch; inquiry.snooze is gone", async () => {
    const { AGENT_WRITE_ALLOWED, AGENT_TOOL_FEATURE } = await import("@/lib/actions/agent-tools");
    const { quoteActions } = await import("@/lib/actions/entities/quote");
    const { inquiryActions } = await import("@/lib/actions/entities/inquiry");
    for (const name of ["quote.followUp", "inquiry.markLost"]) expect(AGENT_WRITE_ALLOWED.has(name), name).toBe(true);
    expect(AGENT_TOOL_FEATURE["quote.followUp"]).toBe("estimates");
    expect(AGENT_TOOL_FEATURE["inquiry.markLost"]).toBe("leads");
    expect(quoteActions["quote.followUp"]).toMatchObject({ auth: "staff", effect: "write" });
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
