import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE JOB OWNS THIS PHOTO — a tripwire for the fourth door (item C3). A DELIBERATE BYPASS CHECK: the
 * behaviour itself is pinned in jobs/cost-scope-and-returns.test.ts.
 *
 * A link row in `organized_items` that points at a document the JOB already had must say so
 * (source: "job"), because Undo and Delete read that word to decide whether the filing owns the file
 * (filingDocument in organize/paperwork-core). Two of the three doors said it; Add Cost's did not, and
 * the photo was spared only because the upload happened to land before the link row. The day a door
 * writes the row first, or the two land in the same instant, the receipt goes down with the bill.
 *
 * So: every organized_items insert that carries a document_id names its source. A fourth door that
 * forgets fails here.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("a link row that points at a job's own upload says so (item C3)", () => {
  it("every organized_items insert carrying a document_id names its source", () => {
    const forgot: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const at = line.indexOf('from("organized_items")');
        if (at < 0) return;
        // Read forward over the chained call, stopping at the next table so a neighbouring insert
        // can't be mistaken for this one.
        const after = [line.slice(at + 'from("organized_items")'.length), ...lines.slice(i + 1, i + 45)].join("\n");
        const nextTable = after.indexOf('from("');
        const chain = nextTable >= 0 ? after.slice(0, nextTable) : after;
        if (!chain.includes(".insert(")) return;
        if (!/\bdocument_id\b/.test(chain)) return; // no file to own
        if (/\bsource:/.test(chain)) return;
        forgot.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    expect(
      forgot.sort(),
      'This row points at a document somebody else uploaded, so it must say source: "job" — otherwise ' +
        "Undo or Delete can take the photo off the job along with the bill (organize/paperwork-core filingDocument).",
    ).toEqual([]);
  });
});
