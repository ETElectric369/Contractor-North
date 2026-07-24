import { describe, expect, it } from "vitest";
import { imageSrcSet, optimizeBodyImages, sizedImage, socialImage } from "./site-image";

const SB = "https://rbpokaozcxqownollqlx.supabase.co/storage/v1/object/public/site/photo.jpg";
const SB_RENDER = "https://rbpokaozcxqownollqlx.supabase.co/storage/v1/render/image/public/site/photo.jpg";

describe("sizedImage", () => {
  it("rewrites a Supabase public object URL onto the render endpoint", () => {
    expect(sizedImage(SB, 640)).toBe(`${SB_RENDER}?width=640&quality=75`);
  });
  it("appends with & when the URL already has a query", () => {
    expect(sizedImage(`${SB}?v=2`, 640)).toBe(`${SB_RENDER}?v=2&width=640&quality=75`);
  });
  it("passes external / relative / svg / empty URLs through untouched", () => {
    expect(sizedImage("https://cdn.example.com/a.jpg", 640)).toBe("https://cdn.example.com/a.jpg");
    expect(sizedImage("/local/pic.png", 640)).toBe("/local/pic.png");
    const svg = SB.replace("photo.jpg", "logo.svg");
    expect(sizedImage(svg, 640)).toBe(svg);
    expect(sizedImage(null, 640)).toBe("");
  });
});

describe("imageSrcSet", () => {
  it("builds width descriptors for transformable URLs, undefined otherwise", () => {
    expect(imageSrcSet(SB, [320, 640])).toBe(
      `${SB_RENDER}?width=320&quality=75 320w, ${SB_RENDER}?width=640&quality=75 640w`,
    );
    expect(imageSrcSet("https://cdn.example.com/a.jpg", [320])).toBeUndefined();
  });
});

describe("socialImage", () => {
  it("caps at 1200 and returns null for empty", () => {
    expect(socialImage(SB)).toBe(`${SB_RENDER}?width=1200&quality=75`);
    expect(socialImage(null)).toBeNull();
    expect(socialImage("")).toBeNull();
  });
});

describe("optimizeBodyImages", () => {
  it("rewrites inline Supabase imgs and adds lazy/async", () => {
    const out = optimizeBodyImages(`<p>hi</p><img src="${SB}" alt="deck">`);
    expect(out).toContain(`src="${SB_RENDER}?width=1280&quality=75"`);
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
  });
  it("leaves external srcs alone but still adds loading hints", () => {
    const out = optimizeBodyImages('<img src="https://cdn.example.com/a.jpg">');
    expect(out).toContain('src="https://cdn.example.com/a.jpg"');
    expect(out).toContain('loading="lazy"');
  });
  it("respects an existing loading attribute", () => {
    const out = optimizeBodyImages(`<img loading="eager" src="${SB}">`);
    expect(out.match(/loading=/g)).toHaveLength(1);
    expect(out).toContain('loading="eager"');
  });
});
