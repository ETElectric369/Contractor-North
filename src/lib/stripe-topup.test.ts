import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { reportError } from "@/lib/observe";
import { creditExtraUsage, creditMonth, findTopupSession, parseTopupMetadata } from "./stripe-topup";

/**
 * EXTRA USAGE, CREDITED FROM THE WEBHOOK (cn-v1140, 0401), without Stripe or a database:
 *
 *   parseTopupMetadata   the exact shape buyExtraUsage stamps is read; every other shape is refused
 *                        in words that name the one thing wrong;
 *   creditExtraUsage     unpaid answers "not paid" and asks the database nothing; paid lands the
 *                        rpc with the exact arguments; inserted true / false come back as they are;
 *                        a refused rpc, a read that failed, an answer with nothing in it and a paid
 *                        session with a bad shape all THROW, with the rpc's own words when it has them;
 *   creditMonth          the month the credit lands in: the LATER of the month the session was sold
 *                        for and the company's current month when the webhook lands, on the company's
 *                        own calendar (the caller's tz, else the company's row through the client; a
 *                        failed read is filed and the sold month stands);
 *   findTopupSession     the way back from a charge's PaymentIntent to its Extra usage session, or null.
 *
 * Ids here are stand-ins (sess-larkspur-1, pi-larkspur-1), never a vendor's real shape.
 */
const ORG = "0b0c0d0e-1111-4222-8333-444455556666";
const good = { kind: "extra_usage", org_id: ORG, month: "2026-10", usage_usd: "10" };
const TZ = "America/Los_Angeles";
/** The webhook landing in the month the session was sold for: 8 PM Pacific, Oct 15. */
const OCT = { tz: TZ, now: new Date("2026-10-16T03:00:00Z") };

beforeEach(() => vi.mocked(reportError).mockClear());

describe("parseTopupMetadata", () => {
  it("reads the exact shape the Add Usage door stamps, with usage_usd as a number", () => {
    expect(parseTopupMetadata(good)).toEqual({ ok: true, value: { orgId: ORG, month: "2026-10", usageUsd: 10 } });
    expect(parseTopupMetadata({ ...good, usage_usd: "12.5" })).toEqual({ ok: true, value: { orgId: ORG, month: "2026-10", usageUsd: 12.5 } });
    // A number already, and a key nobody asked for, both pass.
    expect(parseTopupMetadata({ ...good, usage_usd: 10, extra: "ignored" })).toMatchObject({ ok: true, value: { usageUsd: 10 } });
    // December and January are months; the case of the uuid does not matter.
    expect(parseTopupMetadata({ ...good, month: "2026-12" })).toMatchObject({ ok: true });
    expect(parseTopupMetadata({ ...good, month: "2027-01", org_id: ORG.toUpperCase() })).toMatchObject({ ok: true });
  });

  it("refuses every bad shape in words that name the one thing wrong", () => {
    const why = (meta: unknown) => {
      const r = parseTopupMetadata(meta);
      return r.ok ? "ok" : r.why;
    };
    expect(why(null)).toBe("the session carries no metadata");
    expect(why(undefined)).toBe("the session carries no metadata");
    expect(why("extra_usage")).toBe("the session carries no metadata");
    expect(why({})).toBe("the session's kind is not extra_usage");
    expect(why({ ...good, kind: "invoice_payment" })).toBe("the session's kind is not extra_usage");
    expect(why({ ...good, kind: undefined })).toBe("the session's kind is not extra_usage");
    expect(why({ ...good, org_id: "org-et" })).toBe("org_id is not a company id");
    expect(why({ ...good, org_id: undefined })).toBe("org_id is not a company id");
    expect(why({ ...good, org_id: 12 })).toBe("org_id is not a company id");
    expect(why({ ...good, month: "2026-1" })).toBe("month is not YYYY-MM");
    expect(why({ ...good, month: "2026-13" })).toBe("month is not YYYY-MM");
    expect(why({ ...good, month: "2026-00" })).toBe("month is not YYYY-MM");
    expect(why({ ...good, month: "October 2026" })).toBe("month is not YYYY-MM");
    expect(why({ ...good, month: "2026-10-01" })).toBe("month is not YYYY-MM");
    expect(why({ ...good, month: undefined })).toBe("month is not YYYY-MM");
    for (const bad of ["0", "-5", "abc", "", " ", "Infinity", "NaN", undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
      expect(why({ ...good, usage_usd: bad }), `usage_usd ${String(bad)}`).toBe("usage_usd is not a positive number");
    }
  });
});

describe("creditExtraUsage", () => {
  const rpcAnswering = (answer: { data: unknown; error: { message?: string } | null }) => {
    const rpc = vi.fn(async () => answer);
    return { sb: { rpc }, rpc };
  };
  const paid = (over: Record<string, unknown> = {}) => ({ id: "sess-larkspur-1", payment_status: "paid", metadata: { ...good }, ...over });

  it("a session that is not paid answers 'not paid' and asks the database nothing (the async event will come)", async () => {
    const { sb, rpc } = rpcAnswering({ data: { id: "topup-1", inserted: true }, error: null });
    expect(await creditExtraUsage(sb, paid({ payment_status: "unpaid" }), OCT)).toEqual({ credited: false, why: "not paid" });
    expect(await creditExtraUsage(sb, paid({ payment_status: "no_payment_required" }), OCT)).toEqual({ credited: false, why: "not paid" });
    expect(await creditExtraUsage(sb, paid({ payment_status: undefined }), OCT)).toEqual({ credited: false, why: "not paid" });
    // Unpaid first: a bad shape on a session nobody paid for is not a throw either.
    expect(await creditExtraUsage(sb, paid({ payment_status: "unpaid", metadata: { kind: "extra_usage" } }), OCT)).toEqual({ credited: false, why: "not paid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("paid: the rpc is called with the exact arguments, the session id trimmed, and inserted comes back as it is", async () => {
    const first = rpcAnswering({ data: { id: "topup-1", inserted: true }, error: null });
    expect(await creditExtraUsage(first.sb, paid({ id: " sess-larkspur-1 " }), OCT)).toEqual({ credited: true, inserted: true });
    expect(first.rpc).toHaveBeenCalledTimes(1);
    expect(first.rpc).toHaveBeenCalledWith("add_usage_topup", { p_org: ORG, p_month: "2026-10", p_usd: 10, p_session: "sess-larkspur-1" });
    // The replay: the same session again answers inserted false, and that is what the caller hears.
    const again = rpcAnswering({ data: { id: "topup-1", inserted: false }, error: null });
    expect(await creditExtraUsage(again.sb, paid(), OCT)).toEqual({ credited: true, inserted: false });
  });

  it("a refused rpc throws with the rpc's own words; a read that failed the same", async () => {
    const refused = rpcAnswering({ data: null, error: { message: "A usage top-up must add something." } });
    await expect(creditExtraUsage(refused.sb, paid(), OCT)).rejects.toThrow("add_usage_topup refused: A usage top-up must add something.");
    const noCompany = rpcAnswering({ data: null, error: { message: "No such company for a usage top-up." } });
    await expect(creditExtraUsage(noCompany.sb, paid(), OCT)).rejects.toThrow("No such company for a usage top-up.");
    const timedOut = rpcAnswering({ data: null, error: { message: "canceling statement due to statement timeout" } });
    await expect(creditExtraUsage(timedOut.sb, paid(), OCT)).rejects.toThrow("canceling statement due to statement timeout");
    const wordless = rpcAnswering({ data: null, error: {} });
    await expect(creditExtraUsage(wordless.sb, paid(), OCT)).rejects.toThrow("add_usage_topup refused: no words");
  });

  it("an answer with nothing in it throws (never a quiet credit, never a quiet skip)", async () => {
    for (const data of [null, undefined, {}, { id: "topup-1" }, { inserted: "yes" }, "ok"]) {
      const { sb } = rpcAnswering({ data, error: null });
      await expect(creditExtraUsage(sb, paid(), OCT), JSON.stringify(data ?? null)).rejects.toThrow("add_usage_topup answered nothing");
    }
  });

  it("a paid session with a bad shape, or no id, throws with the words and never reaches the database", async () => {
    const { sb, rpc } = rpcAnswering({ data: { id: "topup-1", inserted: true }, error: null });
    await expect(creditExtraUsage(sb, paid({ metadata: { ...good, usage_usd: "0" } }), OCT)).rejects.toThrow("the paid session cannot be credited: usage_usd is not a positive number");
    await expect(creditExtraUsage(sb, paid({ metadata: { ...good, org_id: "org-et" } }), OCT)).rejects.toThrow("the paid session cannot be credited: org_id is not a company id");
    await expect(creditExtraUsage(sb, paid({ metadata: { ...good, month: "2026-13" } }), OCT)).rejects.toThrow("the paid session cannot be credited: month is not YYYY-MM");
    await expect(creditExtraUsage(sb, paid({ metadata: { kind: "invoice_payment", org_id: ORG } }), OCT)).rejects.toThrow("the paid session cannot be credited: the session's kind is not extra_usage");
    await expect(creditExtraUsage(sb, paid({ metadata: null }), OCT)).rejects.toThrow("the paid session cannot be credited: the session carries no metadata");
    await expect(creditExtraUsage(sb, paid({ id: "   " }), OCT)).rejects.toThrow("the paid session cannot be credited: it has no id");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("creditMonth — the later of the sold month and the company's current month", () => {
  const settingsAnswering = (answer: { data: unknown; error: { message?: string } | null }) => {
    const calls: string[] = [];
    const from = vi.fn((table: string) => {
      calls.push(table);
      const q: any = { select: () => q, eq: () => q, maybeSingle: async () => answer };
      return q;
    });
    return { sb: { rpc: vi.fn(async () => ({ data: { inserted: true }, error: null })), from }, from, calls };
  };

  it("sold in October, landing in November (a Checkout opened at 11 PM Pacific on Oct 31, paid Nov 1): NOVEMBER, where the person can use it", async () => {
    expect(await creditMonth({ rpc: vi.fn() }, ORG, "2026-10", { tz: TZ, now: new Date("2026-11-01T09:00:00Z") })).toBe("2026-11"); // 1 AM Pacific, Nov 1
    expect(await creditMonth({ rpc: vi.fn() }, ORG, "2026-10", { tz: TZ, now: new Date("2026-11-02T15:00:00Z") })).toBe("2026-11");
    // December into January: "2027-01" is later than "2026-12" as text too.
    expect(await creditMonth({ rpc: vi.fn() }, ORG, "2026-12", { tz: TZ, now: new Date("2027-01-01T09:00:00Z") })).toBe("2027-01");
  });

  it("sold in October, landing the same evening (11 PM Pacific on Oct 31 is already Nov 1 in UTC): OCTOBER — the company's calendar, not UTC's", async () => {
    expect(await creditMonth({ rpc: vi.fn() }, ORG, "2026-10", { tz: TZ, now: new Date("2026-11-01T06:00:00Z") })).toBe("2026-10");
    expect(await creditMonth({ rpc: vi.fn() }, ORG, "2026-10", OCT)).toBe("2026-10");
    // A company on UTC at the same instant IS in November.
    expect(await creditMonth({ rpc: vi.fn() }, ORG, "2026-10", { tz: "UTC", now: new Date("2026-11-01T06:00:00Z") })).toBe("2026-11");
  });

  it("the sold month later than the current one (a zone ahead, a clock behind): the sold month stands — never earlier than what was bought", async () => {
    expect(await creditMonth({ rpc: vi.fn() }, ORG, "2026-11", OCT)).toBe("2026-11");
  });

  it("no tz from the caller: the company's own timezone is read through the client (organizations.settings), once", async () => {
    const { sb, from, calls } = settingsAnswering({ data: { settings: { timezone: "Pacific/Kiritimati" } }, error: null });
    // Noon UTC on Oct 31 is already Nov 1 on Kiritimati.
    expect(await creditMonth(sb, ORG, "2026-10", { now: new Date("2026-10-31T11:00:00Z") })).toBe("2026-11");
    expect(calls).toEqual(["organizations"]);
    expect(from).toHaveBeenCalledTimes(1);
    // No settings on the row: the default zone (Pacific) — at that instant still October.
    const bare = settingsAnswering({ data: { settings: null }, error: null });
    expect(await creditMonth(bare.sb, ORG, "2026-10", { now: new Date("2026-10-31T11:00:00Z") })).toBe("2026-10");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a timezone read that fails is filed and the sold month stands (never a guess at a zone); a client with no `from` and no tz: the sold month", async () => {
    const failed = settingsAnswering({ data: null, error: { message: "connection reset" } });
    expect(await creditMonth(failed.sb, ORG, "2026-10", { now: new Date("2026-11-02T15:00:00Z") })).toBe("2026-10");
    expect(reportError).toHaveBeenCalledWith("stripe-topup:timezone", expect.objectContaining({ message: "connection reset" }), { orgId: ORG, month: "2026-10" });
    const thrown = { rpc: vi.fn(), from: () => { throw new Error("no client"); } };
    expect(await creditMonth(thrown, ORG, "2026-10", { now: new Date("2026-11-02T15:00:00Z") })).toBe("2026-10");
    expect(await creditMonth({ rpc: vi.fn() }, ORG, "2026-10", { now: new Date("2026-11-02T15:00:00Z") })).toBe("2026-10");
  });

  it("creditExtraUsage lands the rpc on creditMonth's month: sold in October, paid in November → p_month 2026-11", async () => {
    const rpc = vi.fn(async () => ({ data: { id: "topup-1", inserted: true }, error: null }));
    const session = { id: "sess-larkspur-1", payment_status: "paid", metadata: { ...good } };
    expect(await creditExtraUsage({ rpc }, session, { tz: TZ, now: new Date("2026-11-02T15:00:00Z") })).toEqual({ credited: true, inserted: true });
    expect(rpc).toHaveBeenCalledWith("add_usage_topup", { p_org: ORG, p_month: "2026-11", p_usd: 10, p_session: "sess-larkspur-1" });
    // The same session paid the same evening lands in October.
    rpc.mockClear();
    await creditExtraUsage({ rpc }, session, { tz: TZ, now: new Date("2026-11-01T06:00:00Z") });
    expect(rpc).toHaveBeenCalledWith("add_usage_topup", expect.objectContaining({ p_month: "2026-10" }));
  });
});

describe("findTopupSession", () => {
  const topup = { id: "sess-larkspur-1", mode: "payment", payment_status: "paid", metadata: { ...good } };
  const stripeListing = (data: unknown[]) => {
    const list = vi.fn(async () => ({ data }));
    return { stripe: { checkout: { sessions: { list } } } as any, list };
  };

  it("asks Stripe for the one session of the charge's PaymentIntent and answers it when it is an Extra usage purchase", async () => {
    const { stripe, list } = stripeListing([topup]);
    expect(await findTopupSession(stripe, "pi-larkspur-1")).toBe(topup);
    expect(list).toHaveBeenCalledWith({ payment_intent: "pi-larkspur-1", limit: 1 });
  });

  it("answers null for no session, a session of another kind, a subscription-mode session, or no PaymentIntent at all", async () => {
    expect(await findTopupSession(stripeListing([]).stripe, "pi-larkspur-1")).toBeNull();
    expect(await findTopupSession(stripeListing([{ ...topup, metadata: { kind: "invoice_payment" } }]).stripe, "pi-larkspur-1")).toBeNull();
    expect(await findTopupSession(stripeListing([{ ...topup, metadata: null }]).stripe, "pi-larkspur-1")).toBeNull();
    expect(await findTopupSession(stripeListing([{ ...topup, mode: "subscription" }]).stripe, "pi-larkspur-1")).toBeNull();
    const { stripe, list } = stripeListing([topup]);
    expect(await findTopupSession(stripe, "")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
