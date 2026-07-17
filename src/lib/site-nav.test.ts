import { describe, expect, it } from "vitest";
import { pageSlugFromHref } from "./site-nav";

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
