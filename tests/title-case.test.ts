import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * EVERY CLICKABLE IS TITLE CASE (Erik's law, cn-v1134: "Add A Task", "Won · Pick The Job",
 * "Save Inspection" — every word capitalized, never "Save inspection").
 *
 * This is the check, not a one-off sweep. It reads every screen file with the compiler (a regex
 * cannot tell a Button's words from a comment or a template) and collects the words a person taps:
 *
 *   · the text children of <Button>, <button>, <Link>, <a>, <FormSubmit> and any <…Button> (across
 *     lines, through a nested <span>, and the string branches of {busy ? "Saving…" : "Save Changes"});
 *   · the words AFTER a computed expression inside a door when they are a label of their own (two or
 *     more words: "Log {hours}h On This Job"); a one-word tail is a figure's unit or plural ({n} people,
 *     item{s}) and a possessive ({name}'s Panel) is the name's, and neither is judged;
 *   · the label props: saveLabel / cancelLabel / openLabel / buttonLabel / rowLabel / editLabel /
 *     ctaLabel / armedLabel on any element, and label="…" on a <…Button>, ModalActions, LinkPicker;
 *   · a Modal's title="…";
 *   · the rows of a <select>: an <option value="…">'s text (an <option> with no value attribute
 *     SUBMITS its text — a stored word, not a label — and is left alone);
 *   · the dock's, the palette's and the + menu's `label: "…"` rows, and a SegmentedControl's items.
 *
 * THE RULE: every word begins with a capital letter, a digit or a symbol. "·", "&", "/", "—", "+"
 * and a quoted bit pass on their own; the word after a "·", an "&" or a "(" is a word and must be
 * capitalized too. A template literal, or anything the compiler cannot read as plain words, is
 * skipped rather than guessed at. A text that ends in a period is a sentence beside the door
 * (a sub-line on a two-line row), not its label, and is not judged.
 *
 * WHAT A FAILURE TELLS YOU: the file, the line, the words and the first word that is not capital.
 * WHY IT CANNOT PASS BY SCANNING NOTHING: the scan counts the files and the labels it read and
 * fails if either is implausibly small; the scanner's own cases below prove each shape it reads.
 */

const ROOT = process.cwd();

/** Elements whose children are the words on the door. A plain <a> is a door too (the public site's
 *  "See Our Work", a job's "Check With City ↗"). */
const DOOR_TAG = (tag: string) => tag === "button" || tag === "Link" || tag === "a" || tag === "FormSubmit" || /Button$/.test(tag);
/** Attributes that are a door's words wherever they appear. */
const LABEL_ATTR = /^(save|cancel|open|button|row|edit|cta|armed)Label$/;
/** Elements on which a plain label="…" is the door's words (a field's label="…" is not a door). */
const LABEL_TAG = (tag: string) => /Button$/.test(tag) || tag === "ModalActions" || tag === "LinkPicker";
/** Elements whose title="…" is a sheet's heading (Title Case, like the row that opened it). */
const TITLE_TAG = (tag: string) => tag === "Modal";
/** Files whose `label: "…"` rows are menu rows. */
const MENU_FILES = ["src/lib/dock.ts", "src/components/command-bar.tsx", "src/components/global-quick-add.tsx"];

export type Hit = { line: number; kind: string; text: string };

/** Entities the JSX text may carry, read as the symbol or space they stand for. */
const plainText = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&(?:apos|quot|rsquo|lsquo|rdquo|ldquo|hellip|middot|rarr|larr|mdash|ndash|times|#x?[0-9a-f]+);/gi, (m) =>
      /quot|rsquo|lsquo|rdquo|ldquo|apos/i.test(m) ? "'" : "·",
    )
    .replace(/\s+/g, " ")
    .trim();

/**
 * The words a person taps, read from one file's source. Pure: text in, hits out.
 */
export function collectClickables(source: string, fileName: string): Hit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const add = (node: ts.Node, kind: string, raw: string) => {
    const text = plainText(raw);
    if (!text || !/\p{L}/u.test(text)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const key = `${line}:${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ line, kind, text });
  };

  const tagOf = (n: ts.JsxOpeningLikeElement) => n.tagName.getText(sf);
  const attrsOf = (n: ts.JsxOpeningLikeElement) => n.attributes.properties.filter(ts.isJsxAttribute);
  const attrName = (a: ts.JsxAttribute) => (ts.isIdentifier(a.name) ? a.name.text : a.name.getText(sf));

  /**
   * The plain string(s) an expression holds: a literal, both arms of a ?:, the right of && / ?? / ||.
   * Returns false when it met something that is not plain words (an identifier, a call, a template
   * with a hole): the door's words are COMPUTED from there on.
   */
  const stringsOf = (e: ts.Expression | undefined, kind: string, into: (n: ts.Node, k: string, s: string) => void): boolean => {
    if (!e) return true;
    // null, undefined, true, false: nothing on the door, and nothing computed either.
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isIdentifier(e) && e.text === "undefined") return true;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      into(e, kind, e.text);
      return true;
    }
    if (ts.isParenthesizedExpression(e)) return stringsOf(e.expression, kind, into);
    if (ts.isConditionalExpression(e)) {
      const a = stringsOf(e.whenTrue, kind, into);
      const b = stringsOf(e.whenFalse, kind, into);
      return a && b;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return stringsOf(e.right, kind, into);
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        const a = stringsOf(e.left, kind, into);
        const b = stringsOf(e.right, kind, into);
        return a && b;
      }
      return false;
    }
    if (ts.isJsxElement(e) || ts.isJsxFragment(e) || ts.isJsxSelfClosingElement(e)) {
      doorWords(e, kind, into);
      return true;
    }
    // An identifier, a call, a template with a hole: not plain words — skipped, never guessed.
    return false;
  };

  /**
   * The text children of a door, through nested plain elements; a nested door is its own visit.
   * Once the door's words turn out to be computed ({n} people, {name}'s Panel, item{s}), a one-word
   * tail is a unit or a plural of a figure and a possessive tail is the name's — not judged. A tail of
   * two or more words ("Log {hours}h On This Job", "{icon} Read More") is a label of its own, and is.
   */
  const doorWords = (n: ts.Node, kind: string, into: (n: ts.Node, k: string, s: string) => void): void => {
    let computed = false;
    const quiet = (node: ts.Node, k: string, raw: string) => {
      const text = plainText(raw);
      if (/^['’]s\b/.test(text)) return; // {name}'s Panel: the name's possessive
      if (text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length < 2) return; // {n} people, item{s}: a unit or a plural
      into(node, `${k} (tail)`, raw);
    };
    const visit = (node: ts.Node): void => {
      const children: ts.NodeArray<ts.JsxChild> | undefined = ts.isJsxElement(node) ? node.children : ts.isJsxFragment(node) ? node.children : undefined;
      if (!children) return;
      for (const c of children) {
        const sink = computed ? quiet : into;
        if (ts.isJsxText(c)) sink(c, kind, c.text);
        else if (ts.isJsxExpression(c)) {
          if (!stringsOf(c.expression, kind, sink)) computed = true;
        } else if (ts.isJsxElement(c)) {
          if (!DOOR_TAG(tagOf(c.openingElement))) visit(c);
        } else if (ts.isJsxFragment(c)) visit(c);
      }
    };
    visit(n);
  };

  const walk = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = tagOf(opening);
      for (const a of attrsOf(opening)) {
        const name = attrName(a);
        const init = a.initializer;
        const expr = init && ts.isJsxExpression(init) ? init.expression : init;
        if (LABEL_ATTR.test(name) || (name === "label" && LABEL_TAG(tag))) stringsOf(expr, `${tag} ${name}`, add);
        else if (name === "title" && TITLE_TAG(tag)) stringsOf(expr, `${tag} title`, add);
      }
      if (ts.isJsxElement(n) && DOOR_TAG(tag)) doorWords(n, `<${tag}>`, add);
      // A select's row is a clickable; one with no value attribute submits its text and is not judged.
      if (ts.isJsxElement(n) && tag === "option" && attrsOf(opening).some((a) => attrName(a) === "value")) doorWords(n, "<option>", add);
      if (tag === "SegmentedControl") {
        const items = attrsOf(opening).find((a) => attrName(a) === "items");
        const expr = items?.initializer && ts.isJsxExpression(items.initializer) ? items.initializer.expression : undefined;
        if (expr && ts.isArrayLiteralExpression(expr)) for (const el of expr.elements) if (ts.isObjectLiteralExpression(el)) menuLabel(el, "SegmentedControl item");
      }
    }
    if (MENU_FILES.includes(fileName) && ts.isObjectLiteralExpression(n)) menuLabel(n, "menu row");
    ts.forEachChild(n, walk);
  };
  const menuLabel = (o: ts.ObjectLiteralExpression, kind: string) => {
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "label") stringsOf(p.initializer, kind, add);
    }
  };
  walk(sf);
  return hits;
}

/** A name spelled by its owner, kept as its owner spells it (Apple's "Tap to Pay on iPhone"). */
const PROPER_NAMES = ["Tap to Pay on iPhone", "Tap to Pay", "iPhone", "iPad", "iOS", "macOS"];

/**
 * The first word of the text that does not begin with a capital, a digit or a symbol — or null
 * when every word does. A quoted bit is one thing and passes; a "/" splits two words; a file
 * extension (".vcf") is a name, not a word; a proper name keeps its owner's spelling.
 */
export function titleCaseOffence(text: string): string | null {
  let plain = text.replace(/“[^”]*”|"[^"]*"|‘[^’]*’/g, " ");
  for (const name of PROPER_NAMES) plain = plain.split(name).join(" ");
  for (const tok of plain.split(/[\s/]+/).filter(Boolean)) {
    if (tok.startsWith(".")) continue;
    const core = tok.replace(/^[^\p{L}\p{N}]+/u, "");
    if (!core) continue;
    if (/^\p{Ll}/u.test(core)) return tok;
  }
  return null;
}

/**
 * Words beside a door that are not its label: a sentence (a two-line row's second line, ending in a
 * period) or a dash- or dot-led tail ("— type the dimensions…", " · oldest first") after the words.
 */
export const isSentence = (text: string) => (/[.]$/.test(text) && !/…$/.test(text)) || /^[—–·]/.test(text);

/**
 * DELIBERATE PROSE THAT IS NOT A LABEL. Each entry is the exact words, with the file when the same
 * words are a label elsewhere, and why it stands.
 */
const ALLOW: { text: string; file?: string; why: string }[] = [
  // A link whose words are the estimate's number; these are its stand-in, a noun inside the sentence
  // "Superseded by … — that estimate is the price for this work now." / "Revises …".
  { text: "its revision", file: "src/app/(app)/quotes/estimate-editor.tsx", why: "a noun inside a sentence, standing in for the estimate's number" },
  { text: "an earlier estimate", file: "src/app/(app)/quotes/estimate-editor.tsx", why: "a noun inside a sentence, standing in for the estimate's number" },
  // APPLE'S WORDS. The Tap to Pay on iPhone awareness screen's two CTAs are the marketing toolkit's
  // approved strings, verbatim (awareness.tsx header) — the one place the Title Case law yields.
  { text: "Enable now", file: "src/components/tap-to-pay/awareness.tsx", why: "Apple's approved Tap to Pay on iPhone CTA, verbatim — Apple's review wording, not ours to re-case" },
  { text: "Learn more", file: "src/components/tap-to-pay/awareness.tsx", why: "Apple's approved Tap to Pay on iPhone CTA, verbatim — Apple's review wording, not ours to re-case" },
  // A site version is written v3, the way versions are written; the number is computed beside it.
  { text: "v", file: "src/app/(app)/site-studio/studio.tsx", why: "the v of a version number (v3)" },
  { text: "Publish v", file: "src/app/(app)/site-studio/studio.tsx", why: "the v of a version number (Publish v3)" },
  // A sheet size with its area in a unit ("4×8 (32 ft²)"): the unit is written as units are.
  { text: "4×8 (32 ft²)", file: "src/app/(app)/tools/tools-view.tsx", why: "a figure's unit (ft²) after the size" },
  { text: "4×12 (48 ft²)", file: "src/app/(app)/tools/tools-view.tsx", why: "a figure's unit (ft²) after the size" },
  // A figure's unit and its state ("12.5 mi held"): a mileage row, not a label.
  { text: "mi held", file: "src/app/(app)/payroll/person-statement.tsx", why: "a figure's unit (mi) and state, after the miles" },
  // A noun phrase inside the customer's sentence ("Plus $500 of work not yet billed, …"), the figure before it.
  { text: "of work", file: "src/components/portal/portal-job-page.tsx", why: "a noun phrase inside a sentence, after the figure" },
];

const allowed = (file: string, text: string) => ALLOW.some((a) => a.text === text && (!a.file || file.endsWith(a.file)));

function screenFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...screenFiles(p));
    else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

describe("the scanner reads the shapes a door's words take", () => {
  it("a multi-line Button, an icon beside the words, and a nested span", () => {
    const src = `
      const A = () => (
        <>
          <Button onClick={go}>
            Save
            changes
          </Button>
          <Button><Plus className="h-4 w-4" /> New Lead</Button>
          <button type="button"><span className="font-medium">Edit Details…</span><span className="text-xs">Opens the form.</span></button>
          <p><Link href="/login">Sign up</Link> or <a href="/x">See our work</a></p>
        </>
      );`;
    const hits = collectClickables(src, "a.tsx");
    expect(hits.map((h) => h.text)).toEqual(["Save changes", "New Lead", "Edit Details…", "Opens the form.", "Sign up", "See our work"]);
    expect(hits.find((h) => h.text === "Save changes")?.line).toBe(5);
  });

  it("a conditional expression's string arms, an &&, a ?? — never a template or an identifier", () => {
    const src = `
      const A = () => (
        <Button>{busy ? "Saving…" : "Save changes"}{more && "and more"}{word ?? "Fallback word"}{\`At \${t}\`}{label}</Button>
      );`;
    expect(collectClickables(src, "a.tsx").map((h) => h.text)).toEqual(["Saving…", "Save changes", "and more", "Fallback word"]);
  });

  it("a figure's unit or plural after a computed expression is not a label, nor a name's possessive; the words before it are, and so is a tail of two or more words", () => {
    const src = `
      const A = () => (
        <>
          <Link href="/x">{n} people</Link>
          <button>{n} item{n === 1 ? "" : "s"}</button>
          <Link href="/y">Edit {name}</Link>
          <Link href="/z">{name}<span>'s Panel</span></Link>
          <Button>{busy ? <Spinner /> : null} Save changes</Button>
          <Button>Log {hours > 0 ? \`\${hours}h\` : "Hours"} on this job</Button>
          <a href="/w">{icon} Read more</a>
        </>
      );`;
    expect(collectClickables(src, "a.tsx").map((h) => [h.kind, h.text])).toEqual([
      ["<Link>", "Edit"],
      ["<Button>", "Save changes"],
      ["<Button>", "Log"],
      ["<Button>", "Hours"],
      ["<Button> (tail)", "on this job"],
      ["<a> (tail)", "Read more"],
    ]);
  });

  it("the label props and a Modal's title, as a string or a conditional; a field's label is not a door", () => {
    const src = `
      const A = () => (
        <Modal title={editing ? "Edit appointment" : "New appointment"}>
          <Field label="Assigned to" />
          <ModalActions saveLabel="Save changes" cancelLabel="Not now" />
          <LinkPicker openLabel="Pick one" />
          <DeleteButton label="Delete it" />
          <SegmentedControl items={[{ id: "set", label: "Set a Time" }, { id: "propose", label: "Propose Times" }]} />
        </Modal>
      );`;
    expect(collectClickables(src, "a.tsx").map((h) => [h.kind, h.text])).toEqual([
      ["Modal title", "Edit appointment"],
      ["Modal title", "New appointment"],
      ["ModalActions saveLabel", "Save changes"],
      ["ModalActions cancelLabel", "Not now"],
      ["LinkPicker openLabel", "Pick one"],
      ["DeleteButton label", "Delete it"],
      ["SegmentedControl item", "Set a Time"],
      ["SegmentedControl item", "Propose Times"],
    ]);
  });

  it("a select's rows: an option with a value is judged by its text; one without submits its text and is not", () => {
    const src = `
      const A = () => (
        <select>
          <option value="">Pick a sheet…</option>
          <option value="none">No tax</option>
          <option>Lost time</option>
          {rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      );`;
    expect(collectClickables(src, "a.tsx").map((h) => [h.kind, h.text])).toEqual([
      ["<option>", "Pick a sheet…"],
      ["<option>", "No tax"],
    ]);
  });

  it("the dock's rows by label, only in the menu files", () => {
    const src = `export const X = [{ id: "a", label: "Time clock", icon: I }, { id: "b", label: "Jobs" }];`;
    expect(collectClickables(src, "src/lib/dock.ts").map((h) => h.text)).toEqual(["Time clock", "Jobs"]);
    expect(collectClickables(src, "src/lib/other.ts")).toEqual([]);
  });

  it("the rule: every word capital, a digit or a symbol; a quoted bit passes; the word after · & ( / counts", () => {
    for (const ok of ["Save Changes", "Won · Pick The Job", "Verify & Sign In", "Add 3 More", "Bills & POs", "Saved — Open It", "Say “yes please” Now", "Yes/No", "+ New", "E-sign It", "Don't Stop", "(Optional) Field", "Import A .vcf", "Enable Tap to Pay on iPhone", "Get This iPhone Ready"])
      expect(titleCaseOffence(ok), ok).toBeNull();
    expect(titleCaseOffence("Save changes")).toBe("changes");
    expect(titleCaseOffence("Won · pick the job")).toBe("pick");
    expect(titleCaseOffence("Verify & sign In")).toBe("sign");
    expect(titleCaseOffence("Open (your lien rights)")).toBe("(your");
    expect(titleCaseOffence("Yes/no")).toBe("no");
    expect(titleCaseOffence("Announce Tap to Pay on iPhone to the Crew")).toBe("to");
    expect(titleCaseOffence("iMessage Setup")).toBe("iMessage");
  });

  it("a sentence or a dash-led tail beside the door is not the door's words", () => {
    expect(isSentence("A lead: this visit and its address go on it.")).toBe(true);
    expect(isSentence("— type the dimensions, auto-fill the lines")).toBe(true);
    expect(isSentence("· oldest first")).toBe(true);
    expect(isSentence("Saving…")).toBe(false);
    expect(isSentence("Save changes")).toBe(false);
  });
});

describe("every clickable in the app is Title Case", () => {
  const files = [...screenFiles(join(ROOT, "src")).map((f) => relative(ROOT, f)), ...MENU_FILES.filter((f) => !f.endsWith(".tsx"))];
  const hits = files.flatMap((f) => collectClickables(readFileSync(join(ROOT, f), "utf8"), f).map((h) => ({ ...h, file: f })));

  it("scans the app", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(hits.length).toBeGreaterThan(1500);
  });

  it("every allowlisted line is still in the app (a stale entry is a hole)", () => {
    for (const a of ALLOW) expect(hits.some((h) => h.text === a.text && (!a.file || h.file.endsWith(a.file))), `${a.file ?? ""} "${a.text}"`).toBe(true);
  });

  it("names the first word that is not capital on every door that has one", () => {
    const offenders = hits
      .filter((h) => !isSentence(h.text) && !allowed(h.file, h.text))
      .map((h) => ({ ...h, word: titleCaseOffence(h.text) }))
      .filter((h) => h.word)
      .map((h) => `${h.file}:${h.line} ${h.kind} "${h.text}" — "${h.word}"`);
    expect(offenders).toEqual([]);
  }, 60_000);
});
