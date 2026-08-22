import { describe, it, expect } from "vitest";
import {
  applySiteDoc,
  coerceSiteDoc,
  diffSiteDoc,
  extractSiteDoc,
  knownImageUrls,
  siteDocSeoChecks,
  type SiteDoc,
} from "./site-doc";

const PHOTO_A = "https://x.supabase.co/storage/v1/object/public/branding/org/portfolio-a.jpg";
const PHOTO_B = "https://x.supabase.co/storage/v1/object/public/branding/org/portfolio-b.jpg";

const base: SiteDoc = extractSiteDoc({
  splash_headline: "Custom Lighting, Truckee",
  splash_tagline: "Design-build electrical for the Sierra.",
  splash_bullets: "Panels\nEV chargers",
  service_area: "Truckee · North Lake Tahoe",
  portfolio: [
    { url: PHOTO_A, caption: "Great room" },
    { url: PHOTO_B, caption: "Exterior" },
  ],
  reviews: [{ name: "Pat", text: "Fantastic work.", rating: 5 }],
});

describe("the site document boundary — what a design may NEVER do", () => {
  it("an invented image URL is refused and NAMED, everywhere images live", () => {
    const { doc, dropped } = coerceSiteDoc(
      {
        ...base,
        splash_bg_url: "https://evil.example/x.jpg",
        portfolio: [{ url: "https://evil.example/y.jpg" }, { url: PHOTO_A }],
        home_blocks: [
          { type: "image", props: { url: "https://evil.example/z.jpg" } },
          { type: "gallery", props: { images: [{ url: PHOTO_B }, { url: "https://evil.example/q.jpg" }] } },
        ],
      },
      base,
    );
    expect(doc.splash_bg_url).toBe("");
    expect(doc.portfolio.map((p) => p.url)).toEqual([PHOTO_A]);
    expect(doc.home_blocks).toEqual([{ type: "gallery", props: { images: [{ url: PHOTO_B, alt: "" }] } }]);
    expect(dropped.length).toBeGreaterThanOrEqual(3);
  });

  it("a design may restyle testimonials, never write them", () => {
    const { doc, dropped } = coerceSiteDoc(
      { ...base, reviews: [{ name: "Fake", text: "Best contractor ever!!", rating: 5 }] },
      base,
    );
    expect(doc.reviews).toEqual(base.reviews);
    expect(dropped.some((d) => /review/.test(d))).toBe(true);
  });

  it("off-site links are stripped; on-site anchors survive", () => {
    const { doc, dropped } = coerceSiteDoc(
      {
        ...base,
        home_blocks: [
          { type: "button", props: { label: "Call now", href: "https://spam.example" } },
          { type: "button", props: { label: "Get an estimate", href: "#contact-form" } },
        ],
      },
      base,
    );
    expect(doc.home_blocks).toEqual([
      { type: "button", props: { label: "Get an estimate", href: "#contact-form", align: "left" } },
    ]);
    expect(dropped.some((d) => /off your site/.test(d))).toBe(true);
  });

  it("the GBP and booking links are wiring — a proposal cannot rewrite them", () => {
    const withLinks = { ...base, google_business_url: "https://maps.google.com/real", calendly_url: "https://calendly.com/real" };
    const { doc } = coerceSiteDoc({ ...withLinks, google_business_url: "https://evil.example", calendly_url: "https://evil.example" }, withLinks);
    expect(doc.google_business_url).toBe("https://maps.google.com/real");
    expect(doc.calendly_url).toBe("https://calendly.com/real");
  });
});

describe("REVIEWS SURVIVE THE ROUND TRIP VERBATIM — publish must never delete or truncate one", () => {
  it("13 reviews, one very long, come through capture→publish byte-identical", () => {
    const reviews = Array.from({ length: 13 }, (_, i) => ({
      name: `Customer ${i}`,
      text: i === 0 ? "x".repeat(900) : `Great work ${i}`,
      rating: 5,
    }));
    const doc = extractSiteDoc({ reviews });
    expect(doc.reviews).toEqual(reviews);
    expect(applySiteDoc({ reviews }, doc).reviews).toEqual(reviews);
  });

  it("and the drift diff SEES a 13th review added outside the studio", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ name: `C${i}`, text: `t${i}` }));
    const a = extractSiteDoc({ reviews: twelve });
    const b = extractSiteDoc({ reviews: [...twelve, { name: "New", text: "Added outside" }] });
    expect(diffSiteDoc(a, b)).toContain("Reviews");
  });

  it("a model echoing reviews back re-serialized is NOT a false refusal", () => {
    const withR = extractSiteDoc({ reviews: [{ name: "Pat", text: "Nice", rating: 5 }] });
    const { dropped } = coerceSiteDoc(
      { ...withR, reviews: [{ rating: 5, text: "Nice", name: "Pat" }] }, // key order shuffled
      withR,
    );
    expect(dropped.some((d) => /review/.test(d))).toBe(false);
  });
});

describe("AN ABSENT KEY KEEPS THE BASE — a partial proposal must not erase the site", () => {
  it("a doc returning only the headline keeps everything else", () => {
    const { doc } = coerceSiteDoc({ splash_headline: "New headline" }, base);
    expect(doc.splash_headline).toBe("New headline");
    expect(doc.splash_tagline).toBe(base.splash_tagline);
    expect(doc.splash_bullets).toBe(base.splash_bullets);
    expect(doc.portfolio).toEqual(base.portfolio);
    expect(doc.home_blocks).toEqual(base.home_blocks);
  });

  it("an explicit empty string is an intentional clear and passes through", () => {
    const { doc } = coerceSiteDoc({ splash_tagline: "" }, base);
    expect(doc.splash_tagline).toBe("");
  });
});

describe("the night-one levers — CTA label and heading typeface", () => {
  it("estimate_cta_label clamps to 40, absent keeps, '' clears", () => {
    const withLabel = extractSiteDoc({ estimate_cta_label: "Price my project" });
    expect(withLabel.estimate_cta_label).toBe("Price my project");
    expect(coerceSiteDoc({ estimate_cta_label: "x".repeat(99) }, base).doc.estimate_cta_label.length).toBe(40);
    expect(coerceSiteDoc({}, withLabel).doc.estimate_cta_label).toBe("Price my project");
    expect(coerceSiteDoc({ estimate_cta_label: "" }, withLabel).doc.estimate_cta_label).toBe("");
  });

  it("brand_font — the wordmark lever — is enum-or-base and independent of headings", () => {
    const b = extractSiteDoc({ site_font: "serif", brand_font: "condensed" });
    expect(b.site_font).toBe("serif");
    expect(b.brand_font).toBe("condensed");
    expect(coerceSiteDoc({ brand_font: "wingdings" }, b).doc.brand_font).toBe("condensed");
    expect(coerceSiteDoc({ brand_font: "default" }, b).doc.brand_font).toBe("default");
    expect(coerceSiteDoc({}, b).doc.brand_font).toBe("condensed");
  });

  it("site_font is enum-or-base", () => {
    expect(extractSiteDoc({ site_font: "serif" }).site_font).toBe("serif");
    expect(extractSiteDoc({ site_font: "comic sans" }).site_font).toBe("default");
    const serif = extractSiteDoc({ site_font: "serif" });
    expect(coerceSiteDoc({ site_font: "papyrus" }, serif).doc.site_font).toBe("serif");
    expect(coerceSiteDoc({ site_font: "soft" }, serif).doc.site_font).toBe("soft");
  });
});

describe("the main-build blocks — split obeys the image law, density is enum-or-base", () => {
  it("a split block with an off-library image is dropped whole and named", () => {
    const { doc, dropped } = coerceSiteDoc(
      {
        home_blocks: [
          { type: "split", props: { url: "https://evil.example/x.jpg", heading: "Us", html: "<p>hi</p>" } },
          { type: "split", props: { url: PHOTO_A, heading: "Real", html: "<p>ok</p>", imageSide: "right" } },
        ],
      },
      base,
    );
    expect(doc.home_blocks).toEqual([
      { type: "split", props: { url: PHOTO_A, heading: "Real", html: "<p>ok</p>", imageSide: "right" } },
    ]);
    expect(dropped.some((d) => /image-and-text/.test(d))).toBe(true);
  });

  it("a text-only split (no image) is allowed", () => {
    const { doc } = coerceSiteDoc(
      { home_blocks: [{ type: "split", props: { url: "", heading: "Words", html: "<p>only</p>" } }] },
      base,
    );
    expect(doc.home_blocks.length).toBe(1);
  });

  it("hero_align/hero_style: enum-or-base, defaults render the original", () => {
    expect(extractSiteDoc({}).hero_align).toBe("left");
    expect(extractSiteDoc({}).hero_style).toBe("open");
    const banded = extractSiteDoc({ hero_align: "center", hero_style: "band" });
    expect(banded.hero_align).toBe("center");
    expect(banded.hero_style).toBe("band");
    expect(coerceSiteDoc({ hero_style: "floating" }, banded).doc.hero_style).toBe("band");
    expect(coerceSiteDoc({ hero_style: "spread" }, banded).doc.hero_style).toBe("spread");
    expect(coerceSiteDoc({ hero_align: "right", hero_style: "panel" }, banded).doc.hero_align).toBe("right");
    expect(coerceSiteDoc({}, banded).doc.hero_style).toBe("band");
  });

  it("hero_dx/dy/w — the move/resize levers — clamp and keep-base", () => {
    const moved = extractSiteDoc({ hero_dx: 12, hero_dy: -99, hero_w: 250 });
    expect(moved.hero_dx).toBe(12);
    expect(moved.hero_dy).toBe(-40); // clamped
    expect(moved.hero_w).toBe(100); // clamped
    expect(extractSiteDoc({}).hero_w).toBe(0); // 0 = the framing's default width
    expect(coerceSiteDoc({ hero_dx: "far left" }, moved).doc.hero_dx).toBe(12);
    expect(coerceSiteDoc({ hero_dx: -6 }, moved).doc.hero_dx).toBe(-6);
    expect(coerceSiteDoc({}, moved).doc.hero_dy).toBe(-40);
  });

  it("spread-piece levers clamp and keep-base like the hero box", () => {
    const d = extractSiteDoc({ spread_head_dx: -55, spread_tag_w: 61, spread_area_dy: 8 });
    expect(d.spread_head_dx).toBe(-40);
    expect(d.spread_tag_w).toBe(61);
    expect(d.spread_area_dy).toBe(8);
    expect(d.spread_head_w).toBe(0);
    expect(coerceSiteDoc({ spread_tag_w: 999 }, d).doc.spread_tag_w).toBe(100);
    expect(coerceSiteDoc({}, d).doc.spread_head_dx).toBe(-40);
  });

  it("text zoom clamps 50-200 with 0 = default", () => {
    const d = extractSiteDoc({ hero_scale: 340, spread_head_scale: 5, spread_tag_scale: 125 });
    expect(d.hero_scale).toBe(200);
    expect(d.spread_head_scale).toBe(50);
    expect(d.spread_tag_scale).toBe(125);
    expect(d.spread_area_scale).toBe(0);
    expect(coerceSiteDoc({ hero_scale: "huge" }, d).doc.hero_scale).toBe(200);
    expect(coerceSiteDoc({ hero_scale: 0 }, d).doc.hero_scale).toBe(0);
  });

  it("a headline is ONE LINE — newlines become commas (the v29 mangle)", () => {
    expect(extractSiteDoc({ splash_headline: "Custom Lighting \nTruckee" }).splash_headline).toBe("Custom Lighting, Truckee");
    const base2 = extractSiteDoc({});
    expect(coerceSiteDoc({ splash_headline: "A\nB" }, base2).doc.splash_headline).toBe("A, B");
  });

  it("site_density: enum lands, garbage keeps base, absent keeps", () => {
    const airy = extractSiteDoc({ site_density: "airy" });
    expect(airy.site_density).toBe("airy");
    expect(extractSiteDoc({ site_density: "cozy" }).site_density).toBe("default");
    expect(coerceSiteDoc({ site_density: "sparse" }, airy).doc.site_density).toBe("airy");
    expect(coerceSiteDoc({ site_density: "compact" }, airy).doc.site_density).toBe("compact");
    expect(coerceSiteDoc({}, airy).doc.site_density).toBe("airy");
  });

  it("the new section keys survive normalization inside a doc", () => {
    const { doc } = coerceSiteDoc(
      {
        home_blocks: [
          { type: "section", props: { key: "services" } },
          { type: "section", props: { key: "specialty" }, style: { pad: "l" } },
          { type: "section", props: { key: "bogus" } },
        ],
      },
      base,
    );
    expect(doc.home_blocks).toEqual([
      { type: "section", props: { key: "services" } },
      { type: "section", props: { key: "specialty" }, style: { pad: "l" } },
    ]);
  });
});

describe("site_accent — the mood lever, hex or nothing", () => {
  it("a valid hex lands lowercased; garbage keeps the base; '' clears; absent keeps", () => {
    const withAccent = extractSiteDoc({ site_accent: "#1B3A5C" });
    expect(withAccent.site_accent).toBe("#1b3a5c");
    expect(coerceSiteDoc({ site_accent: "#A2C3D4" }, base).doc.site_accent).toBe("#a2c3d4");
    expect(coerceSiteDoc({ site_accent: "midnight blue" }, withAccent).doc.site_accent).toBe("#1b3a5c");
    expect(coerceSiteDoc({ site_accent: "" }, withAccent).doc.site_accent).toBe("");
    expect(coerceSiteDoc({}, withAccent).doc.site_accent).toBe("#1b3a5c");
  });
});

describe("materialize + diff", () => {
  it("applySiteDoc touches only the doc's keys", () => {
    const raw = { public_handle: "et-electric", estimating_mode: "research", splash_headline: "Old" };
    const merged = applySiteDoc(raw, base);
    expect(merged.public_handle).toBe("et-electric");
    expect(merged.estimating_mode).toBe("research");
    expect(merged.splash_headline).toBe("Custom Lighting, Truckee");
  });

  it("diff names changes in human words", () => {
    const changed = { ...base, splash_headline: "New headline", site_theme: "bold" as const };
    expect(diffSiteDoc(base, changed).sort()).toEqual(["Headline", "Theme"]);
  });

  it("knownImageUrls collects every legitimate url across the doc — split blocks included", () => {
    expect([...knownImageUrls(base)].sort()).toEqual([PHOTO_A, PHOTO_B].sort());
    // Review HIGH: a split's image was invisible to the library, so the NEXT pass would drop the
    // whole block. Every block type that carries a url must appear here.
    const withSplit = extractSiteDoc({
      portfolio: [],
      home_blocks: [{ type: "split", props: { url: "https://x.supabase.co/storage/v1/object/public/branding/org/split-a.jpg", heading: "h", html: "" } }],
    });
    expect([...knownImageUrls(withSplit)]).toContain("https://x.supabase.co/storage/v1/object/public/branding/org/split-a.jpg");
  });

  it("a portfolio entry's extra keys (path — the storage delete key) survive extract AND a design pass", () => {
    const doc = extractSiteDoc({ portfolio: [{ url: PHOTO_A, path: "org/portfolio-a.jpg", src: "a.jpg" }] });
    expect(doc.portfolio[0].path).toBe("org/portfolio-a.jpg");
    // …and through coerceSiteDoc, which rebuilds entries from the base by url.
    const { doc: designed } = coerceSiteDoc({ portfolio: [{ url: PHOTO_A, caption: "New cap" }] }, doc);
    expect(designed.portfolio[0].path).toBe("org/portfolio-a.jpg");
    expect(designed.portfolio[0].caption).toBe("New cap");
  });
});

describe("the pre-publish checklist speaks plain words and never blocks", () => {
  it("flags a headline change against the published version", () => {
    const published = { ...base };
    const next = { ...base, splash_headline: "Totally different" };
    const checks = siteDocSeoChecks(next, published);
    expect(checks.some((c) => c.level === "warn" && /page title in Google/.test(c.msg))).toBe(true);
  });

  it("a clean publish says so", () => {
    expect(siteDocSeoChecks(base, base)).toEqual([{ level: "ok", msg: expect.stringContaining("Looks good") }]);
  });

  it("an empty site gets warned about everything that matters, not blocked", () => {
    const empty = extractSiteDoc({});
    const checks = siteDocSeoChecks(empty, null);
    expect(checks.every((c) => c.level === "warn")).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(4);
  });
});
