import { describe, it, expect } from "vitest";
import { classifyMapUrl, parseGeoFromMapUrl } from "./org-settings";
import { pageSlugFromPath, isLegacyCmsPath } from "./site-reserved";

/**
 * THE SEO BOUNDARIES — the rules the 2026-07-27 fine-tooth audit found broken, pinned so they
 * can't quietly come back. Each block names the live symptom it came from.
 */

describe("Google Business Profile link (the green check that lied)", () => {
  it("REJECTS the personalized search URL that was live on ET Electric", () => {
    // The actual value, verbatim from the homepage's JSON-LD on 2026-07-27. The form showed a
    // green "Linked to your Google Business Profile" for this, while the page shipped no geo
    // block at all — Tahoe Deck, same code, shipped one.
    const live =
      "https://www.google.com/search?q=ET+Electric&hl=en&mat=CVbilNUBnq7wElcBa0lj_0c2eumFHrhAlxpNQwHT9Tvm&authuser=1&dlnr=1";
    expect(classifyMapUrl(live)).toBe("personalized-search");
    expect(parseGeoFromMapUrl(live)).toBeNull();
  });

  it("ACCEPTS a real Maps place URL and pulls the pin coordinates", () => {
    // Tahoe Deck's live value — the shape that works.
    const good =
      "https://www.google.com/maps/place/Tahoe+Deck/@39.3657384,-120.212828,17z/data=!4m6!3m5!1s0x6388e5d9!8m2!3d39.3657384!4d-120.212828";
    expect(classifyMapUrl(good)).toBe("ok");
    expect(parseGeoFromMapUrl(good)).toEqual({ lat: 39.3657384, lng: -120.212828 });
  });

  it("treats a share short-link as valid but coordinate-less, not as an error", () => {
    // maps.app.goo.gl resolves to a real place at Google; it just carries no lat/lng in the
    // string. Calling that "wrong" would train people to ignore the warning.
    expect(classifyMapUrl("https://maps.app.goo.gl/abc123")).toBe("no-coords");
    expect(classifyMapUrl("https://www.google.com/maps?cid=1234567890")).toBe("no-coords");
  });

  it("flags a non-Google link, and says nothing at all when the field is empty", () => {
    expect(classifyMapUrl("https://yelp.com/biz/et-electric")).toBe("not-google");
    expect(classifyMapUrl("not a url")).toBe("not-google");
    expect(classifyMapUrl("")).toBe("empty");
    expect(classifyMapUrl(null)).toBe("empty");
  });
});

describe("old-CMS file URLs must not reach the app's auth guard", () => {
  // Live before the fix: etelectricity.com/index.html -> 307 -> /login?next=%2Findex.html.
  // A login screen on a contractor's marketing domain, for a URL that is simply gone.
  const LEGACY_FILE_EXT = /\.(html?|php|aspx?|jsp|cgi|cfm)$/i;
  const resolve = (path: string): string => {
    const p = path.replace(/\/+$/, "");
    if (LEGACY_FILE_EXT.test(p) && !p.slice(1).includes("/")) {
      const slug = pageSlugFromPath(p.replace(LEGACY_FILE_EXT, ""));
      return slug ? `/${slug}` : "/";
    }
    return "(falls through)";
  };

  it("sends a dotted legacy URL to the real page when the bare name is one", () => {
    expect(resolve("/about.html")).toBe("/about");
    expect(resolve("/panel-upgrades.php")).toBe("/panel-upgrades");
  });

  it("sends a reserved name home rather than to a login screen", () => {
    expect(resolve("/index.html")).toBe("/"); // "index" is reserved → no page candidate
  });

  it("hands an unknown name to the resolver, which 404s it honestly", () => {
    // /default.asp -> /default -> branded 404. One redirect then a real 404 is the right answer
    // for a URL that never existed: it matches the deliberate root-slug-miss policy (a miss is a
    // hard 404, not a soft-404 bounce to the homepage), and it beats the old 307-to-/login.
    expect(resolve("/default.asp")).toBe("/default");
    expect(resolve("/sitemap_index.xml")).toBe("(falls through)"); // .xml isn't a CMS page ext
  });

  it("leaves multi-segment and extension-less paths to the existing rules", () => {
    expect(resolve("/services/lighting.html")).toBe("(falls through)");
    expect(isLegacyCmsPath("/services/lighting.html")).toBe(true); // → 301 home, as before
    expect(resolve("/about")).toBe("(falls through)"); // → the page resolver, as before
  });
});

describe("the /site/ namespace is app-host-only", () => {
  // Live before the fix: https://etelectricity.com/site/tahoe-deck -> 200, serving Chris's whole
  // deck site on Erik's electrical domain (and the mirror image on tahoedeck.com). The route
  // resolves the org from the URL SEGMENT and never compares it to Host.
  const blockedOnTenantHost = (path: string, signedIn = false) =>
    path.toLowerCase().startsWith("/site/") && !signedIn;

  it("blocks the cross-tenant leak and the duplicate copies of the host's own site", () => {
    expect(blockedOnTenantHost("/site/tahoe-deck")).toBe(true);
    expect(blockedOnTenantHost("/site/tahoe-deck/p/about")).toBe(true);
    expect(blockedOnTenantHost("/site/et-electric")).toBe(true); // 3rd copy of ET's own homepage
    expect(blockedOnTenantHost("/site/by-domain")).toBe(true); // 4th copy
  });

  it("leaves the public root-level URLs alone — those are the real site", () => {
    for (const p of ["/", "/about", "/panel-upgrades", "/blog", "/blog/some-post"]) {
      expect(blockedOnTenantHost(p)).toBe(false);
    }
  });

  it("is case-insensitive — /SITE/ must 404 like /site/, not fall through to a login page", () => {
    // The route match is case-sensitive too, so /SITE/tahoe-deck never served content — but it
    // reached the auth guard and answered with a LOGIN PAGE on the marketing domain. Same URL,
    // same answer, whatever the crawler capitalised.
    expect(blockedOnTenantHost("/SITE/tahoe-deck")).toBe(true);
    expect(blockedOnTenantHost("/Site/Tahoe-Deck")).toBe(true);
  });

  it("lets a signed-in editor through, so draft preview keeps working", () => {
    // The preview links in Settings are relative, so they inherit whatever host the editor is
    // logged into. A crawler never carries a session cookie.
    expect(blockedOnTenantHost("/site/et-electric/p/about", true)).toBe(false);
  });
});
