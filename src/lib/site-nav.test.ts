import { describe, expect, it } from "vitest";
import { navPageLinks, pageSlugFromHref, sectionAnchor } from "./site-nav";

describe("pageSlugFromHref", () => {
  it("reads a root slug (org-host shape)", () => {
    expect(pageSlugFromHref("/portfolio")).toBe("portfolio");
    expect(pageSlugFromHref("/about")).toBe("about");
  });

  it("reads the app-host preview shape", () => {
    expect(pageSlugFromHref("/site/tahoe-deck/p/contact")).toBe("contact");
  });

  it("ignores trailing slashes, query strings, and hashes", () => {
    expect(pageSlugFromHref("/portfolio/")).toBe("portfolio");
    expect(pageSlugFromHref("/portfolio?utm=x")).toBe("portfolio");
    expect(pageSlugFromHref("/portfolio#top")).toBe("portfolio");
  });

  it("lowercases so matching is case-insensitive", () => {
    expect(pageSlugFromHref("/Portfolio")).toBe("portfolio");
  });

  it("degrades to empty on junk", () => {
    expect(pageSlugFromHref("")).toBe("");
    expect(pageSlugFromHref("/")).toBe("");
  });
});

describe("navPageLinks", () => {
  const pages = [
    { slug: "about", nav_label: "About" },
    { slug: "panel-upgrades", nav_label: "Panel upgrades" },
  ];

  it("uses root slugs on the org's own host (base '')", () => {
    expect(navPageLinks("", pages)).toEqual([
      { href: "/about", label: "About" },
      { href: "/panel-upgrades", label: "Panel upgrades" },
    ]);
  });

  it("uses the internal /p/<slug> route on the app host", () => {
    expect(navPageLinks("/site/tahoe-deck", pages)).toEqual([
      { href: "/site/tahoe-deck/p/about", label: "About" },
      { href: "/site/tahoe-deck/p/panel-upgrades", label: "Panel upgrades" },
    ]);
  });

  it("round-trips with pageSlugFromHref in both shapes", () => {
    for (const base of ["", "/site/tahoe-deck"]) {
      for (const link of navPageLinks(base, pages)) {
        expect(pages.some((p) => p.slug === pageSlugFromHref(link.href))).toBe(true);
      }
    }
  });

  it("handles no nav pages", () => {
    expect(navPageLinks("", [])).toEqual([]);
  });
});

describe("sectionAnchor", () => {
  it("stays bare on the homepage (anchorBase '') — identical pre-chrome markup", () => {
    expect(sectionAnchor("", "#work")).toBe("#work");
    expect(sectionAnchor("", "#contact-form")).toBe("#contact-form");
  });

  it("travels home from a subpage on the org's own host", () => {
    expect(sectionAnchor("/", "#work")).toBe("/#work");
  });

  it("travels home from an app-host subpage", () => {
    expect(sectionAnchor("/site/tahoe-deck", "#services")).toBe("/site/tahoe-deck#services");
  });
});
