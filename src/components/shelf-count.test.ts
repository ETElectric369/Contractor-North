import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE STOCK LIST IS READ EACH TIME THE SHEET OPENS. /bills' Add By Hand stays on the page between
 * openings (it sits in the header; closing the sheet only hides it, and router.refresh() keeps it).
 * When the list was read once for good, an item just made with New Item was missing from What Is
 * It? the next time, so the person typed it again and a spelling off by a dash made a second item
 * with the count split across two. Now the list is forgotten when the sheet closes and read again
 * when it opens.
 */
vi.mock("@/app/(app)/inventory/actions", () => ({ shelfPickerItems: vi.fn() }));

const { shelfItemsStep } = await import("./shelf-count");

/** The hook's effect, run the way React runs it: after each change of `open` or `loaded`, until it
 *  settles. A read finishes at once (loaded = true). Returns how many reads were made. */
function run(openings: boolean[]): number {
  let loaded = false;
  let reads = 0;
  for (const open of openings) {
    for (let guard = 0; guard < 5; guard++) {
      const step = shelfItemsStep(open, loaded);
      if (step === "keep") break;
      if (step === "forget") loaded = false;
      else {
        reads++;
        loaded = true;
      }
    }
  }
  return reads;
}

describe("the stock list is read each time the sheet opens", () => {
  it("reads when open and not read yet, forgets when closed, and otherwise keeps what it has", () => {
    expect(shelfItemsStep(true, false)).toBe("read");
    expect(shelfItemsStep(false, true)).toBe("forget");
    expect(shelfItemsStep(true, true)).toBe("keep");
    expect(shelfItemsStep(false, false)).toBe("keep");
  });

  it("open, save, open again: the second opening reads the list again (the new item is on it)", () => {
    expect(run([true, false, true])).toBe(2);
    expect(run([true, false, true, false, true])).toBe(3);
  });

  it("a sheet that stays open reads once, and one never opened never reads", () => {
    expect(run([true, true, true])).toBe(1);
    expect(run([false, false])).toBe(0);
  });

  it("the hook forgets on close, keeps the last list while reading, and clears an old error on a good read", () => {
    const src = readFileSync(join(process.cwd(), "src/components/shelf-count.tsx"), "utf8");
    const hook = src.slice(src.indexOf("export function useShelfItems("), src.indexOf("THE ROW."));
    expect(hook).toContain("shelfItemsStep(open, loaded)");
    expect(hook).toMatch(/step === "forget"\) \{\s*setLoaded\(false\);/);
    // Forgetting never empties the list: an item already picked stays found while the new list reads.
    expect(hook).not.toMatch(/setItems\(\[\]\)/);
    expect(hook).toMatch(/setItems\(r\.items\);\s*setError\(null\);/);
  });

  it("Type It In asks for the list only while its sheet is open on Shop Stock", () => {
    const src = readFileSync(join(process.cwd(), "src/components/quick-cost-button.tsx"), "utf8");
    expect(src).toContain("useShelfItems(open && target === STOCK)");
  });
});
