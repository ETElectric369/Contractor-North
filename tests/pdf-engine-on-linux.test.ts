import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchPdfBrowser } from "@/lib/pdf-browser";

/**
 * THE REAL BROWSER, STARTED FOR REAL. The Chromium the PDF engine runs in production is a Linux
 * x64 binary, so it cannot start on a developer's Mac: this file runs only where it can, which is
 * CI's Linux machine, and is skipped everywhere else. It goes through the engine's own start
 * (lib/pdf-browser) with nothing replaced: the binary is unpacked from the package, its shared
 * libraries with it, and a document is printed.
 *
 * It is not production: it does not prove the function bundle carries the binary, nor the
 * function's memory. It proves the pair of packages starts and prints on Linux with this Node.
 */
const onLinux = process.platform === "linux" && process.arch === "x64";

/** Pages in a PDF Chromium wrote: its page objects are plain dictionaries, one `/Type /Page` each. */
const pageCount = (pdf: Uint8Array) => (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;

// Thirty rows of half an inch: fifteen inches of content for eleven-inch paper.
const ROWS = Array.from({ length: 30 }, (_, i) => `<div class="row">Row ${i + 1}</div>`).join("");
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; }
  .row { height: 0.5in; break-inside: avoid; font: 12px sans-serif; background: #eef; }
</style></head><body>${ROWS}</body></html>`;

describe.runIf(onLinux)("the PDF engine's real browser, on the kind of machine production runs on", () => {
  it("starts, is the Chromium the driver was built for, and paginates by the @page margin", async () => {
    const browser = await launchPdfBrowser({ lambda: true });
    try {
      const built = /chrome: '(\d+)\.[\d.]+'/.exec(
        readFileSync(join(process.cwd(), "node_modules/puppeteer-core/lib/puppeteer/revisions.js"), "utf8"),
      );
      expect(built).not.toBeNull();
      expect(await browser.version()).toMatch(new RegExp(`/${built![1]}\\.`));

      // The engine's own sequence: load, inject the page margin as CSS (the pdf() margin option is
      // ignored once a stylesheet declares one), print Letter with backgrounds.
      const print = async (margin: string) => {
        const page = await browser.newPage();
        await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`, { waitUntil: "networkidle0", timeout: 25_000 });
        await page.addStyleTag({ content: `@page { margin: ${margin} !important; }` });
        const pdf = await page.pdf({ format: "letter", printBackground: true });
        await page.close();
        return pdf;
      };
      const narrow = await print("0.25in");
      const wide = await print("2in");
      expect(Buffer.from(narrow.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
      // 10.5 inches of paper hold 21 rows: 2 pages. 7 inches hold 14: 3 pages.
      expect(pageCount(narrow)).toBe(2);
      expect(pageCount(wide)).toBe(3);
    } finally {
      await browser.close();
    }
  }, 180_000);
});
