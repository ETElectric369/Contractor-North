import { describe, it, expect } from "vitest";
import { cleanPaperTitle } from "./doc-kinds";

/**
 * The title a new plan starts with on the Show On Portal sheet: its file name cleaned, or the
 * fallback when the name is camera noise. A suggestion a person reads before anything shows.
 */
const FB = "Plan, Sep 25, 2026";

describe("cleanPaperTitle", () => {
  it.each([
    "IMG_1234.JPG",
    "IMG_E1234 2.heic",
    "DSC00012.jpg",
    "PXL_20260925_101530123.jpg",
    "photo-1727312345678.jpg",
    "image.jpg",
    "Screenshot 2026-09-25 at 10.15.30 AM.png",
    "Scan 3.pdf",
    "20260925_101530.jpg",
    "3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f.pdf",
    "",
    null,
  ])("camera noise %j falls back", (name) => {
    expect(cleanPaperTitle(name, FB)).toBe(FB);
  });

  it.each([
    ["123_Main_St_Panel_Schedule_v2.pdf", "123 Main St Panel Schedule v2"],
    ["circuit-map-rev-b.pdf", "circuit map rev b"],
    ["Panel plan 2026-09-25.pdf", "Panel plan 2026-09-25"],
    ["E1.pdf", "E1"],
    ["A101 Floor Plan.pdf", "A101 Floor Plan"],
    ["E-2.pdf", "E 2"],
    ["Photo of the panel.jpg", "Photo of the panel"],
  ])("%j reads as %j", (name, want) => {
    expect(cleanPaperTitle(name, FB)).toBe(want);
  });

  it("keeps to the 120 the portal allows", () => {
    expect(cleanPaperTitle(`${"Kitchen ".repeat(30)}.pdf`, FB).length).toBeLessThanOrEqual(120);
  });
});
