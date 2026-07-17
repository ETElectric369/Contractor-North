import { describe, expect, it } from "vitest";
import { isReservedSlug, pageSlugFromPath, slugifySiteSlug } from "./site-reserved";

describe("isReservedSlug", () => {
  it("blocks homepage decoys — the homepage is '/', so /home must be impossible", () => {
    expect(isReservedSlug("home")).toBe(true);
    expect(isReservedSlug("index")).toBe(true);
    expect(isReservedSlug("homepage")).toBe(true);
    expect(isReservedSlug("Home")).toBe(true); // case-insensitive, like the route match
  });

  it("blocks app routes and content roots", () => {
    expect(isReservedSlug("login")).toBe(true);
    expect(isReservedSlug("settings")).toBe(true);
    expect(isReservedSlug("blog")).toBe(true);
  });

  it("keeps the marketing slugs people actually want", () => {
    expect(isReservedSlug("about")).toBe(false);
    expect(isReservedSlug("services")).toBe(false);
    expect(isReservedSlug("portfolio")).toBe(false);
  });
});

describe("pageSlugFromPath", () => {
  it("never resolves a homepage decoy to a page", () => {
    expect(pageSlugFromPath("/home")).toBeNull();
    expect(pageSlugFromPath("/index")).toBeNull();
    expect(pageSlugFromPath("/homepage")).toBeNull();
  });

  it("still resolves a legal marketing slug", () => {
    expect(pageSlugFromPath("/about")).toBe("about");
  });
});

describe("slugifySiteSlug", () => {
  // saveSitePage and the editor's pre-save reserved check share this — the pairs below pin the
  // normalization both sides must agree on.
  it("normalizes titles the way the save action stores them", () => {
    expect(slugifySiteSlug("Custom Lighting")).toBe("custom-lighting");
    expect(slugifySiteSlug("Tahoe's Best Decks!")).toBe("tahoes-best-decks");
    expect(slugifySiteSlug("  /Home/  ")).toBe("home"); // then caught by isReservedSlug
  });

  it("caps at 60 chars and strips edge hyphens", () => {
    expect(slugifySiteSlug("-a-".repeat(40)).length).toBeLessThanOrEqual(60);
    expect(slugifySiteSlug("--about--")).toBe("about");
  });
});
