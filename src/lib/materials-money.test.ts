import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lineExtension, listMoney, listTotalCaveat, listTotalLine } from "./materials-money";

/**
 * A MATERIALS LIST'S MONEY, LINE BY LINE (item C4, from Erik's report on /materials/<id>).
 *
 * The footer summed `(est_cost ?? 0) × quantity`, so every line nobody had priced counted as zero and
 * nothing on the screen said so: a list of twenty lines where six had no price printed a total that
 * looked finished and was short by whatever those six cost.
 */
describe("one line's own money", () => {
  it("is the extension: how many × the price each", () => {
    expect(lineExtension({ quantity: 12, est_cost: 18.66 })).toBe(223.92);
  });

  it("is NOTHING, not zero, when nobody has priced it", () => {
    expect(lineExtension({ quantity: 12, est_cost: null })).toBeNull();
    expect(lineExtension({ quantity: 12 })).toBeNull();
  });

  it("an explicit zero is a real answer (a line thrown in free)", () => {
    expect(lineExtension({ quantity: 12, est_cost: 0 })).toBe(0);
  });

  it("rounds to the cent, so the footer and the lines add up to the same figure", () => {
    expect(lineExtension({ quantity: 3, est_cost: 0.335 })).toBe(1.01);
  });
});

describe("the whole list", () => {
  it("totals the priced lines and counts the ones it left out", () => {
    const money = listMoney([
      { quantity: 12, est_cost: 18.66 },
      { quantity: 2, est_cost: 10 },
      { quantity: 5, est_cost: null },
      { quantity: 1 },
    ]);
    expect(money).toEqual({ total: 243.92, priced: 2, unpriced: 2 });
  });

  it("an empty list is zero and says nothing", () => {
    expect(listMoney([])).toEqual({ total: 0, priced: 0, unpriced: 0 });
    expect(listTotalCaveat(listMoney([]))).toBeNull();
  });
});

describe("what the figure leaves out is SAID", () => {
  it("names how many lines are not in the total", () => {
    expect(listTotalCaveat({ total: 100, priced: 3, unpriced: 2 })).toBe(
      "2 lines have no price on them yet, so they are not in that total.",
    );
    expect(listTotalCaveat({ total: 100, priced: 3, unpriced: 1 })).toBe(
      "1 line has no price on it yet, so it is not in that total.",
    );
  });

  it("says there is nothing to total when NO line has a price", () => {
    expect(listTotalCaveat({ total: 0, priced: 0, unpriced: 6 })).toMatch(/nothing to total/);
    expect(listTotalCaveat({ total: 0, priced: 0, unpriced: 1 })).toBe("This line has no price on it yet, so there is nothing to total.");
  });

  it("says nothing when the total covers the whole list", () => {
    expect(listTotalCaveat({ total: 100, priced: 4, unpriced: 0 })).toBeNull();
  });
});

/**
 * ITEM C4-6: THERE IS NO FIGURE TO PRINT WHEN NOTHING IS PRICED.
 *
 * Both footers read `money.total` and printed it, so an ordinary unpriced order sheet — the usual case
 * for an estimate with no priced catalogue — read "List Total $0.00" with "there is nothing to total"
 * directly underneath. ONE-NUMBER ANSWERS means the figure is what gets read, and $0.00 reads as "this
 * list costs nothing": the exact distinction lineExtension protects line by line and the footer threw
 * away for the list.
 */
describe("the whole footer, decided in one place (item C4-6)", () => {
  it("withholds the figure when NO line is priced, and gives the sentence alone", () => {
    const line = listTotalLine({ total: 0, priced: 0, unpriced: 2 });
    expect(line.figure).toBeNull();
    expect(line.caveat).toBe("None of these 2 lines has a price on it yet, so there is nothing to total.");
  });

  it("gives the figure AND the sentence when the total covers part of the list", () => {
    expect(listTotalLine({ total: 100, priced: 3, unpriced: 2 })).toEqual({
      figure: 100,
      caveat: "2 lines have no price on them yet, so they are not in that total.",
    });
  });

  it("gives the figure alone when the total covers the whole list", () => {
    expect(listTotalLine({ total: 100, priced: 4, unpriced: 0 })).toEqual({ figure: 100, caveat: null });
  });

  it("a real $0.00 list — every line priced, priced at nothing — still prints its figure", () => {
    // "Nothing" and "free" are different answers and only one of them is a number: this one IS.
    expect(listTotalLine(listMoney([{ quantity: 2, est_cost: 0 }]))).toEqual({ figure: 0, caveat: null });
  });

  it("an empty list has no figure and nothing to say", () => {
    expect(listTotalLine(listMoney([]))).toEqual({ figure: null, caveat: null });
  });
});

/**
 * TEETH (item C4-6). This was ONE rule written at TWO footers: the editor's and the read-only
 * superseded view's. Each read `money.total` and decided for itself what to print, so when the caveat
 * arrived both shipped the same contradiction — "List Total $0.00" over "there is nothing to total".
 * A shared helper does not stop a third footer from reading `.total` and printing it; this is what
 * makes that fail loudly. A screen asks listTotalLine and prints what it gets back.
 */
describe("only lib/materials-money decides what a list footer prints (item C4-6)", () => {
  const SRC = join(process.cwd(), "src");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  };

  it("no screen reads the raw total, or the caveat, off a list's money for itself", () => {
    const offenders = walk(SRC)
      .filter((f) => f !== join(SRC, "lib", "materials-money.ts"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        // The sum and the sentence are only ever a pair, and listTotalLine is that pair.
        return /listTotalCaveat\s*\(/.test(src) || /\w*[Mm]oney\.total\b/.test(src) || /listMoney\([^)]*\)\.total/.test(src);
      })
      .map((f) => f.slice(SRC.length + 1).split("\\").join("/"))
      .sort();
    expect(
      offenders,
      "A footer is deciding for itself what a materials list totals. Ask lib/materials-money's " +
        "listTotalLine and print what it returns: with nothing priced there is no figure, only the sentence.",
    ).toEqual([]);
  });
});
