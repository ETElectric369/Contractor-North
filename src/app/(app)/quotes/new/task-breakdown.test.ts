import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TASK IS THE LINE, ON THE BUILDER (0386). A line that carries a breakdown shows its hours and
 * parts under the description and ASKS where a number is missing; a line without one renders
 * exactly as before. The rate the hours price at comes through THE one rule (laborRateFor) from the
 * org default the page hands in — pinned at the source, because a builder that forgets the prop
 * still compiles and prices every task's hours at $0 while saying "no company labor rate set".
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/quotes/new",
}));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => createElement("div", { "data-modal": "" }, children, footer),
  ModalActions: () => null,
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("./actions", () => ({
  saveQuote: vi.fn(),
  generateQuoteDraft: vi.fn(),
  generateQuoteDraftFromLeadPlans: vi.fn(),
  generateQuoteDraftFromPlan: vi.fn(),
  generateQuoteDraftFromSupplier: vi.fn(),
}));
vi.mock("../price-list/actions", () => ({ applyPriceBookReview: vi.fn() }));
vi.mock("../../price-list/kit-actions", () => ({ rememberTaskAsKit: vi.fn() }));
vi.mock("@/components/new-customer-inline", () => ({ NewCustomerInline: () => null }));

const { QuoteBuilder } = await import("./quote-builder");

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const builder = (p: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(QuoteBuilder as any, { customers: [], taxRates: [], salesTax: false, ...p }));

const taskLine = {
  description: "Install transfer switch",
  quantity: 1,
  unit: "ea",
  unit_price: 480,
  flag: "hours? · price? a 50 amp breaker",
  detail: {
    task_id: "t1",
    hours: null,
    rate: 145,
    units: null,
    kit_id: null,
    materials: [
      { code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 },
      { code: null, name: "a 50 amp breaker", qty: null, cost: null, sell: null },
    ],
  },
};

describe("a task line on the builder", () => {
  it("shows the breakdown: the hours box asks, each part has a count and a price box, and the sums read", () => {
    const html = builder({ seededLines: [taskLine] });
    expect(html).toContain('placeholder="hours?"');
    expect(html).toContain("× $145.00/h");
    expect(html).toContain('placeholder="Part"');
    expect(html).toContain('value="Transfer switch, 200A"');
    expect(html).toContain('value="a 50 amp breaker"');
    expect((html.match(/placeholder="how many"/g) ?? []).length).toBe(2);
    expect((html.match(/placeholder="price\?"/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="Remove This Part"');
    expect(html).toContain("Add A Part");
    expect(text(html)).toContain("Parts $480.00");
    // The flag still rides the line, and a breakdown that adds up prints no hand-price note.
    expect(text(html)).toContain("hours? · price? a 50 amp breaker");
    expect(text(html)).not.toContain("Price set by hand");
  });

  it("a Unit $ typed over the sum says the breakdown stays off the paper", () => {
    const html = builder({ seededLines: [{ ...taskLine, unit_price: 450 }] });
    expect(text(html)).toContain("Price set by hand — the breakdown stays off the paper");
  });

  it("a line without a breakdown renders exactly as before", () => {
    const plain = builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250 }] });
    expect(plain).not.toContain('placeholder="hours?"');
    expect(plain).not.toContain("Add A Part");
    expect(builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250, detail: null }] })).toBe(plain);
  });
});

describe("the rate reaches the builder through the one rule", () => {
  it("the page hands in the org default and the builder resolves it with laborRateFor", () => {
    const page = read("src/app/(app)/quotes/new/page.tsx");
    const tag = page.slice(page.indexOf("<QuoteBuilder"), page.indexOf("/>", page.indexOf("<QuoteBuilder")));
    expect(tag).toContain("defaultLaborRate={settings.default_labor_rate}");
    const src = read("src/app/(app)/quotes/new/quote-builder.tsx");
    expect(src).toContain('import { laborRateFor } from "@/lib/pricing/labor-rate";');
    expect(src).toContain("const rate = laborRateFor(levelRate, defaultLaborRate);");
    // Every edit of the breakdown re-prices through lineFromDetail; a customer switch through
    // repriceTaskLine, and never over a hand-set price.
    expect(src).toContain("onChange(lineFromDetail(line, next))");
    expect(src).toContain("detailExplains(l.detail, l) ? repriceTaskLine(l, rate) : l");
  });
});

describe("Remember As A Kit (W4)", () => {
  it("a task line offers the door; a line built from a kit names the kit and its units instead", () => {
    const html = builder({ seededLines: [taskLine] });
    expect(text(html)).toContain("Remember As A Kit");
    const fromKit = builder({
      seededLines: [{ ...taskLine, description: "Footings ×7", unit_price: 2510, detail: { ...taskLine.detail, hours: 14, units: 7, kit_id: "k1" } }],
      taskKits: [{ id: "k1", name: "Footing", unit: "footing" }],
    });
    expect(text(fromKit)).toContain("From the kit Footing · ×7 footing");
    expect(text(fromKit)).not.toContain("Remember As A Kit");
  });

  it("a plain line has no door, and the company's Kits switch off hides it", () => {
    expect(text(builder({ seededLines: [{ description: "Permit", quantity: 1, unit: "ea", unit_price: 250 }] }))).not.toContain("Remember As A Kit");
    expect(text(builder({ seededLines: [taskLine], kitsOn: false }))).not.toContain("Remember As A Kit");
  });
});
