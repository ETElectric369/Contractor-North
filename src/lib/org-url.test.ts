import { describe, it, expect } from "vitest";
import { orgPublicBaseUrl, DEFAULT_SETTINGS } from "@/lib/org-settings";

const settings = (over: Partial<typeof DEFAULT_SETTINGS>) => ({ ...DEFAULT_SETTINGS, ...over });

describe("orgPublicBaseUrl — per-org customer-link base", () => {
  it("prefers the org's custom domain", () => {
    expect(orgPublicBaseUrl(settings({ custom_domain: "etelectric369.com" }))).toBe("https://etelectric369.com");
  });

  it("strips a scheme/trailing slash a user may have pasted into custom_domain", () => {
    expect(orgPublicBaseUrl(settings({ custom_domain: "https://tahoedeck.com/" }))).toBe("https://tahoedeck.com");
  });

  it("falls back to the free {handle}.contractornorth.com subdomain when no custom domain", () => {
    expect(orgPublicBaseUrl(settings({ public_handle: "et-electric" }))).toBe("https://et-electric.contractornorth.com");
  });

  it("falls back to the platform URL when the org has neither domain nor handle", () => {
    // no NEXT_PUBLIC_SITE_URL in the test env → the built-in platform default
    expect(orgPublicBaseUrl(settings({}))).toBe("https://contractor-north.vercel.app");
  });
});
