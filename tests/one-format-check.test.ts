import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { DEFAULT_DOC_STYLE, ESTIMATE_FORMATS, isEstimateFormat } from "@/lib/doc-style";

/**
 * ONE FORMAT CHECK (cn-v1158). How a task line prints is one of a short list of words — "tasks",
 * "detailed" and, since 0408, "grouped" (One Materials Line) — and that list is written down in
 * exactly one place: src/lib/doc-style.ts (ESTIMATE_FORMATS, asked through isEstimateFormat).
 *
 * WHY THIS IS A TEST AND NOT A HABIT. The day before the third word (cn-v1157) the app held the list
 * in seven places. Four stood outside the home file, each an inline
 * `x === "tasks" || x === "detailed" ? x : null`: the pill's write, the save (first and later),
 * Revise / Duplicate, and the editor's seed. Three more stood inside it. Each one KEPT a value it
 * recognised and turned anything else into "the company's default" — silently. So the day "grouped"
 * was added, any copy that was missed would have taken a grouped estimate and, without an error and
 * without a word, saved it, reopened it or revised it as the company's default: the customer's paper
 * changes and nobody is told. A list in one file cannot go stale against itself. (This file, run
 * unchanged over the cn-v1157 tree, fails and names those four lines.)
 *
 * WHAT IT READS, with the compiler (a regex cannot tell a test from a comment), in every .ts and
 * .tsx file under src/ except the one home of the list and the test files (a test may quote an old
 * migration or walk the words; it decides nothing in the app):
 *
 *   A LIST OF THE WORDS, wherever it stands:
 *     · an array holding two or more of them — ["tasks", "detailed"].includes(v), new Set([…]),
 *       .in("estimate_format", […]), a second `as const` copy;
 *     · a string or a regex that lists them — "estimate_format in ('tasks','detailed')",
 *       "in.(tasks,detailed)", /^(tasks|detailed)$/;
 *     · `v in { tasks: 1, detailed: 1 }`.
 *   A VALUE ASKED WHETHER IT IS ONE OF THE VALID WORDS: one value tested against the DEFAULT word
 *   ("tasks", what an estimate prints when nothing is said) and another, wherever the test stands
 *   and whatever is done with the answer — `if (!(v === "tasks" || v === "detailed")) return refuse()`,
 *   `const ok = v === "tasks" || …`, `(v) => v === "tasks" || v === "detailed"`, two `case` labels on
 *   one body. Nobody who READS a format needs that question (a reader asks WHICH word, or whether
 *   there is a breakdown); only a door deciding what is valid does, and that door is isEstimateFormat.
 *   A VALUE KEPT BECAUSE IT MATCHED A LIST, whichever words are on it:
 *     · `v === "detailed" || v === "grouped" ? v : null` and its mirror `v !== … && v !== … ? null : v`;
 *     · `if (v === … || v === …) return v` (or stores v: `x = v`, `{ estimate_format: v }`), and the
 *       mirror that overwrites it: `if (v !== … && v !== …) v = null`;
 *     · `v === "detailed" ? "detailed" : "tasks"`: every value pressed into two of the words.
 *
 * WHAT IT LEAVES ALONE, on purpose. A READER may branch on a word, or on the two that print a
 * breakdown — the paper asking `format === "detailed"`, or
 * `if (format !== "detailed" && format !== "grouped") return null` before it prints one — because it
 * does something else with the answer: it does not keep or store the value, and it does not ask what
 * is valid. A menu lists its choices as rows with labels ({ id: "grouped", label }). A
 * Record<EstimateFormat, …> is checked by the compiler, word for word. A type union
 * ("tasks" | "detailed" | "grouped") is checked by the compiler too: a stale one is a type error the
 * day a new word reaches it, never a silent default.
 *
 * WHAT A FAILURE TELLS YOU: the file, the line, which shape it is and the code. THE CURE is always
 * the same: import isEstimateFormat (or ESTIMATE_FORMATS) from @/lib/doc-style and ask it; a reader
 * that needs a question of its own asks it about ONE word (`format !== "tasks"`).
 * WHY IT CANNOT PASS BY SCANNING NOTHING: the scan counts its files, proves on the home file itself
 * that it can see a real list in real source, and the scanner's own cases below hold every shape —
 * among them the four lines that stood in the app the day before this test was written.
 */
const ROOT = process.cwd();

/** The one file that may list the words. */
export const HOME = "src/lib/doc-style.ts";

export const RULE =
  "ONE FORMAT CHECK: only src/lib/doc-style.ts lists the words an estimate's paper can read as (ESTIMATE_FORMATS). " +
  "A second list goes stale the day a word is added, and a value that misses it becomes the company's default without a word. " +
  "Ask isEstimateFormat(value) from @/lib/doc-style instead. A reader may branch on a word; it may not keep or store a value by a list of its own, or ask what is valid.";

/** A list that stands on purpose: the exact code, its file, and why. Empty, and meant to stay so. */
const ALLOW: { file: string; text: string; why: string }[] = [];

export type Listing = { line: number; kind: string; text: string };

const ARRAY = "an array of the words";
const IN_OBJECT = "an `in` over an object of the words";
const IN_TEXT = "a list of the words in a string or a regex";
const VALID = "a value asked whether it is one of the valid words";
const KEPT = "a value kept because it matched a list of the words";
const REPLACED = "a value replaced because it missed a list of the words";
const PRESSED = "every value pressed into two of the words";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every place one file lists the format words for itself. Pure: text in, listings out.
 * `words` is the paper's own list and `standard` its default word (lib/doc-style) unless a case
 * hands others.
 */
export function collectFormatLists(
  source: string,
  fileName: string,
  words: readonly string[] = ESTIMATE_FORMATS,
  standard: string = DEFAULT_DOC_STYLE.estimate_format,
): Listing[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const known = new Set(words);
  const out: Listing[] = [];
  /** The tests already told about (as kept or replaced), so the same test is not told twice. */
  const told = new Set<ts.Node>();
  const add = (node: ts.Node, kind: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const text = node.getText(sf).replace(/\s+/g, " ").slice(0, 200);
    if (!out.some((o) => o.line === line && o.kind === kind && o.text === text)) out.push({ line, kind, text });
  };

  /** Through parentheses, casts and `!`: the expression a person would say it is. */
  const strip = (e: ts.Expression): ts.Expression => {
    let x = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
    return x;
  };
  /** An expression as one comparable string: `meta.estimate_format`, however it was spaced. */
  const key = (e: ts.Expression) => strip(e).getText(sf).replace(/\s+/g, "");
  /** The format word an expression IS, when it is one of them as a plain string. */
  const wordOf = (e: ts.Expression): string | null => {
    const x = strip(e);
    return (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && known.has(x.text) ? x.text : null;
  };
  /** `v === "detailed"` / `"detailed" !== v`: the operand and the word, and whether it asks "is not". */
  const comparison = (e: ts.Expression): { operand: string; word: string; not: boolean } | null => {
    const x = strip(e);
    if (!ts.isBinaryExpression(x)) return null;
    const op = x.operatorToken.kind;
    const is = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
    const not = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!is && !not) return null;
    const right = wordOf(x.right);
    const left = wordOf(x.left);
    if (right !== null && left === null) return { operand: key(x.left), word: right, not };
    if (left !== null && right === null) return { operand: key(x.right), word: left, not };
    return null;
  };
  /**
   * A MEMBERSHIP TEST: one operand asked against two or more of the words — `v === a || v === b` (is
   * one of them) or `v !== a && v !== b` (is none of them; `negated`). A leading `!` turns one into
   * the other. Other things may ride the same chain (`|| v === null`); they are not the test.
   */
  type Membership = { operand: string; negated: boolean; words: Set<string>; chain: ts.BinaryExpression };
  const membership = (e: ts.Expression): Membership | null => {
    let x = strip(e);
    let flip = false;
    while (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) {
      flip = !flip;
      x = strip(x.operand);
    }
    if (!ts.isBinaryExpression(x)) return null;
    const op = x.operatorToken.kind;
    const or = op === ts.SyntaxKind.BarBarToken;
    const and = op === ts.SyntaxKind.AmpersandAmpersandToken;
    if (!or && !and) return null;
    const leaves: ts.Expression[] = [];
    const flatten = (n: ts.Expression): void => {
      const s = strip(n);
      if (ts.isBinaryExpression(s) && s.operatorToken.kind === op) {
        flatten(s.left);
        flatten(s.right);
      } else leaves.push(s);
    };
    flatten(x);
    const seen = new Map<string, Set<string>>();
    for (const leaf of leaves) {
      const c = comparison(leaf);
      // An OR is a list only of "is" answers; an AND only of "is not" answers.
      if (!c || c.not !== and) continue;
      if (!seen.has(c.operand)) seen.set(c.operand, new Set());
      seen.get(c.operand)!.add(c.word);
    }
    for (const [operand, hit] of seen) if (hit.size >= 2) return { operand, negated: and !== flip, words: hit, chain: x };
    return null;
  };

  /** Does this branch KEEP the value: return it, store it, or hand it on under a name? */
  const keeps = (branch: ts.Node | undefined, operand: string): boolean => {
    if (!branch) return false;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isReturnStatement(n) && n.expression && key(n.expression) === operand) found = true;
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && key(n.right) === operand) found = true;
      else if (ts.isPropertyAssignment(n) && key(n.initializer) === operand) found = true;
      else if (ts.isShorthandPropertyAssignment(n) && n.name.text === operand) found = true;
      else if (ts.isVariableDeclaration(n) && n.initializer && key(n.initializer) === operand) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(branch);
    return found;
  };
  /** Does this branch OVERWRITE the value: `v = …`? */
  const overwrites = (branch: ts.Node | undefined, operand: string): boolean => {
    if (!branch) return false;
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && key(n.left) === operand) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(branch);
    return found;
  };

  const alternatives = words.map(escapeRe).join("|");
  /** ('tasks','detailed') · ("tasks", "detailed") · (tasks,detailed): SQL's `in (…)`, PostgREST's `in.(…)`. */
  const listed = new RegExp(`\\(\\s*['"]?(?:${alternatives})['"]?\\s*(?:,\\s*['"]?(?:${alternatives})['"]?\\s*)+\\)`, "i");
  /** tasks|detailed: a regex's alternation, or a pattern kept as a string. */
  const alternated = new RegExp(`(?<![\\w-])(?:${alternatives})\\s*\\|\\s*(?:${alternatives})(?![\\w-])`, "i");
  const inText = (node: ts.Node, text: string) => {
    if (listed.test(text) || alternated.test(text)) add(node, IN_TEXT);
  };
  const isLogical = (n: ts.Node): n is ts.BinaryExpression =>
    ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken);

  const walk = (n: ts.Node): void => {
    if (ts.isArrayLiteralExpression(n)) {
      const hit = new Set(n.elements.map((el) => wordOf(el)).filter((w): w is string => w !== null));
      if (hit.size >= 2) add(n, ARRAY);
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      const right = strip(n.right);
      if (ts.isObjectLiteralExpression(right)) {
        const names = new Set(right.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "")).filter((name) => known.has(name)));
        if (names.size >= 2) add(n, IN_OBJECT);
      }
    } else if (ts.isConditionalExpression(n)) {
      const m = membership(n.condition);
      if (m && key(m.negated ? n.whenFalse : n.whenTrue) === m.operand) {
        told.add(m.chain);
        add(n, KEPT);
      }
      // `v === "detailed" ? "detailed" : "tasks"`: one word asked, two words answered, whatever v was.
      if (comparison(n.condition) && wordOf(n.whenTrue) !== null && wordOf(n.whenFalse) !== null) add(n, PRESSED);
    } else if (ts.isIfStatement(n)) {
      const m = membership(n.expression);
      if (m) {
        const [hit, miss] = m.negated ? [n.elseStatement, n.thenStatement] : [n.thenStatement, n.elseStatement];
        const kind = keeps(hit, m.operand) ? KEPT : overwrites(miss, m.operand) ? REPLACED : null;
        if (kind) {
          told.add(m.chain);
          add(n.expression, kind);
        }
      }
    } else if (isLogical(n)) {
      // The top of a chain only (its parent is not more of the same chain), and only once.
      let parent: ts.Node = n.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      const top = !(isLogical(parent) && parent.operatorToken.kind === n.operatorToken.kind);
      if (top && !told.has(n)) {
        const m = membership(n);
        if (m && m.words.has(standard)) add(n, VALID);
      }
    } else if (ts.isCaseBlock(n)) {
      // `case "tasks": case "detailed":` — labels that share one body are a list. A switch that gives
      // each word a body of its own is a reader, and the best kind (the compiler can hold it whole).
      let group = new Set<string>();
      for (const clause of n.clauses) {
        if (ts.isCaseClause(clause)) {
          const w = wordOf(clause.expression);
          if (w !== null) group.add(w);
        }
        if (clause.statements.length > 0) {
          if (group.size >= 2 && group.has(standard)) add(clause, VALID);
          group = new Set<string>();
        }
      }
    } else if (ts.isRegularExpressionLiteral(n)) {
      inText(n, n.text);
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent)) {
      inText(n, n.text);
    } else if (ts.isTemplateExpression(n)) {
      // Each run of text between the ${holes}; a hole is not a word.
      if ([n.head.text, ...n.templateSpans.map((s) => s.literal.text)].some((piece) => listed.test(piece) || alternated.test(piece))) add(n, IN_TEXT);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

const allowed = (file: string, text: string) => ALLOW.some((a) => a.text === text && file.endsWith(a.file));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every .ts and .tsx file under src/ that ships: not a test, not a type declaration. */
function appFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...appFiles(p));
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const kinds = (src: string, file = "a.ts") => collectFormatLists(src, file).map((l) => l.kind);

describe("the scanner reads the shapes a second list takes", () => {
  it("THE FOUR THAT STOOD IN THE APP THE DAY BEFORE (cn-v1157; each expression as it was written, in the smallest statement that holds it): the pill's write, the save, Revise / Duplicate, the editor's seed", () => {
    const yesterday = [
      // quotes/actions.ts updateQuoteMeta
      `if (meta.estimate_format !== undefined) clean.estimate_format = meta.estimate_format === "tasks" || meta.estimate_format === "detailed" ? meta.estimate_format : null;`,
      // quotes/actions.ts saveQuote
      `const estimateFormat: "tasks" | "detailed" | null | undefined =\n    input.estimate_format === "tasks" || input.estimate_format === "detailed" ? input.estimate_format : input.estimate_format === null ? null : undefined;`,
      // quotes/actions.ts duplicateQuote
      `const row = { ...(withFormat ? { estimate_format: format === "tasks" || format === "detailed" ? format : null } : {}) };`,
      // quotes/estimate-editor.tsx headerFrom
      `const h = { estimateFormat: q.estimate_format === "tasks" || q.estimate_format === "detailed" ? q.estimate_format : null, title: q.title ?? "" };`,
    ];
    // Each is told once, as what it is: the value kept. (The same test is not told again as a validity question.)
    for (const line of yesterday) expect(kinds(line), line).toEqual([KEPT]);
    // And the two shapes the home file itself held (it is the one place a list may stand, so it is
    // never scanned in the app — but its old shapes are exactly what must not be written anywhere else).
    expect(kinds(`function f(own: unknown) { if (own === "detailed" || own === "tasks") return own; return "tasks"; }`)).toEqual([KEPT]);
    expect(kinds(`const s = { estimate_format: r.estimate_format === "detailed" ? "detailed" : "tasks" };`)).toEqual([PRESSED]);
  });

  it("a value kept because it matched: the mirror with `!==`, a leading `!`, an if that returns or stores it, either side of the ===, whichever words are listed", () => {
    expect(kinds(`const v = f !== "tasks" && f !== "detailed" ? null : f;`)).toEqual([KEPT]);
    expect(kinds(`const v = !(f === "tasks" || f === "grouped") ? undefined : f;`)).toEqual([KEPT]);
    expect(kinds(`const v = ("tasks" === f || "grouped" == f) ? (f as string) : null;`)).toEqual([KEPT]);
    expect(kinds(`const own = f === "detailed" || f === "grouped" ? f : null;`)).toEqual([KEPT]); // no default word on the list: still kept by it
    expect(kinds(`function g(f: string) { if (f === "detailed" || f === "grouped") { return f; } return null; }`)).toEqual([KEPT]);
    expect(kinds(`function g(row: any, f: string) { if (f === "tasks" || f === "detailed" || f === null) row.estimate_format = f; }`)).toEqual([KEPT]);
    expect(kinds(`function g(f: string) { if (f === "tasks" || f === "detailed") save({ estimate_format: f }); }`)).toEqual([KEPT]);
    expect(kinds(`function g(estimate_format: string) { if (estimate_format === "tasks" || estimate_format === "detailed") save({ estimate_format }); }`)).toEqual([KEPT]);
    expect(kinds(`function g(f: string | null) { if (f !== "detailed" && f !== "grouped") f = null; return f; }`)).toEqual([REPLACED]);
    expect(kinds(`function g(f: string | null) { if (f !== "tasks" && f !== "detailed") { log(); } else { return f; } }`)).toEqual([KEPT]);
  });

  it("a value asked whether it is one of the VALID words (the default word and another), whatever is done with the answer", () => {
    // The door that refuses instead of defaulting: no value is kept in the branch, and it is still a second list.
    expect(kinds(`function g(fmt: string) { if (!(fmt === "tasks" || fmt === "detailed")) return { ok: false }; return write(fmt); }`)).toEqual([VALID]);
    expect(kinds(`function g(fmt: string) { if (fmt !== "tasks" && fmt !== "detailed") return refuse(); return write(fmt); }`)).toEqual([VALID]);
    expect(kinds(`const ok = fmt === "tasks" || fmt === "detailed";`)).toEqual([VALID]);
    expect(kinds(`const ok = ready && (fmt === "tasks" || fmt === "grouped" || fmt === "detailed");`)).toEqual([VALID]);
    // A second isEstimateFormat by another name.
    expect(kinds(`const isFormat = (v: unknown): v is "tasks" | "detailed" => v === "tasks" || v === "detailed";`)).toEqual([VALID]);
    expect(kinds(`function isFormat(v: unknown) { return v === "tasks" || v === "detailed" || v === "grouped"; }`)).toEqual([VALID]);
    // Labels that share one body.
    expect(kinds(`function g(v: string) { switch (v) { case "tasks": case "detailed": return v; default: return null; } }`)).toEqual([VALID]);
  });

  it("an array of the words, however it is used; an `in` over an object of them", () => {
    expect(kinds(`const ok = ["tasks", "detailed"].includes(v);`)).toEqual([ARRAY]);
    expect(kinds(`const FORMATS = ["tasks", "detailed", "grouped"] as const;`)).toEqual([ARRAY]);
    expect(kinds(`const set = new Set(["detailed", "grouped"]);`)).toEqual([ARRAY]);
    expect(kinds(`const q = supabase.from("quotes").select("id").in("estimate_format", ["tasks", \`detailed\`]);`)).toEqual([ARRAY]);
    expect(kinds(`const ok = v in { tasks: 1, detailed: 1 };`)).toEqual([IN_OBJECT]);
    expect(kinds(`const ok = v in ({ "grouped": true, tasks: true } as const);`)).toEqual([IN_OBJECT]);
  });

  it("a list of the words inside a string or a regex: SQL's in (…), PostgREST's in.(…), an alternation", () => {
    expect(kinds(`const sql = "alter table quotes add check (estimate_format in ('tasks','detailed'))";`)).toEqual([IN_TEXT]);
    expect(kinds("const sql = `select 1 from quotes where estimate_format IN (\"tasks\", \"grouped\") and id = ${id}`;")).toEqual([IN_TEXT]);
    expect(kinds(`const f = q.or("estimate_format.in.(tasks,detailed,grouped)");`)).toEqual([IN_TEXT]);
    expect(kinds(`const ok = /^(tasks|detailed)$/.test(v);`)).toEqual([IN_TEXT]);
    expect(kinds(`const re = new RegExp("^(?:detailed | grouped)$");`)).toEqual([IN_TEXT]);
    expect(kinds(`const A = () => <Field pattern="tasks|grouped" />;`, "a.tsx")).toEqual([IN_TEXT]);
  });

  it("the file and the line are named, and one file that lists twice is told twice", () => {
    const src = `const a = 1;\nconst ok = ["tasks", "grouped"].includes(v) ? v : null;\nconst w = v === "tasks" || v === "detailed" ? v : null;\n`;
    expect(collectFormatLists(src, "a.ts").map((l) => [l.line, l.kind])).toEqual([[2, ARRAY], [3, KEPT]]);
    expect(collectFormatLists(src, "a.ts")[1].text).toBe(`v === "tasks" || v === "detailed" ? v : null`);
  });
});

describe("the scanner leaves a reader, a menu and a type alone", () => {
  it("A READER BRANCHES ON A WORD, OR ON THE TWO THAT PRINT A BREAKDOWN, AND DOES SOMETHING ELSE WITH THE ANSWER: the paper's own lines pass", () => {
    const readers = [
      // components/quote-document.tsx, before the third word
      `const d = estimateFormat === "detailed" ? coerceTaskDetail(it.detail) : null;`,
      // lib/estimate/task-lines.ts paperBreakdown (cn-v1158): nothing prints unless it is one of the two breakdowns
      `function paperBreakdown(line: Line, format: string) { if (format !== "detailed" && format !== "grouped") return null; const read = coerceTaskDetail(line.detail); const d = format === "grouped" ? wire(read) : read; const parts = format === "detailed" ? d.materials : []; return { parts }; }`,
      `const breakdown = format === "detailed" || format === "grouped" ? paperBreakdown(it, format) : null;`,
      `if (format === "detailed" || format === "grouped") rows.push(render(format));`,
      `const hasBreakdown = format === "detailed" || format === "grouped";`,
      `const breaksDown = (f: string) => f === "detailed" || f === "grouped";`,
      `const plain = format === "tasks";`,
      `const anyBreakdown = format !== "tasks";`,
      // Each word a body of its own: a reader, and the kind the compiler can hold whole.
      `function words(f: string) { switch (f) { case "tasks": return 0; case "detailed": return 2; case "grouped": return 1; default: return 0; } }`,
      `function prints(f: string) { switch (f) { case "detailed": case "grouped": return true; default: return false; } }`,
      // The customer's page, until 0408 is applied: the word is INFERRED from the data, never tested against a list.
      `const estimateFormat = isEstimateFormat(said) ? said : items.some((it) => it?.detail != null) ? "detailed" : "tasks";`,
    ];
    for (const src of readers) expect(collectFormatLists(src, "a.ts"), src).toEqual([]);
  });

  it("the one check, a menu's rows, a Record over the type, a type union, a comment", () => {
    const fine = [
      `const v = isEstimateFormat(raw) ? raw : null;`,
      `const all = ESTIMATE_FORMATS.map((f) => f);`,
      `const items = [{ id: "tasks", label: "Hidden" }, { id: "detailed", label: "Every Part" }, { id: "grouped", label: "One Materials Line" }];`,
      `const LABEL: Record<EstimateFormat, string> = { detailed: "a", grouped: "b", tasks: "c" };`,
      `interface Quote { estimate_format?: "tasks" | "detailed" | "grouped" | null }`,
      `const pick = (id: string) => apply(id as "tasks" | "detailed");`,
      `// estimate_format in ('tasks','detailed') was 0395's check; ["tasks", "detailed"] its two words\nconst a = 1;`,
    ];
    for (const src of fine) expect(collectFormatLists(src, "a.ts"), src).toEqual([]);
  });

  it("one of the words beside words that are not formats is somebody else's list (a tab strip, a table name)", () => {
    expect(kinds(`const TABS = ["overview", "tasks", "notes"];`)).toEqual([]);
    expect(kinds(`const open = tab === "tasks" || tab === "notes" ? tab : "overview";`)).toEqual([]);
    expect(kinds(`const ok = tab === "tasks" || format === "detailed" ? tab : null;`)).toEqual([]); // two operands: neither is asked twice
    expect(kinds(`const q = "select * from tasks where kind in ('tasks','visits')";`)).toEqual([]);
    expect(kinds(`const s = "grouped by day (tasks, visits)";`)).toEqual([]);
    // The same word twice is one word.
    expect(kinds(`const dup = ["tasks", "tasks"];`)).toEqual([]);
    expect(kinds(`const v = f === "tasks" || f === "tasks" ? f : null;`)).toEqual([]);
  });

  it("the words and the default are the paper's own: a word added there is watched for here the same day", () => {
    const src = `const v = f === "tasks" || f === "labor" ? f : null; const a = ["labor", "grouped"]; const ok = g === "labor" || g === "detailed";`;
    expect(collectFormatLists(src, "a.ts")).toEqual([]); // "labor" is not a format today
    expect(collectFormatLists(src, "a.ts", [...ESTIMATE_FORMATS, "labor"]).map((l) => l.kind)).toEqual([KEPT, ARRAY]);
    // …and the validity question follows whichever word is the default.
    expect(collectFormatLists(src, "a.ts", [...ESTIMATE_FORMATS, "labor"], "labor").map((l) => l.kind)).toEqual([KEPT, ARRAY, VALID]);
    expect(DEFAULT_DOC_STYLE.estimate_format).toBe("tasks");
  });
});

describe("the app has one list of the format words", () => {
  const files = appFiles(join(ROOT, "src")).map((f) => relative(ROOT, f));
  const listings = files.filter((f) => f !== HOME).flatMap((f) => collectFormatLists(read(f), f).map((l) => ({ ...l, file: f })));

  it("the scan read the app, and it can see a real list in real source: the home file's own", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain(HOME);
    // The home file is skipped in the app scan because it is where the list lives. Read on its own, the
    // scanner finds that list — so a scanner that had gone blind would fail HERE, not pass quietly.
    const home = collectFormatLists(read(HOME), HOME);
    expect(home.map((l) => [l.kind, l.text])).toEqual([[ARRAY, `[${ESTIMATE_FORMATS.map((w) => JSON.stringify(w)).join(", ")}]`]]);
    // …and the list is the three words, asked through the one check.
    expect([...ESTIMATE_FORMATS]).toEqual(["tasks", "detailed", "grouped"]);
    for (const w of ESTIMATE_FORMATS) expect(isEstimateFormat(w), w).toBe(true);
    for (const junk of ["itemized", "Grouped", "", null, undefined, 3, ["grouped"]]) expect(isEstimateFormat(junk), String(junk)).toBe(false);
  });

  it("every allowlisted list is still in the app (a stale entry is a hole)", () => {
    for (const a of ALLOW) expect(listings.some((l) => l.text === a.text && l.file.endsWith(a.file)), `${a.file} "${a.text}"`).toBe(true);
  });

  it("no file but lib/doc-style lists the words, keeps a value by a list of its own, or asks what is valid", () => {
    const strays = listings.filter((l) => !allowed(l.file, l.text)).map((l) => `${l.file}:${l.line} ${l.kind}: ${l.text}`);
    expect(strays, RULE).toEqual([]);
  }, 60_000);
});
