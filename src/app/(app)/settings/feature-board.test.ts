import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SETTINGS > FEATURES, rendered (the switch board, 0352). What a person actually sees: one row per
 * switch with sub-switches nested, Title Case names, a 44px switch for the owner and a read-only
 * state with "Ask The Owner" for everyone else, "Off · N saved" when a switched-off feature holds
 * records, and the one-line confirm naming what stops.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));

import { FeatureBoard, stopsLine, type FeatureBoardProps } from "./feature-board";
import { ALL_ON, FEATURES, FEATURE_KEYS, featurePreset } from "@/lib/features";

const base: FeatureBoardProps = { features: ALL_ON, isOwner: true, counts: {}, siteName: null, crewQuiet: false, ready: true };
const render = (p: Partial<FeatureBoardProps> = {}) => renderToStaticMarkup(createElement(FeatureBoard, { ...base, ...p }));
const switches = (html: string) => [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, "\n").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("the board", () => {
  it("one row per switch, in board order, sub-switches nested under their parent", () => {
    const html = render();
    let at = -1;
    for (const f of FEATURES) {
      const i = html.indexOf(`>${f.label.replace(/&/g, "&amp;")}<`);
      expect(i, f.label).toBeGreaterThan(at);
      at = i;
    }
    // A sub-switch's row is indented; a top-level row isn't.
    for (const f of FEATURES) {
      const i = html.indexOf(`>${f.label.replace(/&/g, "&amp;")}<`);
      const row = html.slice(html.lastIndexOf('<div class="flex min-h-11', i), i);
      expect(row.includes("pl-10"), f.key).toBe(!!f.parent);
    }
  });

  it("the owner gets one 44px switch per feature, named in Title Case, showing its state", () => {
    const m = { ...ALL_ON, kits: false, sales_tax: false };
    const sw = switches(render({ features: m }));
    expect(sw).toHaveLength(FEATURE_KEYS.length);
    for (const b of sw) {
      expect(b).toMatch(/\bh-11\b/);
      expect(b).toMatch(/\bmin-w-11\b/);
      const label = b.match(/aria-label="([^"]+)"/)![1].replace(/&amp;/g, "&");
      for (const w of label.split(" ")) if (w !== "&") expect(w[0], label).toMatch(/[A-Z]/);
    }
    expect(sw.filter((b) => b.includes('aria-checked="false"'))).toHaveLength(2);
    expect(sw.find((b) => b.includes("Kits &amp; Sizing"))).toContain('aria-label="Turn On Kits &amp; Sizing By Sq Ft"');
    expect(sw.find((b) => b.includes("Estimates"))).toContain('aria-label="Turn Off Estimates"');
  });

  it("a switched-off feature with records says how many are saved", () => {
    const html = text(render({ features: { ...ALL_ON, panel_map: false }, counts: { panel_map: 21, recurring_billing: 0 } }));
    expect(html).toContain("Off · 21 saved");
    // No count, or zero, says nothing extra.
    expect(text(render({ features: { ...ALL_ON, panel_map: false }, counts: { panel_map: 0 } }))).not.toMatch(/\d+ saved/);
    expect(text(render({ features: { ...ALL_ON, panel_map: false } }))).not.toMatch(/\d+ saved/);
  });

  it("anyone but the owner reads the state, with no switch, and is told who can change it", () => {
    const html = render({ isOwner: false, features: { ...ALL_ON, panel_map: false }, counts: { panel_map: 3 } });
    expect(switches(html)).toHaveLength(0);
    expect(html).not.toContain("<button");
    const t = text(html);
    expect(t).toContain("Only the owner can turn features on or off.");
    expect(t).toContain("Off · 3 saved · Ask The Owner");
    expect(t.match(/\nOn\n/g)?.length).toBe(FEATURE_KEYS.length - 1);
  });

  it("before the switches are on the database, no switch renders and the page says why", () => {
    const html = render({ ready: false });
    expect(switches(html)).toHaveLength(0);
    const t = text(html);
    expect(t).toContain("Features need an update from North before they can be changed.");
    expect(t).not.toContain("Ask The Owner"); // the owner is not told to ask themselves
  });

  it("anyone but the owner reads a sub-switch as Off while its parent is off; the owner's switch keeps what is stored", () => {
    const m = { ...ALL_ON, leads: false, referrals: true };
    const referralsRow = (html: string) => {
      const t = text(html);
      const i = t.indexOf("Track Referrals");
      return t.slice(i, t.indexOf("Estimates", i));
    };
    const staff = referralsRow(render({ isOwner: false, features: m, counts: { referrals: 2 } }));
    expect(staff).toContain("Off while Leads & Inspections is off.");
    expect(staff).toContain("Off · 2 saved · Ask The Owner");
    expect(staff.split("\n")).not.toContain("On");
    // The owner's switch is the stored value, so turning Leads back on brings Referrals back as it was.
    const owner = switches(render({ features: m }));
    expect(owner.find((b) => b.includes("Track Referrals"))).toContain('aria-checked="true"');
  });

  it("Crew & Payroll says it stays quiet until someone joins; a sub-switch says when its parent is off", () => {
    expect(text(render({ crewQuiet: true }))).toContain("Quiet until someone joins your team.");
    expect(text(render({ crewQuiet: false }))).not.toContain("Quiet until");
    expect(text(render({ features: { ...ALL_ON, website: false } }))).toContain("Off while Website is off.");
  });

  it("a blank company's board renders the light preset as it is", () => {
    const sw = switches(render({ features: featurePreset("") }));
    expect(sw.filter((b) => b.includes('aria-checked="true"'))).toHaveLength(8);
  });

  it("never promises what doesn't exist yet", () => {
    const t = text(render());
    expect(t).not.toMatch(/renewal alert|reminds you before/i);
  });
});

describe("the one-line confirm naming what stops", () => {
  it("the website names its address; recurring billing counts its invoices; the rest hide buttons", () => {
    expect(stopsLine("website", "etelectricity.com", undefined)).toBe("Unpublishes etelectricity.com.");
    expect(stopsLine("website", null, undefined)).toBe("Hides its buttons. Nothing is deleted.");
    expect(stopsLine("panel_map", "x.com", 5)).toBe("Hides its buttons. Nothing is deleted.");
  });

  it("Recurring Billing says what the engine does: only repeat invoices stop", () => {
    // recurring-engine skips only kind='invoice' while the switch is off; jobs and expenses run on.
    expect(stopsLine("recurring_billing", null, 2)).toBe("Stops 2 repeat invoices. Repeat jobs and expenses keep running.");
    expect(stopsLine("recurring_billing", null, 1)).toBe("Stops 1 repeat invoice. Repeat jobs and expenses keep running.");
    expect(stopsLine("recurring_billing", null, 0)).toBe("Hides its buttons. Repeat jobs and expenses keep running.");
    // A count that failed is not "nothing stops".
    expect(stopsLine("recurring_billing", null, undefined)).toBe("Stops repeat invoices. Repeat jobs and expenses keep running.");
  });

  it("Customer Portal says its links stop opening, not just that buttons hide", () => {
    // lib/portal/access answers portal_off before any sign-in; /i and /api/pay never read the switch.
    expect(stopsLine("customer_portal", "x.com", 4)).toBe("Your customers' portal links stop opening. Invoice and pay links still work.");
  });
});
