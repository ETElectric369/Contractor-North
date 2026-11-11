import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A 3D MODEL ON A JOB'S PAPERS SPINS IN THE APP (cn-v1160, the scout's F3). The copy a visit's 3D Scan
 * files on the job's Receipts & Papers opened with window.open, out of the app, while the visit's tile
 * and the customer's page open the same file in the in-app viewer. Every other paper opens as before.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/jobs/actions", () => ({ deleteDocument: vi.fn(), linkReceiptToBill: vi.fn(), updateDocument: vi.fn() }));
vi.mock("@/lib/receipt-capture", () => ({ prettyBytes: () => "1 KB", readReceiptDocument: vi.fn() }));

import { paperModelName, paperOpensIn } from "./job-documents";

const SIGNED = "https://files.example/sign/documents/org/jobs/j/";
const doc = (name: string, file: string | null, signed: string | null = file ? `${SIGNED}${file.split("/").pop()}?token=x` : null) => ({
  name,
  file_url: file,
  signedUrl: signed,
});

describe("where a paper opens", () => {
  it("a 3D Scan model opens in the viewer, by its file even when the paper was renamed", () => {
    expect(paperOpensIn(doc("scan-3d-1731300000000.usdz", "org/jobs/j/1-scan-3d-1731300000000.usdz"))).toBe("model");
    expect(paperOpensIn(doc("Larkspur kitchen scan", "org/jobs/j/1-scan-3d-1.usdz"))).toBe("model");
    expect(paperOpensIn(doc("Snowbell deck.glb", "org/jobs/j/2-snowbell-deck.glb"))).toBe("model");
  });

  it("a picture or a PDF opens in the lightbox, anything else in its own tab, a note opens nothing", () => {
    expect(paperOpensIn(doc("receipt.jpg", "org/jobs/j/3-receipt.jpg"))).toBe("lightbox");
    expect(paperOpensIn(doc("permit.pdf", "org/jobs/j/4-permit.pdf"))).toBe("lightbox");
    expect(paperOpensIn(doc("panel schedule.xlsx", "org/jobs/j/5-panel.xlsx"))).toBe("tab");
    expect(paperOpensIn(doc("A note", null, null))).toBeNull();
  });

  it("the viewer is handed a name with the model's extension (Open in AR stages the file under it)", () => {
    expect(paperModelName(doc("scan-3d-1.usdz", "org/jobs/j/1-scan-3d-1.usdz"))).toBe("scan-3d-1.usdz");
    expect(paperModelName(doc("Larkspur kitchen scan", "org/jobs/j/1-scan-3d-1.usdz"))).toBe("1-scan-3d-1.usdz");
  });

  it("the source opens a model in ModelViewer and window.open is left only for the other papers", () => {
    const src = readFileSync(join(__dirname, "job-documents.tsx"), "utf8");
    expect(src).toContain('import { ModelViewer, modelKind } from "@/components/model-viewer";');
    expect(src).toContain('if (where === "model") setViewing3d(d);');
    expect(src).toContain("<ModelViewer url={viewing3d.signedUrl} name={paperModelName(viewing3d)} onClose={() => setViewing3d(null)} />");
    expect(src.split("window.open(").length - 1).toBe(1);
    expect(src).toContain('else if (where === "tab" && d.signedUrl) window.open(d.signedUrl, "_blank");');
  });
});
