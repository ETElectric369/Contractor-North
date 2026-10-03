import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE THREE SUPERSEDED PERMIT COLUMNS STAY UNREAD (0378).
 *
 * public.permits carried ONE inspection inline — inspection_date, inspector, inspection_result — and a
 * permit needs SEVERAL, from different authorities, in order: "we have to get it inspected by both the
 * Town of Truckee and Liberty Utilities before Liberty will put the meter back on". 0378 moved them to
 * public.permit_inspections, left the three columns in place as the backup of the first row (dropping a
 * column in the same breath as creating its replacement leaves no way back), and commented each one
 * SUPERSEDED — do not read it.
 *
 * A COMMENT IS NOT A BOUNDARY. The columns are still there, still selectable, and still in anybody's
 * autocomplete, so the next reader of them would be a second source of truth for who inspected what —
 * silently one inspection deep, on a permit that needs two. This is the gate that keeps them unread
 * until a later migration drops them.
 *
 * WHAT IT ALLOWS: the WORDS, in a comment or a test like this one, so the history can still be
 * explained. What it forbids is a column NAME in code — a select list, an object key, a property read.
 *
 * `inspector` IS NOT BANNED OUTRIGHT: permit_inspections has its own `inspector` (who came), and the
 * app is full of the word (the site-visit Inspector is a whole screen). It is banned where it would be
 * a PERMITS column: in the permit files, and in any select list that names permits' own columns.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WALKED = ["src", "tests", "scripts"];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (/\.(ts|tsx|js|jsx|sql)$/.test(name) && !full.endsWith("no-superseded-permit-columns.test.ts")) yield full;
  }
}

/** A line is CODE unless it is only a comment. The ban is on code; the history may still be told. */
function codeLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let s = raw;
    if (inBlock) {
      const end = s.indexOf("*/");
      if (end < 0) return;
      s = s.slice(end + 2);
      inBlock = false;
    }
    // Strip every complete /* … */ on the line, then an opening one that runs on.
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");
    const open = s.indexOf("/*");
    if (open >= 0) {
      inBlock = true;
      s = s.slice(0, open);
    }
    s = s.replace(/\/\/.*$/, "").replace(/--.*$/, ""); // // for TS, -- for SQL
    if (s.trim()) out.push({ line: i + 1, text: s });
  });
  return out;
}

const all = WALKED.flatMap((d) => [...files(path.join(ROOT, d))]);

describe("0378: nothing reads permits.inspection_date / .inspector / .inspection_result again", () => {
  it("the walk found the repo (so a passing run means something)", () => {
    expect(all.length).toBeGreaterThan(400);
    expect(all.some((f) => f.includes(path.join("permits", "actions.ts")))).toBe(true);
  });

  it("inspection_date and inspection_result appear in no code, anywhere", () => {
    const hits: string[] = [];
    for (const f of all) {
      // The migration that superseded them is where they are allowed to be named in SQL.
      if (f.includes("0378_")) continue;
      for (const { line, text } of codeLines(readFileSync(f, "utf8"))) {
        if (/\binspection_date\b|\binspection_result\b/.test(text)) {
          hits.push(`${path.relative(ROOT, f)}:${line} reads a superseded permits column`);
        }
      }
    }
    expect(
      hits,
      `${hits.length} reader(s) of a superseded permits column are back:\n${hits.join("\n")}\n\nA permit's inspections are rows in permit_inspections (0378): read them through lib/permit-inspections, and book or record one through permits/inspection-actions.`,
    ).toEqual([]);
  });

  it("PERMIT_INSPECTION_RESULTS is gone from the permit option spine with them", () => {
    const spine = readFileSync(path.join(ROOT, "src/lib/permit-options.ts"), "utf8");
    expect(spine).not.toContain("PERMIT_INSPECTION_RESULTS");
    expect(spine).not.toContain("permitResultTone");
  });

  it("the permit files never name `inspector` as a permits column", () => {
    const hits: string[] = [];
    const permitFiles = all.filter(
      (f) =>
        f.includes(`${path.sep}permits${path.sep}`) ||
        f.endsWith(`${path.sep}job-permits.tsx`) ||
        f.endsWith(`${path.sep}permit.ts`) ||
        f.endsWith(`${path.sep}permit-options.ts`),
    );
    expect(permitFiles.length).toBeGreaterThan(3);
    for (const f of permitFiles) {
      // permits/inspection-actions and the card write permit_inspections.inspector, which is the NEW
      // column and the point of the lane: they are named here because they are allowed to.
      if (/inspection-actions|permit-inspections/.test(path.basename(f))) continue;
      for (const { line, text } of codeLines(readFileSync(f, "utf8"))) {
        if (/\binspector\b/.test(text)) hits.push(`${path.relative(ROOT, f)}:${line} names permits.inspector`);
      }
    }
    expect(
      hits,
      `${hits.length} place(s) still treat \`inspector\` as a column on permits:\n${hits.join("\n")}\n\nWho came is permit_inspections.inspector, one per visit (0378).`,
    ).toEqual([]);
  });

  it("every select list that names permits' columns leaves all three out", () => {
    const hits: string[] = [];
    for (const f of all) {
      if (f.includes("0378_")) continue;
      const text = readFileSync(f, "utf8");
      // A select list naming permit_number is a permits read, wherever it lives. One line only: a
      // run of text between two unrelated quotes on different lines is not a string.
      for (const m of text.matchAll(/"([^"\n]*\bpermit_number\b[^"\n]*)"/g)) {
        const list = m[1];
        for (const col of ["inspection_date", "inspection_result", "inspector"]) {
          if (new RegExp(`(^|[\\s,(])${col}($|[\\s,)])`).test(list)) {
            hits.push(`${path.relative(ROOT, f)} selects permits.${col}`);
          }
        }
      }
    }
    expect(hits, `A permits read is back on a superseded column:\n${hits.join("\n")}`).toEqual([]);
  });
});
