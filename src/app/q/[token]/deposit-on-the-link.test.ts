import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE DEPOSIT ON THE CUSTOMER'S LINK (cn-v1177). public_quote (0414) carries deposit_amount, deposit_state
 * ('none' | 'due' | 'requested' | 'paid') and can_take_card; the page reads them, prints one line under
 * the totals, and after the yes tells the truth in each state, with no dead end:
 *   due / requested + a card door → one button to /api/pay/deposit/<token>;
 *   paid → "Deposit received. Thank you.";
 *   a deposit but no card door → "A deposit of $X is due. We'll be in touch about how to pay it.";
 *   none (or a key missing: an estimate saved before 0414) → the line it always said, and nothing else.
 * Paying is never asked before the yes, and the Accept door itself makes no money record.
 * The page is rendered with react-dom/server over a mocked public_quote, the REAL accept widget inside.
 */
const state = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: async () => ({ data: state.data }) }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/pdf-cache", () => ({ sharePdfReady: async () => false }));
vi.mock("./actions", () => ({ acceptPublicQuote: vi.fn() }));
// THE CARD FEE (cn-v1178): the real cardFeeDecision, asked as if the fee were open, so the page's words for a
// fee can be seen (CARD_FEE_READY holds it shut in production today; the rule itself is not replaced).
const fee = vi.hoisted(() => ({ open: false }));
vi.mock("@/lib/org-settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/org-settings")>();
  return { ...real, cardFeeDecision: (b: number, p: number) => real.cardFeeDecision(b, p, fee.open) };
});

import PublicQuotePage from "./page";
import { PublicQuoteAccept } from "./accept";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

async function page(quote: Record<string, unknown>, opts: { phone?: string | null; search?: Record<string, string> } = {}): Promise<{ html: string; raw: string }> {
  state.data = {
    quote: {
      quote_number: "E-900",
      status: "accepted",
      title: "Snowbell deck",
      description: null,
      notes: null,
      tax_rate: 0,
      subtotal: 4800,
      tax: 0,
      total: 4800,
      valid_until: null,
      circuits: null,
      doc_type: "estimate",
      created_at: "2026-11-20T18:00:00Z",
      estimate_format: "tasks",
      ...quote,
    },
    items: [{ description: "Deck", quantity: 1, unit: "ea", unit_price: 4800, line_total: 4800, detail: null }],
    customer: { name: "Sam Tillery", company_name: null, address: "14 Larkspur Ln", unit: null, city: null, state: null, zip: null },
    site_candidates: [],
    org: { name: "Main Street Builders", phone: opts.phone ?? null },
  };
  const raw = renderToStaticMarkup(
    await PublicQuotePage({ params: Promise.resolve({ token: "tok-e900" }), searchParams: Promise.resolve(opts.search ?? {}) }),
  );
  return { html: text(raw), raw };
}

const THANKS = "Estimate accepted — thank you! We'll be in touch to schedule.";
const BUTTON = "Pay the Deposit · $480.00 by Card";

describe("the four states after the yes", () => {
  it("due, with a card door: the paper's line, the thank-you, and ONE button to the deposit door", async () => {
    const { html, raw } = await page({ deposit_amount: 480, deposit_state: "due", can_take_card: true });
    expect(html).toContain("Deposit due on acceptance: $480.00");
    expect(html).toContain(THANKS);
    expect(html).toContain(BUTTON);
    expect(raw.match(/href="\/api\/pay\/deposit\/tok-e900"/g)).toHaveLength(1);
  });

  it("requested (a bill exists, not paid): the same button (the door hands back that one bill)", async () => {
    const { html } = await page({ deposit_amount: "480.00", deposit_state: "requested", can_take_card: true });
    expect(html).toContain(BUTTON);
  });

  it("paid: says so, and offers nothing to pay", async () => {
    const { html, raw } = await page({ deposit_amount: 480, deposit_state: "paid", can_take_card: true });
    expect(html).toContain("Deposit received. Thank you.");
    expect(html).not.toContain("Pay the Deposit");
    expect(raw).not.toContain("/api/pay/deposit/");
  });

  it("a deposit but no card door: says what is due and who acts next, no button", async () => {
    const { html, raw } = await page({ deposit_amount: 480, deposit_state: "due", can_take_card: false });
    expect(html).toContain("A deposit of $480.00 is due. We'll be in touch about how to pay it.");
    expect(raw).not.toContain("/api/pay/deposit/");
  });

  it("no deposit: today's line alone, and no deposit line on the paper", async () => {
    for (const q of [{ deposit_amount: 0, deposit_state: "none", can_take_card: true }, { deposit_amount: null, deposit_state: "none", can_take_card: true }]) {
      const { html, raw } = await page(q);
      expect(html).toContain(THANKS);
      expect(html).not.toContain("Deposit");
      expect(raw).not.toContain("/api/pay/deposit/");
    }
  });

  it("an estimate saved before 0414, or a projection without the keys: nothing stated, nothing offered", async () => {
    const { html } = await page({});
    expect(html).toContain(THANKS);
    expect(html).not.toContain("Deposit");
    // A state that is not one of the four is no deposit either.
    expect((await page({ deposit_amount: 480, deposit_state: "owed", can_take_card: true })).html).not.toContain("Deposit");
  });

  it("before the yes: the paper states the deposit, the page offers only Accept (paying is never required to accept)", async () => {
    const { html, raw } = await page({ status: "sent", deposit_amount: 480, deposit_state: "due", can_take_card: true });
    expect(html).toContain("Deposit due on acceptance: $480.00");
    expect(html).toContain("Accept This Estimate");
    expect(raw).not.toContain("/api/pay/deposit/");
  });

  it("the card door came back refused: one plain line with the company's phone, and the button to try again", async () => {
    const withPhone = await page({ deposit_amount: 480, deposit_state: "due", can_take_card: true }, { phone: "(555) 010-0199", search: { deposit: "unavailable" } });
    expect(withPhone.html).toContain("We couldn't open the deposit payment just now. Try again, or call us at (555) 010-0199.");
    expect(withPhone.html).toContain(BUTTON);
    const noPhone = await page({ deposit_amount: 480, deposit_state: "due", can_take_card: true }, { search: { deposit: "unavailable" } });
    expect(noPhone.html).toContain("We couldn't open the deposit payment just now. Try again in a few minutes.");
  });
});

describe("cn-v1178: the button names what the card door charges; the paper says when it was received", () => {
  it("partly paid (0416's deposit_due): says what was received and what is left, and the button names what is left", async () => {
    const { html } = await page({ deposit_amount: 480, deposit_state: "requested", deposit_due: 280, can_take_card: true });
    expect(html).toContain("We received $200.00 of your $480.00 deposit. $280.00 is left.");
    expect(html).toContain("Pay the Deposit · $280.00 by Card");
    expect(html).not.toContain(BUTTON);
  });

  it("an unpaid request: the whole ask; a projection from before 0416 (no deposit_due): the ask, as before", async () => {
    expect((await page({ deposit_amount: 480, deposit_state: "requested", deposit_due: 480, can_take_card: true })).html).toContain(BUTTON);
    expect((await page({ deposit_amount: 480, deposit_state: "requested", can_take_card: true })).html).toContain(BUTTON);
  });

  it("a company that charges a card fee: the button names the total with the fee and says the fee, the invoice page's way", async () => {
    fee.open = true;
    try {
      const { html } = await page({ deposit_amount: 480, deposit_state: "requested", deposit_due: 280, can_take_card: true, card_fee_percent: 3 });
      expect(html).toContain("Pay the Deposit · $288.40 by Card");
      expect(html).toContain("Includes a 3% card processing fee of $8.40.");
      const none = await page({ deposit_amount: 480, deposit_state: "requested", deposit_due: 280, can_take_card: true, card_fee_percent: 0 });
      expect(none.html).toContain("Pay the Deposit · $280.00 by Card");
      expect(none.html).not.toContain("processing fee");
    } finally {
      fee.open = false;
    }
  });

  it("paid: the paper says Deposit received with the amount, never Deposit due on acceptance", async () => {
    const { html } = await page({ deposit_amount: 480, deposit_state: "paid", can_take_card: true });
    expect(html).toContain("Deposit received: $480.00");
    expect(html).not.toContain("Deposit due on acceptance");
  });

  it("an estimate taken back to draft (public_quote answers nothing): one plain, true sentence, not a dead 404", async () => {
    state.data = null;
    const raw = renderToStaticMarkup(await PublicQuotePage({ params: Promise.resolve({ token: "tok-e900" }), searchParams: Promise.resolve({}) }));
    expect(text(raw)).toContain("This page isn't available right now.");
    expect(text(raw)).toContain("If the company is updating it, they'll send it to you again when it's ready.");
  });
});

describe("the widget on its own", () => {
  it("open: Accept and Decline only, whatever the deposit says", () => {
    const html = text(renderToStaticMarkup(createElement(PublicQuoteAccept, { token: "t", accepted: false, brand: "#123456", docLabel: "Quote", deposit: { amount: 480, state: "due", canTakeCard: true } })));
    expect(html).toContain("Accept This Quote");
    expect(html).toContain("Decline This Quote");
    expect(html).not.toContain("Deposit");
  });
});

describe("the Accept door makes no money record; no customer file reads the word catalog", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("acceptPublicQuote names no payment request, and the link's files never import lib/i18n", () => {
    const actions = read("src/app/q/[token]/actions.ts");
    expect(actions).not.toMatch(/payment-request|createPaymentRequest|ensureDepositRequest|invoices"\)\.insert/);
    for (const f of ["src/app/q/[token]/page.tsx", "src/app/q/[token]/accept.tsx", "src/app/q/[token]/actions.ts", "src/app/api/pay/deposit/[token]/route.ts", "src/components/quote-document.tsx"])
      expect(read(f), f).not.toMatch(/@\/lib\/i18n|@\/lib\/words/);
  });
});
