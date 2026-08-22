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

  it("knownImageUrls collects every legitimate url across the doc", () => {
    expect([...knownImageUrls(base)].sort()).toEqual([PHOTO_A, PHOTO_B].sort());
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
