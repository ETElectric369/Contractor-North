import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ACCOUNTANT PAGE POINTS AT THE EXPORT DOOR (cn-v1138). The books are the accountant's file;
 * everything the company has is Download Everything on Settings › Getting Paid, and the page that
 * makes the books says so with one link, Title Case, under the file's card.
 */
const page = readFileSync(join(process.cwd(), "src/app/(app)/analytics/accountant/page.tsx"), "utf8");

describe("the accountant page's Download Everything link", () => {
  it("is one Link to /settings?tab=getpaid, Title Case, inside the download card", () => {
    const m = page.match(/<Link href="\/settings\?tab=getpaid"[^>]*>\s*Download Everything\s*<\/Link>/);
    expect(m).not.toBeNull();
    for (const w of "Download Everything".split(" ")) expect(w).toMatch(/^[A-Z]/);
    // Under the file's card, after the one-line "what is in the file" and its info icon.
    const card = page.slice(page.indexOf("<AccountantDownload"), page.indexOf("</AccountantPeriodScope>"));
    expect(card).toContain("<InfoPopup");
    expect(card.indexOf("<InfoPopup")).toBeLessThan(card.indexOf('href="/settings?tab=getpaid"'));
    expect(page.match(/Download Everything/g)?.length).toBe(1);
  });
});
