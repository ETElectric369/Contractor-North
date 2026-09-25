import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/app/report-client-error", () => ({ reportClientError: vi.fn() }));

import { withExtension } from "./media-lightbox";

describe("withExtension — Save to Files gets a file it can open (audit v994 NF2)", () => {
  it("a receipt's dollar amount is not an extension", () => {
    expect(withExtension("Home Depot — $47.44", "image/jpeg")).toBe("Home Depot — $47.44.jpg");
    expect(withExtension("Consolidated Electrical Dist. — $477.40", "application/pdf")).toBe(
      "Consolidated Electrical Dist. — $477.40.pdf",
    );
  });

  it("a revision number is not an extension", () => {
    expect(withExtension("Permit rev.12", "application/pdf")).toBe("Permit rev.12.pdf");
  });

  it("a name already ending in its type's extension is left alone, in any case, .jpeg included", () => {
    expect(withExtension("plans.PDF", "application/pdf")).toBe("plans.PDF");
    expect(withExtension("IMG_0042.jpeg", "image/jpeg")).toBe("IMG_0042.jpeg");
    expect(withExtension("IMG_0042.JPG", "image/jpeg")).toBe("IMG_0042.JPG");
    expect(withExtension("IMG_0042.HEIC", "image/heic")).toBe("IMG_0042.HEIC");
  });

  it("an unknown type adds nothing, and a blank name still gets a name", () => {
    expect(withExtension("export.csv", "application/octet-stream")).toBe("export.csv");
    expect(withExtension("", "image/png")).toBe("file.png");
    expect(withExtension("Kitchen panel", "application/pdf; charset=binary")).toBe("Kitchen panel.pdf");
  });
});

describe("one fetch per file in the shell (audit v994 NF1)", () => {
  it("the download effect keys on whether to start, not on the frame's own load", () => {
    const src = readFileSync(join(__dirname, "media-lightbox.tsx"), "utf8");
    expect(src).toContain("const start = inShell && (isPdf || shown);");
    expect(src).toContain("}, [start, url, name, isPdf]);");
    expect(src).not.toContain("[inShell, shown, url, name, isPdf]");
  });
});
