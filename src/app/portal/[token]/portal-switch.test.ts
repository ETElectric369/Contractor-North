import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * CUSTOMER PORTAL OFF (the switch board, 0352, rule f), as the customer reads it.
 *
 *  - The portal pages say "This page is off for now. Ask your contractor." and nothing else: not
 *    "turned off, ask for a new one", because this same link works again when the switch is back on.
 *  - Send My Code and the code check say the same words.
 *  - An invoice email carries no portal button; the invoice link (and its pay door) never depended
 *    on it. On, or no switches stored, the email's link is exactly today's.
 * (readPortalAccess's order, off before any session, is pinned in lib/portal/access.test.)
 */
vi.mock("./actions", () => ({ checkPortalCode: vi.fn(), sendPortalCode: vi.fn(), signOutPortal: vi.fn() }));
vi.mock("@/components/portal/portal-sign-in", () => ({ PortalSignIn: () => null, PortalSignOut: () => null }));

const { portalGate, gateTitle } = await import("./gate");
const { sendRefusalWords, checkRefusalWords, PORTAL_OFF_WORDS } = await import("@/lib/portal/code-words");
const { invoicePortalLink } = await import("@/lib/invoice-email");
const { ALL_ON, normalizeFeatures } = await import("@/lib/features");

const TOKEN = "d".repeat(32);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

describe("the portal pages while the Customer Portal is off", () => {
  it("say the page is off for now and to ask the contractor, never 'ask for a new one'", () => {
    const html = renderToStaticMarkup(portalGate({ kind: "portal_off", orgName: "Fixture Electric" }, TOKEN) as ReactElement);
    expect(text(html)).toBe("This page is off for now. Ask your contractor.");
    expect(html).not.toContain("new one");
  });
  it("the tab's title never names a customer or a job", () => {
    expect(gateTitle({ kind: "portal_off", orgName: "Fixture Electric" })).toBe("Fixture Electric — Page off");
    expect(gateTitle({ kind: "portal_off", orgName: null })).toBe("Page off");
  });
  it("a link the OFFICE turned off still says what it always said", () => {
    const html = renderToStaticMarkup(portalGate({ kind: "off", orgName: "Fixture Electric" }, TOKEN) as ReactElement);
    expect(text(html)).toContain("This link was turned off. Ask Fixture Electric for a new one.");
  });
});

describe("the sign-in's words while it is off", () => {
  it("Send My Code and Open My Page both say it plainly", () => {
    expect(PORTAL_OFF_WORDS).toBe("This page is off for now. Ask your contractor.");
    expect(sendRefusalWords("off", "Fixture Electric")).toBe(PORTAL_OFF_WORDS);
    expect(checkRefusalWords("off", "Fixture Electric")).toBe(PORTAL_OFF_WORDS);
  });
});

describe("the portal button in an invoice email", () => {
  const SITE = "https://fixture.example";
  const live = { token: "a".repeat(32), enabled: true };
  // Today's expression, verbatim, for the byte-for-byte check.
  const today = (portal: { token: string | null; enabled: boolean } | null) =>
    portal?.token && portal.enabled ? `${SITE}/portal/${portal.token}` : undefined;

  it("no switches stored, or on: exactly today's link (and today's no-link for an off or missing link)", () => {
    for (const portal of [live, { ...live, enabled: false }, { token: null, enabled: true }, null]) {
      expect(invoicePortalLink(SITE, portal, ALL_ON)).toBe(today(portal));
      expect(invoicePortalLink(SITE, portal, normalizeFeatures({}))).toBe(today(portal));
      expect(invoicePortalLink(SITE, portal, null)).toBe(today(portal));
    }
    expect(invoicePortalLink(SITE, live, ALL_ON)).toBe(`${SITE}/portal/${live.token}`);
  });
  it("off: no portal button; another switch off changes nothing", () => {
    expect(invoicePortalLink(SITE, live, normalizeFeatures({ customer_portal: false }))).toBeUndefined();
    expect(invoicePortalLink(SITE, live, normalizeFeatures({ website: false, panel_map: false }))).toBe(today(live));
  });
});
