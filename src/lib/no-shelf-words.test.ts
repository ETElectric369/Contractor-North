import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * STOCK SAYS STOCK (Erik, 2026-09-27: "we need to uniform our inventory talk to stock and inventory
 * instead of shelf"). Buttons say Put The Rest In Stock, Take It Out Of Stock and Record To Stock;
 * labels say In Stock; sentences, toasts, empty states, the accountant's notes and Nort's prompt and
 * tool descriptions say stock. The feature's name is Shop Stock.
 *
 * WHAT COUNTS: every word a person could read or Nort could say, which is every string literal,
 * template chunk and JSX text in src (the pages, the components, the server actions, the lib that
 * writes their sentences, Nort's prompt, product map and tools). WHAT DOESN'T: comments, identifiers
 * and table/column/function names (on_shelf, shelf_for_crew, unshelved_at, list_shelf, isShelfTicket),
 * which stay as they are. The compiler reads the file, so a comment or a name never trips it.
 *
 * TWO KINDS OF LITERAL ARE CODE, NOT WORDS: a key (one lowercase word, "shelf" or "unshelve", or a
 * dotted/colon key with no space, the busy key "shelf:" or the error-report key
 * "panel.loadPanelBreakers.shelf"), and a literal that tells Nort how a PERSON may say it ("off the
 * shelf (their words; you always say stock)"), so a tech who says "grabbed wire nuts off the shelf"
 * is still understood. A lone capitalised "Shelf" is a label, so it still counts.
 */
const ROOT = process.cwd();
const WORD = /(?<![A-Za-z0-9_])(?:un)?shel(?:f|ves|ved|ving|ve)(?![A-Za-z0-9_-])/i;
const JUST_A_KEY = /^(?:[a-z_]+:?|[A-Za-z0-9_]+(?:[.:][A-Za-z0-9_]+)+:?)$/;
const THEIR_WORDS = "(their words; you always say stock)";

/** True when a literal's text says shelf to a person. */
function saysShelf(text: string): boolean {
  if (JUST_A_KEY.test(text.trim())) return false;
  if (text.includes(THEIR_WORDS)) return false;
  return WORD.test(text);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(p) && !/\.(test|db-suite|db-fixture)\.tsx?$/.test(p) && !/\.d\.ts$/.test(p) ? [p] : [];
  });
}

/** Every literal a person could read, with its line, by the compiler's own reading of the file. */
function wordsIn(file: string): { line: number; text: string }[] {
  const src = readFileSync(join(ROOT, file), "utf8");
  if (!/shel/i.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const add = (n: ts.Node, text: string) => out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
  const walk = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n, n.text);
    else if (ts.isTemplateExpression(n)) {
      add(n.head, n.head.text);
      for (const s of n.templateSpans) add(s.literal, s.literal.text);
    } else if (ts.isJsxText(n)) add(n, n.getText(sf));
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

describe("no screen, toast or Nort line says shelf", () => {
  const files = sourceFiles(join(ROOT, "src")).map((f) => relative(ROOT, f));

  it("scans the whole app, Nort included", () => {
    expect(files.length).toBeGreaterThan(500);
    for (const f of ["src/app/api/chat/route.ts", "src/lib/assistant-tools.ts", "src/lib/actions/entities/inventory.ts", "src/lib/nort-product-map.ts"]) {
      expect(files).toContain(f);
    }
  });

  it("the rule catches the old words and lets code and a person's own words through", () => {
    for (const s of ["Put The Rest On The Shelf", "Take It Off The Shelf", "Record To Shelf", "On The Shelf", "Nothing on the shelf yet", "the shelf's record", "Shelf ticket", "a shelved roll", "Shelf"]) {
      expect(saysShelf(s), s).toBe(true);
    }
    for (const s of ["shelf", "unshelve", "shelf:", "panel.loadPanelBreakers.shelf", "on_shelf", "shelf_for_crew", "list_shelf", "isShelfTicket", "Put The Rest In Stock", `off the shelf ${THEIR_WORDS}`]) {
      expect(saysShelf(s), s).toBe(false);
    }
  });

  it("finds none", () => {
    const hits = files.flatMap((f) => wordsIn(f).filter((w) => saysShelf(w.text)).map((w) => `${f}:${w.line}: ${w.text.replace(/\s+/g, " ").trim().slice(0, 140)}`));
    expect(hits).toEqual([]);
  }, 60_000);

  it("the Money by Month chart has no stock-bought bar, and the Owner's Draw card no line of its own for it", () => {
    const chart = readFileSync(join(ROOT, "src/lib/analytics/money-chart.ts"), "utf8");
    expect(chart).not.toMatch(/Put On The Shelf/);
    expect(chart).toContain('case "materials":\n        return materialsWithStock(m);');
    const card = readFileSync(join(ROOT, "src/app/(app)/analytics/left-for-card.tsx"), "utf8");
    expect(card).toContain('row("Materials & Bills", cost(materialsWithStock(t)))');
    expect(card).not.toMatch(/row\("[^"]*Shelf/);
  });
});
