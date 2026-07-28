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

  it("app hosts may render any org — that is what preview and internal tools need", () => {
    for (const h of ["app.contractornorth.com", "contractor-north.vercel.app", "localhost", "127.0.0.1"]) {
      expect(mayServeOrgOnHost(DECK, h)).toBe(true);
      expect(mayServeOrgOnHost(ET, h)).toBe(true);
    }
  });

  it("host comparison ignores port, case and a trailing dot", () => {
    expect(normalizeHost("ETELECTRICITY.COM:443")).toBe("etelectricity.com");
    expect(orgOwnsHost(ET, "ETELECTRICITY.COM")).toBe(true);
    expect(orgOwnsHost(ET, "etelectricity.com.")).toBe(true); // trailing-dot FQDN is the same host
  });

  it("an org with no domain configured is served nowhere but an app host", () => {
    const bare = { custom_domain: "", public_handle: "" };
    expect(orgOwnsHost(bare, "etelectricity.com")).toBe(false);
    expect(mayServeOrgOnHost(bare, "app.contractornorth.com")).toBe(true);
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
