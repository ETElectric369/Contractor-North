import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * NORT OFF, AND THE DOORS THAT STAY (0352, rule k). Reading a receipt, a vendor list or a lesson
 * keeps working with Nort switched off; it just isn't called Nort. Neutral words when off, the same
 * words when on, so every mount below defaults to on and each page passes the company's switch.
 */
const src = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every line that shows the word Nort in a string must also be choosing on the switch. */
const unswitched = (p: string) =>
  src(p)
    .split("\n")
    .filter((l) => /["`'>][^"`'<]*\bNort\b/.test(l) && !/nortOn/.test(l) && !/function readWithNort|readWithNort\(\)/.test(l))
    .map((l) => l.trim());

describe("the paper readers say Nort only while Nort is on", () => {
  it("Add Cost / Snap The Bill", () => {
    expect(unswitched("src/components/quick-cost-button.tsx")).toEqual([]);
  });

  it("the vendor list import (Read The File, Look Up)", () => {
    expect(unswitched("src/app/(app)/price-list/vendor-import.tsx")).toEqual([]);
  });

  it("each mount passes the company's switch", () => {
    expect(src("src/app/(app)/planner/page.tsx")).toMatch(/<QuickCostButton[\s\S]{0,200}nortOn=\{featureOn\(features, "nort"\)\}/);
    expect(src("src/app/(app)/jobs/[id]/job-cost-capture.tsx")).toContain("nortOn={nortOn} />");
    expect(src("src/app/(app)/jobs/[id]/page.tsx")).toContain('<JobCostCapture orgId={j.org_id} jobId={j.id} billsTotal={billsCost} nortOn={on("nort")} />');
    expect(src("src/app/(app)/price-list/page.tsx")).toContain('featureOn(getOrgSettings((org as { settings?: unknown } | null)?.settings).features, "nort")');
    expect(src("src/app/(app)/price-list/page.tsx")).toMatch(/<VendorsManager[\s\S]{0,500}nortOn=\{nortOn\}/);
    expect(src("src/app/(app)/price-list/vendors-manager.tsx")).toContain("<VendorImport existing={existingVendors} nortOn={nortOn} />");
  });

  it("Snap The Bill and Receipts & Documents hand the switch to the receipt pipeline", () => {
    for (const f of ["src/app/(app)/jobs/[id]/job-cost-capture.tsx", "src/app/(app)/jobs/[id]/job-documents.tsx"]) {
      const s = src(f);
      expect(s, f).toMatch(/captureReceipt\(\{[^}]*nortOn \}\)/);
      expect(s, f).toMatch(/readReceiptDocument\([^;]*, nortOn\)/);
    }
    expect(unswitched("src/lib/receipt-capture.ts")).toEqual([]);
  });
});

describe("the setup questions (Start Here with Nort off) say nothing as Nort", () => {
  it("each Nort line has its neutral twin, and both mounts pass the switch", () => {
    const s = src("src/components/setup-interview.tsx");
    expect(s).toContain("nortOn={nortOn}");
    expect(s).toContain('{nortOn ? "Just tell Nort" : "Just Say It"}');
    expect(s).toContain("That usually means no trade is on file");
    expect(s).toContain('"Save The Drafts And Read Them Later"');
    // The Nort-voiced lines sit only inside a nortOn branch.
    for (const l of unswitched("src/components/setup-interview.tsx")) expect(l).toMatch(/label="Tell Nort about your business"|I never got your trade|tell me your trade/);
    const cap = src("src/components/setup-button.tsx");
    const mounts = cap.split("\n").filter((l) => l.includes("<SetupInterview "));
    expect(mounts).toHaveLength(2);
    for (const l of mounts) expect(l).toContain("nortOn={nortOn}");
    expect(cap).toContain('"A couple of things still missing"');
  });
});

describe("the Lessons run in neutral words while Nort is off", () => {
  it("the cap's menu and the Playbook strip pass the switch to the lesson", () => {
    const cap = src("src/components/setup-button.tsx");
    expect(cap).toContain("lessonBlurb(l, nortOn)");
    expect(cap).toMatch(/storageKey=\{`cn\.lesson\.\$\{lessonKey\}`\}[\s\S]{0,80}nortOn=\{nortOn\}/);
    const offer = src("src/components/tour/lesson-offer.tsx");
    expect(offer).toContain("lessonBlurb(lesson, nortOn)");
    expect(offer).toContain("nortOn={nortOn}");
    expect(src("src/app/(app)/settings/page.tsx")).toMatch(/<LessonOffer[\s\S]{0,300}nortOn=\{on\("nort"\)\}/);
  });

  it("the lesson card reads the neutral words and points at no missing Nort button", () => {
    const d = src("src/components/tour/tour-driver.tsx");
    expect(d).toContain("stepWords(step, nortOn)");
    expect(d).toContain("title={words.title}");
    expect(d).toContain('anchor={nortOn ? "nort" : undefined}');
    expect(unswitched("src/components/tour/tour-driver.tsx").filter((l) => !/I&rsquo;m Nort/.test(l))).toEqual([]);
  });
});
