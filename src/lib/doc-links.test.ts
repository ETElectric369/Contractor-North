import { describe, it, expect } from "vitest";
import { getOrgSettings, orgDocUrl, orgPublicBaseUrl } from "./org-settings";

/**
 * THE CUSTOMER-LINK RULE. Every URL that lands in a customer's hand is built on the CONTRACTOR'S
 * own domain, never the platform's and never the browser's.
 *
 * This rule was written four times and three were wrong. The invoice EMAIL used the org's domain
 * while the invoice TEXT, quotes, contracts and the portal used NEXT_PUBLIC_SITE_URL — so the same
 * document sent two ways pointed at two different companies. Four client components were worse
 * still: they built the customer's link from `window.location.origin`, i.e. whichever host the
 * STAFF MEMBER happened to be signed in on.
 *
 * The test that actually keeps this closed is the first one: same document, every channel, one URL.
 */

const ET = getOrgSettings({ custom_domain: "etelectricity.com", public_handle: "et-electric" });
const DECK = getOrgSettings({ custom_domain: "tahoedeck.com", public_handle: "tahoe-deck" });
const NEW_ORG = getOrgSettings({ public_handle: "brand-new" }); // signed up, no domain yet

describe("one document, one link, every channel", () => {
  it("the emailed invoice link and the texted invoice link are byte-identical", () => {
    const token = "abc123";
    const emailed = `${orgPublicBaseUrl(ET)}/i/${token}`; // lib/invoice-email.ts builds it this way
    const texted = orgDocUrl(ET, "i", token); // billing/actions.ts textInvoice
    expect(texted).toBe(emailed);
    expect(texted).toBe("https://etelectricity.com/i/abc123");
  });

  it("every customer-facing document type lands on the contractor's own domain", () => {
    expect(orgDocUrl(ET, "i", "t")).toBe("https://etelectricity.com/i/t"); // invoice
    expect(orgDocUrl(ET, "q", "t")).toBe("https://etelectricity.com/q/t"); // quote/estimate
    expect(orgDocUrl(ET, "c", "t")).toBe("https://etelectricity.com/c/t"); // contract to sign
    expect(orgDocUrl(ET, "portal", "t")).toBe("https://etelectricity.com/portal/t");
    expect(orgDocUrl(ET, "pick", "t")).toBe("https://etelectricity.com/pick/t"); // pick-a-date text
  });

  it("NEVER the platform's domain when the org has its own", () => {
    for (const prefix of ["i", "q", "c", "portal", "pick"] as const) {
      expect(orgDocUrl(ET, prefix, "t")).not.toContain("contractornorth.com");
      expect(orgDocUrl(ET, prefix, "t")).not.toContain("vercel.app");
    }
  });

  it("two tenants never borrow each other's domain", () => {
    expect(orgDocUrl(DECK, "q", "t")).toBe("https://tahoedeck.com/q/t");
    expect(orgDocUrl(ET, "q", "t")).not.toContain("tahoedeck");
    expect(orgDocUrl(DECK, "q", "t")).not.toContain("etelectricity");
  });

  it("an org with no custom domain falls back to its own subdomain, not the bare platform", () => {
    // A tenant mid-onboarding still gets a link that is THEIRS.
    expect(orgDocUrl(NEW_ORG, "i", "t")).toBe("https://brand-new.contractornorth.com/i/t");
  });
});
