import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * NO SUPPLIER'S NAME IN THE APP'S WORDS (Wave 0). "Choose CED PDFs", "Add To CED Documents",
 * "Return To CED", a PO that defaulted to CED: every company saw one electrical distributor named
 * on its screens. A paper says the company's own supplier account's name (shortSupplierName) or
 * "Supplier". Comments may name who asked for what; the code a person reads may not.
 */
const ROOT = process.cwd();
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(p) && !/\.(test|db-suite|db-fixture|prod-replay)\.tsx?$|\.prod-replay\.test\.ts$/.test(p) ? [p] : [];
  });
}
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

describe("the app names no supplier in its own words", () => {
  it("no code outside a comment says CED (a regex that still reads old stored sentences excepted)", () => {
    const hits = files(join(ROOT, "src"))
      .flatMap((f) =>
        code(readFileSync(f, "utf8"))
          .split("\n")
          .filter((l) => /\bCED\b/.test(l) && !/CED documents list\|supplier documents list/.test(l))
          .map((l) => `${relative(ROOT, f)}: ${l.trim().slice(0, 120)}`),
      );
    expect(hits).toEqual([]);
  });
});
