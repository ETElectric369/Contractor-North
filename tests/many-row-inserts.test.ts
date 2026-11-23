import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * EVERY ROW OF ONE INSERT NAMES THE SAME COLUMNS (cn-v1182).
 *
 * WHAT HAPPENED, on production the evening cn-v1181 shipped. The door that writes a bill's lines
 * gave `pen_mark` and `returned` only to the lines that carried a pen mark. The data API builds a
 * many-row insert from every key ANY row names, and a row that leaves a key out is sent NULL for
 * it, never the column's default. `returned` is NOT NULL, so on any paper with one marked line and
 * one ordinary line the database refused the whole insert: the bill was written at its printed
 * total with no lines at all, and the person was told it had been read. Four of his bills were
 * emptied that way before the error sink was read.
 *
 * NOTHING COULD SEE IT: the unit stand-ins record what a door hands them and do not fill a missing
 * key the way the data API does, and the database suites write through SQL, where a missing column
 * takes its default. The test of that very door PINNED the faulty shape and called it a virtue.
 *
 * So the shape is held here, by reading the source: a `.insert(` or `.upsert(` that is handed a
 * `.map(` of rows may not build a row with a CONDITIONAL spread (`...(x ? {…} : {})`), which is how
 * a row comes to lack a column its neighbour names. The one door that needs a column only on some
 * bills decides it PER INSERT, never per row, and is named below with the test that pins it.
 */
const SRC = join(process.cwd(), "src");

/** Decided per insert, pinned by its own table test (every mix of lines goes in as one shape). */
const PER_INSERT: Record<string, string> = {
  "src/app/(app)/organize/paperwork-core.ts": "src/app/(app)/organize/pen-marks-filing.test.ts",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|test-util|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The text handed to each `.insert(` / `.upsert(`, by balanced parentheses. */
function insertArguments(text: string): { at: number; arg: string }[] {
  const found: { at: number; arg: string }[] = [];
  for (const m of text.matchAll(/\.(insert|upsert)\(/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    found.push({ at: m.index!, arg: text.slice(start, i - 1) });
  }
  return found;
}

const rowsAreMapped = (arg: string) => /\.(map|flatMap)\(/.test(arg);
const conditionalSpread = (arg: string) => /\.\.\.\(\s*[^()]*(\?|&&)/.test(arg);

describe("a many-row insert names the same columns on every row", () => {
  const offenders: string[] = [];
  const perInsertSeen = new Set<string>();
  for (const file of sources(SRC)) {
    const rel = relative(process.cwd(), file);
    const text = readFileSync(file, "utf8");
    for (const { at, arg } of insertArguments(text)) {
      if (!rowsAreMapped(arg) || !conditionalSpread(arg)) continue;
      if (PER_INSERT[rel]) {
        perInsertSeen.add(rel);
        continue;
      }
      offenders.push(`${rel}:${text.slice(0, at).split("\n").length}`);
    }
  }

  it("no door builds a row of a many-row insert with a conditional spread", () => {
    expect(offenders).toEqual([]);
  });

  it("the one door that decides a column per insert still does, and its table test is there", () => {
    for (const [file, test] of Object.entries(PER_INSERT)) {
      expect(perInsertSeen.has(file), `${file} no longer needs its place on this list: take it off`).toBe(true);
      const src = readFileSync(join(process.cwd(), file), "utf8");
      // Per insert: the switch is asked of ALL the lines, then every row answers it.
      expect(src).toContain("const anyMarked = lines.some(isMarked);");
      expect(src).toContain("...(anyMarked ? { pen_mark: marked ? pen.pen_mark : null, returned: marked ? pen.returned : false } : {}),");
      expect(src).toContain("...(anyPartUsed ? { billed_amount: partUsed(l, pen) } : {}),");
      expect(readFileSync(join(process.cwd(), test), "utf8")).toContain("every mix of marked and ordinary lines goes in as ONE shape");
    }
  });

  it("the scan sees the shape it is for", () => {
    const bad = `await db.from("t").insert(rows.map((r) => ({ a: r.a, ...(r.b ? { b: r.b } : {}) })))`;
    const also = `await db.from("t").upsert(rows.map((r) => ({ a: r.a, ...(r.b && { b: r.b }) })))`;
    const fine = `await db.from("t").insert(rows.map((r) => ({ a: r.a, b: r.b ?? null })))`;
    const one = `await db.from("t").insert({ a: 1, ...(b ? { b } : {}) })`;
    const hit = (s: string) => insertArguments(s).some(({ arg }) => rowsAreMapped(arg) && conditionalSpread(arg));
    expect(hit(bad)).toBe(true);
    expect(hit(also)).toBe(true);
    expect(hit(fine)).toBe(false);
    // One row is one shape: a conditional key on a single-row insert takes the column's default.
    expect(hit(one)).toBe(false);
  });
});
