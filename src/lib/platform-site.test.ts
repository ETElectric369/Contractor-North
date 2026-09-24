import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { isPlatformApexHost, isPlatformSiteInternalPath, platformSiteRewrite } from "./platform-site";

// Middleware hands every request it doesn't answer itself to updateSession (the Supabase session +
// auth guard). Stub it with a marker so a test can tell "passed through to the app, as before"
// apart from "answered here" without a database.
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: vi.fn(async () => NextResponse.json({ passedThrough: true }, { headers: { "x-test-passed-through": "1" } })),
}));

const { middleware } = await import("@/middleware");

async function hit(host: string, path: string) {
  const req = new NextRequest(`https://${host}${path}`, { headers: { host } });
  const res = await middleware(req);
  return {
    status: res.status,
    rewrite: res.headers.get("x-middleware-rewrite"),
    passedThrough: res.headers.get("x-test-passed-through") === "1",
  };
}

describe("isPlatformApexHost", () => {
  it("is the apex and www only", () => {
    expect(isPlatformApexHost("contractornorth.com")).toBe(true);
    expect(isPlatformApexHost("www.contractornorth.com")).toBe(true);
    expect(isPlatformApexHost("CONTRACTORNORTH.COM:443")).toBe(true);
    expect(isPlatformApexHost("contractornorth.com.")).toBe(true);
  });

  it("is never the app, an org subdomain, a custom domain or infra", () => {
    for (const h of [
      "app.contractornorth.com",
      "tahoe-deck.contractornorth.com",
      "api.contractornorth.com",
      "etelectricity.com",
      "tahoedeck.com",
      "contractornorth.com.evil.com",
      "notcontractornorth.com",
      "contractor-north.vercel.app",
      "localhost",
      "",
      null,
    ]) {
      expect(isPlatformApexHost(h), String(h)).toBe(false);
    }
  });
});

describe("platformSiteRewrite", () => {
  it("maps exactly three public paths", () => {
    expect(platformSiteRewrite("/")).toBe("/north-site");
    expect(platformSiteRewrite("/support")).toBe("/north-site/support");
    expect(platformSiteRewrite("/privacy")).toBe("/north-site/privacy");
    expect(platformSiteRewrite("/Privacy/")).toBe("/north-site/privacy");
  });

  it("has nothing else", () => {
    for (const p of ["/login", "/planner", "/terms", "/support/x", "/sitemap.xml", "/north-site", "/site/et-electric"]) {
      expect(platformSiteRewrite(p), p).toBeNull();
    }
  });

  it("recognises the internal namespace by name", () => {
    expect(isPlatformSiteInternalPath("/north-site")).toBe(true);
    expect(isPlatformSiteInternalPath("/North-Site/privacy")).toBe(true);
    expect(isPlatformSiteInternalPath("/north-sites")).toBe(false);
    expect(isPlatformSiteInternalPath("/privacy")).toBe(false);
  });
});

describe("middleware host gate for the platform pages", () => {
  it("rewrites the apex and www into the platform pages", async () => {
    for (const host of ["contractornorth.com", "www.contractornorth.com"]) {
      for (const [path, target] of [["/", "/north-site"], ["/support", "/north-site/support"], ["/privacy", "/north-site/privacy"]]) {
        const r = await hit(host, path);
        expect(r.passedThrough, `${host}${path}`).toBe(false);
        expect(r.rewrite && new URL(r.rewrite).pathname, `${host}${path}`).toBe(target);
      }
    }
  });

  it("still 404s everything else on the apex (the lockdown holds)", async () => {
    for (const path of ["/login", "/planner", "/site/et-electric", "/sw.js", "/sitemap.xml", "/north-site"]) {
      const r = await hit("contractornorth.com", path);
      expect(r.status, path).toBe(404);
      expect(r.rewrite, path).toBeNull();
      expect(r.passedThrough, path).toBe(false);
    }
  });

  it("never serves the platform pages on the app host: /, /support, /privacy go to the app as before", async () => {
    for (const path of ["/", "/support", "/privacy"]) {
      const r = await hit("app.contractornorth.com", path);
      expect(r.rewrite, path).toBeNull();
      expect(r.passedThrough, path).toBe(true);
    }
  });

  it("404s the internal namespace by name on every host", async () => {
    for (const host of ["app.contractornorth.com", "tahoe-deck.contractornorth.com", "etelectricity.com", "localhost"]) {
      for (const path of ["/north-site", "/north-site/privacy", "/NORTH-SITE/support/"]) {
        const r = await hit(host, path);
        expect(r.status, `${host}${path}`).toBe(404);
        expect(r.rewrite, `${host}${path}`).toBeNull();
      }
    }
  });

  it("leaves org sites exactly as they were", async () => {
    const sub = await hit("tahoe-deck.contractornorth.com", "/");
    expect(sub.rewrite && new URL(sub.rewrite).pathname).toBe("/site/tahoe-deck");

    const custom = await hit("etelectricity.com", "/");
    expect(custom.rewrite && new URL(custom.rewrite).pathname).toBe("/site/by-domain");

    // /privacy and /support on a tenant's domain are that tenant's own page slugs, not ours.
    const tenantPrivacy = await hit("etelectricity.com", "/privacy");
    expect(tenantPrivacy.rewrite && new URL(tenantPrivacy.rewrite).pathname).toBe("/site/by-domain/p/privacy");
    const subSupport = await hit("tahoe-deck.contractornorth.com", "/support");
    expect(subSupport.rewrite && new URL(subSupport.rewrite).pathname).toBe("/site/tahoe-deck/p/support");
  });

  it("keeps the dead reserved subdomains dead", async () => {
    const r = await hit("admin.contractornorth.com", "/privacy");
    expect(r.status).toBe(404);
    expect(r.rewrite).toBeNull();
  });
});
