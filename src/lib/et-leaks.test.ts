import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sample from "@/app/(app)/doc-studio/sample-data";
import { COMPANY } from "@/lib/company";
import { companyFromOrg } from "@/components/doc-letterhead";

/**
 * NO COMPANY SEES ANOTHER'S NAME (Wave 0). ET Electric is the fixture, never the rule: its crew,
 * customer, supplier, town, tagline and license format were showing on every company's screens,
 * and its tagline printed under every company's name on every invoice and estimate.
 */
/** What a person could see: comments name the people who asked for things, and that's fine. */
const src = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const ET_WORDS = /Whitney|Arnoso|Truckee|Tahoe|\bErik\b|\bBrian\b|Consolidated|Integrity|TECL|1156091/;

describe("Document Studio's sample paper names nobody real", () => {
  it("has no real crew, customer, supplier or town", () => {
    expect(JSON.stringify(sample)).not.toMatch(ET_WORDS);
    expect(sample.SAMPLE_INVOICE_ITEMS.slice(0, 2).map((i) => i.description)).toEqual(["Labor — Lead", "Labor — Helper"]);
  });

  it("prints sample numbers and the sample title", () => {
    const s = src("src/app/(app)/doc-studio/studio.tsx");
    expect(s).not.toContain("INV-061");
    expect(s).not.toContain("E-030");
    expect(s).not.toMatch(ET_WORDS);
  });
});

describe("a company's paper says only what the company said", () => {
  it("prints no default tagline", () => {
    expect(COMPANY.tagline).toBe("");
    expect(companyFromOrg({ name: "Main Street Builders" } as never).tagline).toBe("");
  });
});

describe("sign-up, sign-in and Settings carry North's mark and plain labels", () => {
  it("onboarding: the dome asset, no trade icon, no tagline, a made-up example company", () => {
    const s = src("src/app/onboarding/page.tsx");
    expect(s).not.toContain("Zap");
    expect(s).toContain('src="/icon-192.png"');
    expect(s).not.toMatch(ET_WORDS);
  });

  it("login and the landing page: no ET tagline or trade icon", () => {
    expect(src("src/app/login/page.tsx")).not.toContain("Integrity");
    const landing = src("src/app/page.tsx");
    expect(landing).not.toContain("Integrity");
    expect(landing).not.toContain("Zap");
  });

  it("Settings says License #, and no placeholder is a real license", () => {
    expect(src("src/app/(app)/settings/org-settings-form.tsx")).not.toContain("TECL");
    expect(src("src/app/(app)/settings/splash-settings.tsx")).not.toMatch(ET_WORDS);
  });
});
