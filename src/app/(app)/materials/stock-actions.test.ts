import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE TOOK FROM STOCK DOORS (Shop Stock, Phase 3): a count in, never a price; the job read inside
 * the caller's own company; a tech's take rings the office, one bell per take; nothing about money
 * comes back out, even when the database handed the office a cost.
 */

const afterCalls: (() => unknown)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => unknown) => afterCalls.push(fn) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const requireMember = vi.fn();
const requireStaff = vi.fn();
vi.mock("@/lib/staff-guard", () => ({ requireMember: () => requireMember(), requireStaff: () => requireStaff() }));
const takeFromStock = vi.fn();
const undoTake = vi.fn();
vi.mock("@/lib/stock-ledger", () => ({
  takeFromStock: (i: unknown) => takeFromStock(i),
  undoTake: (g: unknown) => undoTake(g),
  shelfForCrew: vi.fn(async () => ({ ok: true, rows: [] })),
  isMissingShelfRpc: () => false,
}));
const createNotifications = vi.fn(async () => true);
const officeRecipients = vi.fn(async () => ["boss-1"]);
vi.mock("@/lib/notifications", () => ({
  createNotifications: (...a: unknown[]) => (createNotifications as any)(...a),
  officeRecipients: (...a: unknown[]) => (officeRecipients as any)(...a),
}));
const sendPushToProfiles = vi.fn(async () => {});
vi.mock("@/lib/push", () => ({ sendPushToProfiles: (...a: unknown[]) => (sendPushToProfiles as any)(...a) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { takeFromStockAction, undoTakeAction } from "./stock-actions";

const ORG = "60195593-2e18-4230-bc8e-7a32d36d038d";
const JOB = "8760a051-0000-4000-8000-000000000011";
const ITEM = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";

/** The caller's client, recording every filter the job read makes. */
function member(staff: boolean, job: Record<string, unknown> | null = { id: JOB, job_number: "J-011", name: "Honeysuckle" }) {
  const filters: string[] = [];
  const builder: any = {
    select: () => builder,
    eq: (col: string, v: unknown) => {
      filters.push(`${col}=${String(v)}`);
      return builder;
    },
    maybeSingle: async () => ({ data: job, error: null }),
  };
  const supabase = { from: (t: string) => (filters.push(`from:${t}`), builder) };
  requireMember.mockResolvedValue({ supabase, userId: "u-brian", orgId: ORG, staff, name: "Brian" });
  return filters;
}

beforeEach(() => {
  afterCalls.length = 0;
  [requireMember, requireStaff, takeFromStock, undoTake, createNotifications, officeRecipients, sendPushToProfiles].forEach((f) => f.mockClear());
  takeFromStock.mockResolvedValue({ ok: true, drawGroup: GROUP, item: "12/2 NM-B", unit: "ft", qty: 60, short: 0, onHand: 190, cost: 43.24 });
});

describe("takeFromStockAction: a count in, never a price", () => {
  it.each([["cost"], ["unit_price"], ["amount"], ["price"]])("refuses a %s before it signs anyone in or takes anything", async (key) => {
    const r = await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60, [key]: 1 });
    expect(r).toEqual({ ok: false, error: "Took From Stock takes a count, never a price. Nothing was taken." });
    expect(requireMember).not.toHaveBeenCalled();
    expect(takeFromStock).not.toHaveBeenCalled();
  });

  it("refuses a count of nothing in words", async () => {
    expect(await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 0 })).toEqual({ ok: false, error: "Say how many you took." });
  });

  it("reads the job inside the caller's own company, and a job outside it takes nothing", async () => {
    const filters = member(false, null);
    const r = await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60 });
    expect(r.ok).toBe(false);
    expect(filters).toEqual(["from:jobs", `id=${JOB}`, `org_id=${ORG}`]);
    expect(takeFromStock).not.toHaveBeenCalled();
  });

  it("hands back counts and the plan's words, and never a cost, even the office's", async () => {
    member(true);
    const r = await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60 });
    expect(r).toEqual({ ok: true, drawGroup: GROUP, item: "12/2 NM-B", unit: "ft", qty: 60, short: 0, onHand: 190, message: "Took 60 ft of 12/2 NM-B for Honeysuckle" });
    expect(JSON.stringify(r)).not.toContain("43.24");
    expect(takeFromStock).toHaveBeenCalledWith({ itemId: ITEM, jobId: JOB, qty: 60, note: null, source: "office" });
  });

  it("names the source: the crew's take is the crew's, and the office's tap on Nort's card is Nort's", async () => {
    member(false);
    await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60, via: "nort" });
    expect(takeFromStock.mock.calls[0][0].source).toBe("crew");
    member(true);
    await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60, via: "nort" });
    expect(takeFromStock.mock.calls[1][0].source).toBe("nort");
  });

  it("a crew take rings the office once, bell and push, after the answer", async () => {
    member(false);
    await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60 });
    expect(createNotifications).not.toHaveBeenCalled(); // not before the answer
    expect(afterCalls).toHaveLength(1);
    await afterCalls[0]();
    expect(createNotifications).toHaveBeenCalledTimes(1);
    expect((createNotifications.mock.calls[0] as any[])[1]).toEqual(["boss-1"]);
    expect((createNotifications.mock.calls[0] as any[])[2]).toMatchObject({ type: "stock_taken", title: "Brian took 60 ft of 12/2 NM-B for Honeysuckle", url: `/jobs/${JOB}?tab=materials` });
    expect(sendPushToProfiles).toHaveBeenCalledTimes(1);
  });

  it("a crew take past the shelf rings with what the shelf said, and points at Shop Stock", async () => {
    member(false);
    takeFromStock.mockResolvedValue({ ok: true, drawGroup: GROUP, item: "12/2 NM-B", unit: "ft", qty: 20, short: 15, onHand: -15 });
    const r = await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 20 });
    expect(r.ok && r.message).toBe("Took 20 ft of 12/2 NM-B for Honeysuckle. 15 ft more than stock shows — the office will settle it.");
    await afterCalls[0]();
    expect((createNotifications.mock.calls[0] as any[])[2]).toMatchObject({
      title: "Brian took 20 ft of 12/2 NM-B, stock showed 5 ft",
      body: "For Honeysuckle. File the roll on Shop Stock, then Settle From Stock — or Undo the take.",
      url: `/inventory?item=${ITEM}`, // opens on the item, where Settle From The Shelf is
    });
  });

  it("the office's own take is its own news: no bell", async () => {
    member(true);
    await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60 });
    expect(afterCalls).toHaveLength(0);
  });
});

describe("undoTakeAction", () => {
  it("passes the database's refusal through in its own words (it names the invoice)", async () => {
    member(false);
    undoTake.mockResolvedValue({ ok: false, error: "INV-078 already bills these pieces. Take them off INV-078 first, then undo." });
    expect(await undoTakeAction(GROUP, JOB)).toEqual({ ok: false, error: "INV-078 already bills these pieces. Take them off INV-078 first, then undo." });
  });
  it("says it's already undone rather than a silent ok", async () => {
    member(false);
    undoTake.mockResolvedValue({ ok: true, undone: 0 });
    expect((await undoTakeAction(GROUP, JOB)).ok).toBe(false);
  });
  it("refuses a group that isn't an id before signing anyone in", async () => {
    expect((await undoTakeAction("not-a-group")).ok).toBe(false);
    expect(requireMember).not.toHaveBeenCalled();
  });
});

/**
 * A SPANISH-SPEAKING CALLER IS ANSWERED IN SPANISH (cn-v1138). The words are read from the caller's own
 * profile (lib/lang-of callerLang) only where a refusal or an answer is said, never before sign-in and
 * never on a take that went through; the toast after Take It keeps lib/stock-take's words.
 */
describe("a Spanish-speaking caller (cn-v1138)", () => {
  /** A member whose profile says es: the client carries auth and answers the language read. */
  function spanishMember(staff: boolean) {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: { id: JOB, job_number: "J-011", name: "Honeysuckle" }, error: null }),
    };
    const profiles: any = { select: () => profiles, eq: () => profiles, limit: () => profiles, maybeSingle: async () => ({ data: { language: "es" }, error: null }) };
    const supabase = { auth: { getUser: async () => ({ data: { user: { id: "u-brian" } } }) }, from: (t: string) => (t === "profiles" ? profiles : builder) };
    requireMember.mockResolvedValue({ supabase, userId: "u-brian", orgId: ORG, staff, name: "Brian" });
  }

  it("Undo's refusal and its answer come back in Spanish", async () => {
    spanishMember(false);
    undoTake.mockResolvedValue({ ok: true, undone: 0 });
    expect(await undoTakeAction(GROUP, JOB)).toEqual({ ok: false, error: "Esa toma ya se deshizo. Recarga para ver cómo quedó." });
    undoTake.mockResolvedValue({ ok: true, undone: 1 });
    expect(await undoTakeAction(GROUP, JOB)).toEqual({ ok: true, message: "Deshecho: las piezas volvieron al inventario." });
  });

  it("a take the stock record did not answer is refused in Spanish; a take that went through keeps the plan's words", async () => {
    spanishMember(false);
    takeFromStock.mockResolvedValue({ ok: true, drawGroup: null });
    expect(await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60 })).toEqual({ ok: false, error: "El registro de inventario no dijo qué tomó. Recarga el trabajo para ver cómo quedó." });
    takeFromStock.mockResolvedValue({ ok: true, drawGroup: GROUP, item: "12/2 NM-B", unit: "ft", qty: 60, short: 0, onHand: 190 });
    const r = await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 60 });
    expect(r.ok && r.message).toBe("Took 60 ft of 12/2 NM-B for Honeysuckle");
  });

  it("English callers are unchanged, and a refusal before sign-in has no profile to read, so it reads English", async () => {
    expect(await takeFromStockAction({ itemId: ITEM, jobId: JOB, qty: 0 })).toEqual({ ok: false, error: "Say how many you took." });
    expect(await undoTakeAction("not-a-group")).toEqual({ ok: false, error: "That take isn't one this job knows. Reload to see where it stands." });
    member(false);
    undoTake.mockResolvedValue({ ok: true, undone: 1 });
    expect(await undoTakeAction(GROUP, JOB)).toEqual({ ok: true, message: "Undone: the pieces are back in stock." });
  });
});
