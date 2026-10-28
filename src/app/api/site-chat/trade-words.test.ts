import { describe, it, expect, vi, beforeEach } from "vitest";
import { getOrgSettings } from "@/lib/org-settings";
import { DECK_ESTIMATE_CODES } from "@/lib/estimate/deck";

/**
 * THE SITE CHAT SPEAKS THE COMPANY'S TRADE (cn-v1135, lib/trade-nort tradeNort). Every company's
 * public Nort used to be told to quote "a like-for-like panel swap", that "Copper, breakers, EV
 * chargers and fixtures move month to month", to bundle "wire, nuts, staples", and to read "panel
 * brand & amperage" off a customer's photo. An electrician's pricing words are what they were (its
 * photo line drops ", deck size/shape", a Tahoe leftover on an electrician's prompt); a general
 * contractor's Nort gets the neutral set. And the deck tool is behind THE one gate (deckConfiguratorOn): a deck company
 * pricing from its catalog with the deck codes priced — never a catalog-mode landscaper who happens
 * to have three of those codes.
 *
 * The model is a recording fake: the route's one messages.create call is captured and answered with
 * plain text, so the system prompt and the tool list are read as sent.
 */
let stored: Record<string, unknown> = {};
let deckRows: { code: string; buy_price: number; markup_pct: number | null; updated_at: string }[] = [];
const org = () => ({
  id: "org-1",
  name: "Fixture Co",
  phone: null,
  email: null,
  license: null,
  logo_url: null,
  city: null,
  state: null,
  updated_at: null,
  settings: getOrgSettings({ public_handle: "fixture", ...stored }),
});
vi.mock("@/lib/public-org", async (orig) => ({
  ...(await orig<typeof import("@/lib/public-org")>()),
  getPublicOrgByHandle: async (h: string) => (h === "fixture" ? org() : null),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => false, clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/ai-cost", () => ({ recordAiUsage: vi.fn(), aiSpendExceeded: async () => false, aiAllowed: async () => ({ ok: true }) }));
const create = vi.fn(async (_args: unknown) => ({ content: [{ type: "text", text: "Hello." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
vi.mock("@/lib/anthropic", () => ({ getAnthropic: () => ({ messages: { create } }) }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        then: (resolve: (v: unknown) => void) => resolve({ data: table === "price_list_items" ? deckRows : [], error: null }),
      };
      return q;
    },
  }),
}));

const { POST: chat } = await import("./route");

const ask = async () => {
  const res = await chat(new Request("https://x/api/site-chat", { method: "POST", body: JSON.stringify({ handle: "fixture", messages: [{ role: "user", content: "hi" }] }) }));
  expect(res.status).toBe(200);
  const call = create.mock.calls[0]?.[0] as unknown as { system: { text: string }[]; tools: { name: string }[] };
  return { system: call.system.map((b) => b.text).join("\n"), tools: call.tools.map((t) => t.name) };
};
/** Three of the deck codes priced: enough for the deck tool when the company is a deck company. */
const threeDeckCodes = () =>
  (DECK_ESTIMATE_CODES as readonly string[]).slice(0, 3).map((code) => ({ code, buy_price: 10, markup_pct: 20, updated_at: "2026-10-01" }));

beforeEach(() => {
  stored = {};
  deckRows = [];
  create.mockClear();
});

describe("the site chat's trade words", () => {
  it("the electrician's pricing words are unchanged; the photo line drops the deck leftover", async () => {
    stored = { trade: "electrical", estimating_mode: "research" };
    const { system, tools } = await ask();
    expect(system).toContain("lists a SET PACKAGE price for the job (e.g. a like-for-like panel swap), quote THAT package directly");
    expect(system).toContain("Copper, breakers, EV chargers and fixtures move month to month, so research them live rather than guessing.");
    expect(system).toContain("BUNDLE the small stuff (wire, nuts, staples, screws, straps) into ONE sensible materials line");
    expect(system).toContain("identify what you can (e.g. panel brand & amperage, wiring/condition, access) and use it");
    expect(system).not.toContain("deck size/shape");
    expect(tools).toContain("web_search");
    expect(tools).not.toContain("deck_estimate");
  });

  it("a general contractor in research mode: the neutral words, and no electrician's part anywhere", async () => {
    stored = { trade: "general", estimating_mode: "research" };
    const { system } = await ask();
    expect(system).toContain("lists a SET PACKAGE price for the job (e.g. a set package the script prices for that kind of job), quote THAT package directly");
    expect(system).toContain("Material prices move month to month, so research them live rather than guessing.");
    expect(system).toContain("BUNDLE the small stuff (fasteners, clips, sealant and the small hardware) into ONE sensible materials line");
    expect(system).toContain("identify what you can (e.g. what's there, its size and condition, and the access) and use it");
    expect(system).not.toMatch(/panel|breaker|EV charger|amperage|wire/i);
  });

  it("a company whose trade isn't known gets the neutral words too", async () => {
    stored = { estimating_mode: "research" };
    const { system } = await ask();
    expect(system).toContain("(e.g. a set package the script prices for that kind of job)");
    expect(system).not.toMatch(/panel|breaker/i);
  });
});

describe("the deck tool is behind the one gate", () => {
  it("a deck company pricing from its catalog with the deck codes priced: the deck tool and the deck words", async () => {
    stored = { trade: "deck", estimating_mode: "catalog" };
    deckRows = threeDeckCodes();
    const { system, tools } = await ask();
    expect(tools).toContain("deck_estimate");
    expect(tools).not.toContain("web_search");
    expect(system).toContain("THIS IS A DECK COMPANY");
    expect(system).toContain("identify what you can (e.g. deck size/shape, its condition, and the access) and use it");
  });

  it("a catalog-mode landscaper with three of the deck codes priced gets no deck tool and is not called a deck company", async () => {
    stored = { trade: "landscaping", estimating_mode: "catalog" };
    deckRows = threeDeckCodes();
    const { system, tools } = await ask();
    expect(tools).not.toContain("deck_estimate");
    expect(system).not.toContain("THIS IS A DECK COMPANY");
    expect(tools).toContain("search_prices");
  });

  it("a deck company in research mode, or one with fewer than three deck codes priced, gets no deck tool either", async () => {
    stored = { trade: "deck", estimating_mode: "research" };
    deckRows = threeDeckCodes();
    expect((await ask()).tools).not.toContain("deck_estimate");
    create.mockClear();
    stored = { trade: "deck", estimating_mode: "catalog" };
    deckRows = threeDeckCodes().slice(0, 2);
    expect((await ask()).tools).not.toContain("deck_estimate");
  });
});
