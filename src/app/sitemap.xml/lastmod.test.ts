import { describe, it, expect } from "vitest";
import { lastmodDate, newestLastmod, urlEntry } from "./lastmod";

describe("lastmodDate", () => {
  it("renders a timestamptz as a W3C date (UTC day)", () => {
    expect(lastmodDate("2026-07-08T20:30:00.000Z")).toBe("2026-07-08");
    // Late-Pacific evening is already the next UTC day — lastmod follows UTC, matching toISOString.
    expect(lastmodDate("2026-07-08T23:30:00-08:00")).toBe("2026-07-09");
  });

  it("returns null for missing or garbage input (entry omits <lastmod>)", () => {
    expect(lastmodDate(null)).toBeNull();
    expect(lastmodDate(undefined)).toBeNull();
    expect(lastmodDate("")).toBeNull();
    expect(lastmodDate("not-a-date")).toBeNull();
  });
});

describe("newestLastmod", () => {
  it("picks the newest of the set, skipping nulls and garbage", () => {
    expect(
      newestLastmod(["2026-07-01T00:00:00Z", null, "2026-07-10T12:00:00Z", "junk", "2026-06-30T00:00:00Z"]),
    ).toBe("2026-07-10");
  });

  it("returns null when nothing usable exists", () => {
    expect(newestLastmod([])).toBeNull();
    expect(newestLastmod([null, undefined, "junk"])).toBeNull();
  });
});

describe("urlEntry", () => {
  it("includes <lastmod> only when known", () => {
    expect(urlEntry("https://x.com/", "2026-07-10")).toBe(
      "  <url><loc>https://x.com/</loc><lastmod>2026-07-10</lastmod></url>",
    );
    expect(urlEntry("https://x.com/")).toBe("  <url><loc>https://x.com/</loc></url>");
    expect(urlEntry("https://x.com/", null)).toBe("  <url><loc>https://x.com/</loc></url>");
  });
});
