import { describe, it, expect } from "vitest";
import { isAppHostname, isDeadReservedHost, orgOwnsHost, mayServeOrgOnHost, normalizeHost } from "./public-host";
import { legacyAliasTarget, isLegacyCmsPath } from "./site-reserved";

const ET = { custom_domain: "etelectricity.com", public_handle: "et-electric" };
const DECK = { custom_domain: "tahoedeck.com", public_handle: "tahoe-deck" };

/**
 * THE WRONG-HOST LEAK. Three public routes take the org from the URL — /site/<handle>,
 * /estimate/<handle>, /inquire/<org-id> — and none of them compared it to the host the request
 * arrived on. Live before the fix:
 *     GET https://etelectricity.com/estimate/tahoe-deck   -> 200, Chris's configurator + pricing
 *     GET https://tahoedeck.com/inquire/<ET org id>       -> 200, Erik's phone, email, C-10 number
 */
describe("who may serve whose pages", () => {
  it("an org's own hosts serve it", () => {
    expect(orgOwnsHost(ET, "etelectricity.com")).toBe(true);
    expect(orgOwnsHost(ET, "www.etelectricity.com")).toBe(true);
    expect(orgOwnsHost(ET, "et-electric.contractornorth.com")).toBe(true);
  });

  it("THE LEAK: the other tenant's domain must not", () => {
    expect(orgOwnsHost(ET, "tahoedeck.com")).toBe(false);
    expect(orgOwnsHost(DECK, "etelectricity.com")).toBe(false);
    expect(mayServeOrgOnHost(DECK, "etelectricity.com")).toBe(false);
    expect(mayServeOrgOnHost(ET, "tahoedeck.com")).toBe(false);
    // …and not the other tenant's free subdomain either.
    expect(mayServeOrgOnHost(DECK, "et-electric.contractornorth.com")).toBe(false);
  });

  it("an app host renders another tenant ONLY to a signed-in human", () => {
    // Returning true here unconditionally made app.contractornorth.com an enumerable customer
    // directory: guess a handle, get that tenant's whole site, signed out. Live before the fix:
    //   GET https://app.contractornorth.com/site/tahoe-deck  -> 200  <title>TAHOE DECK …
    for (const h of ["app.contractornorth.com", "contractor-north.vercel.app", "localhost"]) {
      expect(mayServeOrgOnHost(DECK, h, false)).toBe(false); // anonymous → nothing
      expect(mayServeOrgOnHost(DECK, h, true)).toBe(true); // signed in → preview works
    }
  });

  it("a tenant's OWN host stays public — signed in or not", () => {
    // The whole point of a marketing site and a public lead form. This must never need a session.
    expect(mayServeOrgOnHost(ET, "etelectricity.com", false)).toBe(true);
    expect(mayServeOrgOnHost(DECK, "tahoedeck.com", false)).toBe(true);
    expect(mayServeOrgOnHost(DECK, "tahoe-deck.contractornorth.com", false)).toBe(true);
  });

  it("a session does NOT unlock the other tenant's domain", () => {
    // Being signed in is only ever an app-host allowance. It can never make one tenant's content
    // legitimate on another tenant's domain.
    expect(mayServeOrgOnHost(DECK, "etelectricity.com", true)).toBe(false);
    expect(mayServeOrgOnHost(ET, "tahoedeck.com", true)).toBe(false);
  });

  it("host comparison ignores port, case and a trailing dot", () => {
    expect(normalizeHost("ETELECTRICITY.COM:443")).toBe("etelectricity.com");
    expect(orgOwnsHost(ET, "ETELECTRICITY.COM")).toBe(true);
    expect(orgOwnsHost(ET, "etelectricity.com.")).toBe(true); // trailing-dot FQDN is the same host
  });

  it("an org with no domain configured is served nowhere at all until someone signs in", () => {
    // A brand-new tenant mid-onboarding owns no host yet. It must not be reachable anonymously
    // anywhere — including on the app host, where it would otherwise be part of the directory.
    const bare = { custom_domain: "", public_handle: "" };
    expect(orgOwnsHost(bare, "etelectricity.com")).toBe(false);
    expect(mayServeOrgOnHost(bare, "app.contractornorth.com", false)).toBe(false);
    expect(mayServeOrgOnHost(bare, "app.contractornorth.com", true)).toBe(true);
  });
});

describe("reserved subdomains name no org and must not serve the app", () => {
  // Each was serving its own indexable copy of the app landing page, with "Allow: /" robots and a
  // sitemap advertising ITSELF — contradicting the lockdown that already 404s the apex.
  it("404s api/admin/staging/mail/dev/preview", () => {
    for (const sub of ["api", "admin", "staging", "mail", "dev", "preview", "www"]) {
      expect(isDeadReservedHost(`${sub}.contractornorth.com`)).toBe(true);
    }
  });

  it("but NOT app — that one is the real app host", () => {
    expect(isDeadReservedHost("app.contractornorth.com")).toBe(false);
    expect(isAppHostname("app.contractornorth.com")).toBe(true);
  });

  it("and NOT a real tenant subdomain or a custom domain", () => {
    expect(isDeadReservedHost("et-electric.contractornorth.com")).toBe(false);
    expect(isDeadReservedHost("tahoedeck.com")).toBe(false);
    expect(isAppHostname("etelectricity.com")).toBe(false);
  });
});

describe("legacy URLs a crawler actually asks for", () => {
  it("sitemap aliases go to the real sitemap, not a login page", () => {
    // /sitemap_index.xml is what Yoast published for a decade; it was 307ing to /login.
    expect(legacyAliasTarget("/sitemap_index.xml")).toBe("/sitemap.xml");
    expect(legacyAliasTarget("/wp-sitemap.xml")).toBe("/sitemap.xml");
    expect(legacyAliasTarget("/sitemap")).toBe("/sitemap.xml");
  });

  it("index-page spellings go home", () => {
    expect(legacyAliasTarget("/index")).toBe("/");
    expect(legacyAliasTarget("/homepage")).toBe("/");
  });

  it("leaves the real sitemap and unknown paths alone", () => {
    expect(legacyAliasTarget("/sitemap.xml")).toBeNull();
    expect(legacyAliasTarget("/about")).toBeNull();
    expect(legacyAliasTarget("/panel-upgrades")).toBeNull();
  });

  it("legacy path matching is case-insensitive", () => {
    // /Services and /services are one URL; a case-sensitive test sent one of them to a login page.
    expect(isLegacyCmsPath("/Services")).toBe(true);
    expect(isLegacyCmsPath("/CONTACT")).toBe(true);
    expect(isLegacyCmsPath("/Gallery/photo-1")).toBe(true);
    expect(legacyAliasTarget("/SITEMAP_INDEX.XML")).toBe("/sitemap.xml");
  });
});
