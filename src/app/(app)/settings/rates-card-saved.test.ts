import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getOrgSettings } from "@/lib/org-settings";
import { COULD_NOT_REACH, saveWords } from "@/lib/save-words";

/**
 * THE RATES CARD TELLS THE TRUTH (cn-v1131). Erik: "i noticed the 145 on there and i thought i had
 * updated that in the backend to 135". Two cards hold two rates — Settings' default labor rate
 * prices an estimate's unnamed hours; a person's Team bill rate bills their clocked hours and prices
 * the estimate hours that name them — and neither card said what it drove. And the rates card's
 * Save said "Saved" whatever the server answered (the silent-write law): a refusal flashed the green
 * check; a call that THREW (the network, the server) inside the transition reached the error boundary
 * with no word on the card; and a pricing level's refusal was drawn inside the Sales Tax section,
 * invisible with that switch off. The words on each card are rendered; the Save's answer is DRIVEN
 * through the one rule it uses (lib/save-words) with the card's own mocked action; the handlers and
 * the refusal line's place are pinned (a click needs a DOM the unit project does not have).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const updateOrgSettings = vi.fn();
vi.mock("./actions", () => ({
  updateOrgSettings: (...a: unknown[]) => updateOrgSettings(...a),
  createTaxRate: vi.fn(),
  updateTaxRate: vi.fn(),
  setDefaultTaxRate: vi.fn(),
  deleteTaxRate: vi.fn(),
  createPricingLevel: vi.fn(),
  updatePricingLevel: vi.fn(),
  setDefaultPricingLevel: vi.fn(),
  deletePricingLevel: vi.fn(),
  updateMemberRate: vi.fn(),
}));

const { TaxRatesManager } = await import("./tax-rates-manager");
const { MemberRate } = await import("./member-rate");
const actions = await import("./actions");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const RATES = { default_labor_rate: 135, mileage_rate: 0.7, default_markup_pct: 20, material_markup_percent: 20, material_buffer_percent: 0 };
const FALLBACK = "Couldn't save the rates — try again.";

describe("the rates card's Save reads the server's answer (driven through saveWords with the card's action)", () => {
  it("a refusal is said in the server's words; one with no words gets the card's fallback", async () => {
    updateOrgSettings.mockResolvedValueOnce({ ok: false, error: "Only the owner changes rates." });
    expect(await saveWords(() => actions.updateOrgSettings(RATES), FALLBACK)).toBe("Only the owner changes rates.");
    expect(updateOrgSettings).toHaveBeenLastCalledWith(RATES);
    updateOrgSettings.mockResolvedValueOnce({ ok: false });
    expect(await saveWords(() => actions.updateOrgSettings(RATES), FALLBACK)).toBe(FALLBACK);
  });

  it("a call that threw (the network, the server) is the one unreachable line — never the error boundary", async () => {
    updateOrgSettings.mockRejectedValueOnce(new Error("fetch failed"));
    expect(await saveWords(() => actions.updateOrgSettings(RATES), FALLBACK)).toBe(COULD_NOT_REACH);
    expect(COULD_NOT_REACH).toBe("Couldn't reach the server — press Save again.");
  });

  it("only the server's ok earns the word Saved (null = nothing to say)", async () => {
    updateOrgSettings.mockResolvedValueOnce({ ok: true });
    expect(await saveWords(() => actions.updateOrgSettings(RATES), FALLBACK)).toBeNull();
    // An action that answers nothing at all is not a save.
    updateOrgSettings.mockResolvedValueOnce(undefined);
    expect(await saveWords(() => actions.updateOrgSettings(RATES), FALLBACK)).toBe(FALLBACK);
  });

  it("the card's three handlers go through that rule: Saved only on null, the words on the card otherwise", () => {
    const card = src("src/app/(app)/settings/tax-rates-manager.tsx");
    expect(card).toContain('import { saveWords } from "@/lib/save-words";');
    const save = card.slice(card.indexOf("const said = await saveWords(\n                  () => updateOrgSettings({ default_labor_rate: laborRate"), card.indexOf("setTimeout(() => setSavedLabor(false)"));
    expect(save.length).toBeGreaterThan(0);
    expect(save).toContain(`"Couldn't save the rates — try again.",`);
    expect(save).toMatch(/if \(said\) \{\s*setDefaultsError\(said\);\s*return;\s*\}\s*setSavedLabor\(true\);/);
    // The old shape — fire the save, flash the check — is gone, and no bare await of an action remains in a handler.
    expect(card).not.toMatch(/await updateOrgSettings\(/);
    expect(card).not.toMatch(/await createPricingLevel\(|await updatePricingLevel\(|await createTaxRate\(|await updateTaxRate\(/);
    expect(card).toContain("if (said) { setError(said); return; }"); // the pricing level
    expect(card).toContain("if (said) return setError(said);"); // the tax rate
  });

  it("the defaults' refusal is drawn beside Save; the card's own refusal line sits ABOVE every section, so a pricing level's refusal shows with Sales Tax off", () => {
    const card = src("src/app/(app)/settings/tax-rates-manager.tsx");
    expect(card).toContain("{defaultsError && <span className=\"text-sm text-red-600\">{defaultsError}</span>}");
    const errorLine = card.indexOf('{error && <p className="text-sm text-red-600">{error}</p>}');
    expect(errorLine).toBeGreaterThan(-1);
    expect(errorLine).toBeLessThan(card.indexOf("{salesTax && ("));
    expect(card.slice(card.indexOf("{salesTax && ("))).not.toContain("{error &&");
  });
});

describe("each card says what its rate drives", () => {
  const settings = getOrgSettings({ default_labor_rate: 135, features: { sales_tax: false } });
  const card = text(renderToStaticMarkup(createElement(TaxRatesManager, { taxRates: [], pricingLevels: [], settings })));

  it("Settings: the default labor rate prices the unnamed hours on an estimate; a person's rate is on the Team page", () => {
    expect(card).toContain("Default labor rate ($/hr)");
    expect(card).toContain("Prices the hours on an estimate when no person is named. A person's own rate is on the Team page.");
    // The pricing-level hint that pointed here stays.
    expect(card).toContain("Leave labor $/hr blank to use the org default ($135/hr).");
  });

  it("Team: the bill rate bills clocked hours on a T&M job and prices an estimate's hours that name the person", () => {
    const row = renderToStaticMarkup(createElement(MemberRate, { id: "p1", rate: 40, billRate: 135, costRate: null, paidByDraw: false }));
    expect(text(row)).toContain("Bill: bills this person's clocked hours on a T&M job, and prices their hours on an estimate that names them.");
    expect(row).toContain('title="Bills this person&#x27;s clocked hours on a T&amp;M job, and prices their hours on an estimate that names them."');
    // The pay box keeps its own words.
    expect(row).toContain('title="What you pay this person — job cost"');
  });
});
