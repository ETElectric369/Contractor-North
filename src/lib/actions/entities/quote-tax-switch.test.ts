import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SALES TAX OFF (0352, rule g) at Nort's quote doors and the chat's Save:
 *
 *  - quote.create / quote.update refuse a NEW tax rate in words the model can act on (never saved
 *    silently as 0); a rate of 0, or none, always passes, so a carried rate can still come off.
 *  - saveQuoteFromDraft (the Save on Nort's live preview) writes the estimate untaxed: neither the
 *    default rate nor a rate the model put on the draft reaches it.
 *  - On, or no switches stored: exactly today's calls.
 */
let settings: unknown = {};
const orgReads = vi.fn();
const client = {
  from: (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      ilike: () => b,
      limit: () => b,
      maybeSingle: async () => {
        if (table === "organizations") {
          orgReads();
          return { data: { settings }, error: null };
        }
        if (table === "tax_rates") return { data: { rate: 8.25 }, error: null };
        return { data: null, error: null };
      },
    };
    return b;
  },
  auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client }));
const updateQuoteMeta = vi.fn(async () => ({ ok: true }));
const saveQuote = vi.fn(async () => ({ ok: true, id: "q1", quote_number: "E-001", subtotal: 100, tax: 0, total: 100 }));
vi.mock("@/app/(app)/quotes/actions", () => ({
  saveQuote: (...a: unknown[]) => (saveQuote as any)(...a),
  updateQuoteMeta: (...a: unknown[]) => (updateQuoteMeta as any)(...a),
  findRecentDraftQuote: async () => null,
  addQuoteItem: vi.fn(),
  updateQuoteItem: vi.fn(),
  deleteQuoteItem: vi.fn(),
  createJobFromQuote: vi.fn(),
  updateQuoteStatus: vi.fn(),
  setQuoteType: vi.fn(),
  setQuoteCustomer: vi.fn(),
  setQuoteJob: vi.fn(),
  duplicateQuote: vi.fn(),
}));
vi.mock("../resolve-id", () => ({
  resolveCustomerId: async (_s: unknown, v: string | null) => ({ id: v }),
  resolveJobId: async (_s: unknown, v: string | null) => ({ id: v }),
  resolveQuoteId: async (_s: unknown, v: string | null) => ({ id: v }),
}));
const executeAction = vi.fn(async () => ({ ok: true, data: { id: "q1" } }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: (...a: unknown[]) => (executeAction as any)(...a) }));
vi.mock("@/lib/actions/agent-tools", () => ({ AGENT_WRITE_ALLOWED: new Set() }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn() }));

const { quoteActions } = await import("./quote");
const { saveQuoteFromDraft } = await import("@/app/(app)/assistant/actions");

beforeEach(() => {
  settings = {};
  orgReads.mockClear();
  updateQuoteMeta.mockClear();
  saveQuote.mockClear();
  executeAction.mockClear();
});

const update = (i: Record<string, unknown>) => quoteActions["quote.update"].handler(i as any, {} as any);
const create = (i: Record<string, unknown>) => quoteActions["quote.create"].handler(i as any, {} as any);

describe("quote.update / quote.create and the Sales Tax switch", () => {
  it("no switches stored: a rate goes through exactly as before", async () => {
    await update({ id: "q1", tax_rate: 0.0825 });
    expect(updateQuoteMeta).toHaveBeenCalledWith("q1", { tax_rate: 0.0825 });
    await create({ customer_id: null, title: "Panel", notes: "", tax_rate: 0.0825, valid_until: null, items: [] });
    expect(saveQuote).toHaveBeenCalledWith(expect.objectContaining({ tax_rate: 0.0825 }));
  });

  it("off: a new rate is refused in words, and nothing is written", async () => {
    settings = { features: { sales_tax: false } };
    const u = await update({ id: "q1", tax_rate: 0.0825 });
    expect(u).toMatchObject({ ok: false });
    expect((u as { error: string }).error).toContain("Sales Tax is off");
    expect(updateQuoteMeta).not.toHaveBeenCalled();
    const c = await create({ customer_id: null, title: "Panel", notes: "", tax_rate: 0.0825, valid_until: null, items: [] });
    expect(c).toMatchObject({ ok: false });
    expect(saveQuote).not.toHaveBeenCalled();
  });

  it("off: no rate, or 0, still works (a carried rate can come off), and costs no switch read", async () => {
    settings = { features: { sales_tax: false } };
    await update({ id: "q1", title: "Renamed" });
    await update({ id: "q1", tax_rate: 0 });
    expect(updateQuoteMeta).toHaveBeenCalledTimes(2);
    await create({ customer_id: null, title: "Panel", notes: "", tax_rate: 0, valid_until: null, items: [] });
    expect(saveQuote).toHaveBeenCalledTimes(1);
    expect(orgReads).not.toHaveBeenCalled();
  });
});

describe("Save on Nort's live estimate (saveQuoteFromDraft)", () => {
  const draft = { title: "Panel", items: [{ description: "Panel", quantity: 1, unit: "ea", unit_price: 100 }] } as any;
  const taxSent = () => (executeAction.mock.calls[0] as unknown as [string, { tax_rate: number }])[1].tax_rate;

  it("no switches stored: the default rate seeds it, as today", async () => {
    await saveQuoteFromDraft(draft);
    expect(taxSent()).toBeCloseTo(0.0825);
  });

  it("on: a rate the draft carries wins, as today", async () => {
    settings = { features: { sales_tax: true } };
    await saveQuoteFromDraft({ ...draft, tax_rate: 0.05 });
    expect(taxSent()).toBe(0.05);
  });

  it("off: untaxed, whatever the default or the draft says", async () => {
    settings = { features: { sales_tax: false } };
    await saveQuoteFromDraft({ ...draft, tax_rate: 0.05 });
    expect(taxSent()).toBe(0);
  });
});
