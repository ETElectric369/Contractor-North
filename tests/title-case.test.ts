import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { dict } from "@/lib/i18n";
import { titleCaseOffender } from "./title-case-words";

/**
 * EVERY CLICKABLE IS TITLE CASE (Erik's law, cn-v1134: "Add a Task", "Won · Pick the Job",
 * "Save Inspection" — the significant words capitalized, never "Save inspection"; the function words lowercase since
 * cn-v1147 in Spanish and cn-v1148 in English).
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
 *   · the dock's, the palette's and the + menu's `label: "…"` rows, and a SegmentedControl's items;
 *   · a t("key") door (cn-v1138), and fillText(t("key"), …): the key's words in BOTH languages from
 *     the one dictionary (lib/i18n), each a hit of its own labelled [en:key] / [es:key]; a {slot} in
 *     the words is a computed hole (the rule for a computed child applies to what follows it).
 *
 * THE RULE: the significant words, in both languages (tests/title-case-words holds it). English (cn-v1148, after
 * Chicago and Apple): a function word — a, an, the, and, or, as, to, of, in, on, by, for, with… — stays lowercase
 * except as the first or the last word of a segment ("Back to Schedule", "Who's on the Clock"; a particle stays
 * capital: "Sign In with a Code", "Turn It On"). Spanish (an [es:key] hit, cn-v1147, the RAE's way): a function word
 * (a, de, la, y…) stays lowercase except as the first word of a segment ("Lista de Precios", "Mover a un Día").
 * "·", "&", "/", "—", "+"
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

/** `via`: the dictionary key and language a t() door's words came from ("es:tc_clockIn"). */
export type Hit = { line: number; kind: string; text: string; via?: string };

type Sink = (n: ts.Node, k: string, s: string, via?: string) => void;

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
  const add: Sink = (node, kind, raw, via) => {
    const text = plainText(raw);
    if (!text || !/\p{L}/u.test(text)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const key = `${line}:${kind}:${via ?? ""}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(via ? { line, kind, text, via } : { line, kind, text });
  };

  /** The t("key") a door's words come from, when the expression is one: t("key"), or fillText(t("key"), …). */
  const translatedKey = (e: ts.Expression): string | null => {
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.arguments.length < 1) return null;
    const [first] = e.arguments;
    if (e.expression.text === "t") return ts.isStringLiteral(first) ? first.text : null;
    if (e.expression.text === "fillText") return translatedKey(first);
    return null;
  };

  const tagOf = (n: ts.JsxOpeningLikeElement) => n.tagName.getText(sf);
  const attrsOf = (n: ts.JsxOpeningLikeElement) => n.attributes.properties.filter(ts.isJsxAttribute);
  const attrName = (a: ts.JsxAttribute) => (ts.isIdentifier(a.name) ? a.name.text : a.name.getText(sf));

  /**
   * The plain string(s) an expression holds: a literal, both arms of a ?:, the right of && / ?? / ||.
   * Returns false when it met something that is not plain words (an identifier, a call, a template
   * with a hole): the door's words are COMPUTED from there on.
   */
  const stringsOf = (e: ts.Expression | undefined, kind: string, into: Sink): boolean => {
    if (!e) return true;
    // A t("key") door (cn-v1138): the key's words in BOTH languages are the door's words, each its
    // own hit. A {slot} is a computed hole: the words before the first are the label; a tail after
    // one is judged only when it is two or more words, as a computed child's tail is. An unknown key
    // is not plain words (a local t that is not the translator) and is skipped, never guessed.
    const key = translatedKey(e);
    if (key !== null) {
      if (!(key in dict("en"))) return false;
      for (const lang of ["en", "es"] as const) {
        const parts = (dict(lang)[key] ?? "").split(/\{\w+\}/);
        // The words before a slot are cut short by it: a (head) hit, whose last word may be mid-title ("Put It on {job} Instead").
        into(e, parts.length > 1 ? `${kind} (head)` : kind, parts[0], `${lang}:${key}`);
        parts.slice(1).forEach((tail, i, tails) => {
          if (plainText(tail).split(/\s+/).filter((w) => /\p{L}/u.test(w)).length < 2) return;
          into(e, `${kind} (tail)${i < tails.length - 1 ? " (head)" : ""}`, tail, `${lang}:${key}`);
        });
      }
      return true;
    }
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
  const doorWords = (n: ts.Node, kind: string, into: Sink): void => {
    let computed = false;
    const quiet: Sink = (node, k, raw, via) => {
      const text = plainText(raw);
      if (/^['’]s\b/.test(text)) return; // {name}'s Panel: the name's possessive
      if (text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length < 2) return; // {n} people, item{s}: a unit or a plural
      into(node, `${k} (tail)`, raw, via);
    };
    const visit = (node: ts.Node): void => {
      const children: ts.NodeArray<ts.JsxChild> | undefined = ts.isJsxElement(node) ? node.children : ts.isJsxFragment(node) ? node.children : undefined;
      if (!children) return;
      for (const [i, c] of children.entries()) {
        const sink = computed ? quiet : into;
        if (ts.isJsxText(c)) {
          // The words before a computed child are cut short by it ("Billed by Hand on {inv}"): a (head) hit, whose last
          // word may be mid-title and so, when a function word, lowercase.
          const head = children.slice(i + 1).some((d) => ts.isJsxExpression(d) && !stringsOf(d.expression, kind, () => {}));
          sink(c, head ? `${kind} (head)` : kind, c.text);
        } else if (ts.isJsxExpression(c)) {
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
 * The first word of the text that breaks the rule — or null when every word keeps it (tests/title-case-words
 * titleCaseOffender, the one rule). A proper name keeps its owner's spelling. `tail`: the text starts mid-value (after a
 * {slot} or a computed child) and its first word, when a function word, may be either case. `head`: the text is cut short
 * by a slot or a computed child, and its last word, when a function word, is mid-title ("Billed by Hand on {inv}").
 */
export function titleCaseOffence(text: string, lang: "en" | "es" = "en", tail = false, head = false): string | null {
  let plain = text;
  for (const name of PROPER_NAMES) plain = plain.split(name).join(" ");
  return titleCaseOffender(plain, lang, { openStart: tail, openEnd: head });
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
  // The same two stand-ins in Spanish (qe_itsRevision, qe_anEarlierEstimate, cn-v1145).
  { text: "su revisión", file: "src/app/(app)/quotes/estimate-editor.tsx", why: "a noun inside a sentence, standing in for the estimate's number" },
  { text: "un presupuesto anterior", file: "src/app/(app)/quotes/estimate-editor.tsx", why: "a noun inside a sentence, standing in for the estimate's number" },
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
  // The kit picker's title names the kit after the colon ("Add from kit: Panel Swap"); a modal's heading, not a door,
  // and its English is what it always said (qt_addFromKit, cn-v1145 — the scanner reads the key now, not the template).
  { text: "Add from kit:", file: "src/app/(app)/quotes/new/kit-picker-modal.tsx", why: "a modal heading that names the kit after the colon, not a door" },
  { text: "Agregar del kit:", file: "src/app/(app)/quotes/new/kit-picker-modal.tsx", why: "a modal heading that names the kit after the colon, not a door" },
  // The job's own label carries the possessive ("Open J-012 Snowbell's Panel"): the 's belongs to the name before it.
  { text: "'s Panel", file: "src/app/(app)/quotes/[id]/circuit-schedule-card.tsx", why: "the possessive of the job's label, which is computed before it" },
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
      ["<Link> (head)", "Edit"],
      ["<Button>", "Save changes"],
      ["<Button> (head)", "Log"],
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

  it("a t(\"key\") door is judged in both languages (cn-v1138): each language its own hit, a {slot} a computed hole, an unknown key skipped", () => {
    const src = `
      const A = () => (
        <>
          <Button>{t("tc_clockIn")}</Button>
          <Button>{busy ? t("tc_clockingOut") : t("tc_clockOutAtThatTime")}</Button>
          <button>{fillText(t("tc_putOnPrev"), { job })}</button>
          <Button>{fillText(t("tc_nowChip"), { hours })}</Button>
          <Button>{t("no_such_key")} Save changes</Button>
          <Button>{t(key)}</Button>
          <ModalActions saveLabel={t("tc_clockOut")} />
        </>
      );`;
    expect(collectClickables(src, "a.tsx").map((h) => [h.kind, h.text, h.via])).toEqual([
      ["<Button>", "Clock In", "en:tc_clockIn"],
      ["<Button>", "Marcar Entrada", "es:tc_clockIn"],
      ["<Button>", "Clocking Out…", "en:tc_clockingOut"],
      ["<Button>", "Marcando Salida…", "es:tc_clockingOut"],
      ["<Button>", "Clock Out at That Time", "en:tc_clockOutAtThatTime"],
      ["<Button>", "Marcar Salida a Esa Hora", "es:tc_clockOutAtThatTime"],
      // "Put It on {job} Instead": the words before the slot, a (head) whose last word is mid-title; "Instead" alone is a one-word tail.
      ["<button> (head)", "Put It on", "en:tc_putOnPrev"],
      ["<button> (head)", "Ponerlo en", "es:tc_putOnPrev"],
      // "Now ({hours} h)": "Now (" before the slot; " h)" is a figure's unit.
      ["<Button> (head)", "Now (", "en:tc_nowChip"],
      ["<Button> (head)", "Ahora (", "es:tc_nowChip"],
      // An unknown key is computed, so the two-word tail after it is still judged.
      ["<Button> (tail)", "Save changes", undefined],
      ["ModalActions saveLabel", "Clock Out", "en:tc_clockOut"],
      ["ModalActions saveLabel", "Marcar Salida", "es:tc_clockOut"],
    ]);
    expect(titleCaseOffence("Marcar Entrada")).toBeNull();
    expect(titleCaseOffence("Marcar entrada")).toBe("entrada");
    // Unicode-aware: a capital with an accent is a capital.
    expect(titleCaseOffence("Él Mismo")).toBeNull();
    expect(titleCaseOffence("Él mismo")).toBe("mismo");
  });

  it("the rule: the significant words capital, a function word lowercase in the middle of a segment; a quoted bit passes; the word after · & ( / counts", () => {
    for (const ok of ["Save Changes", "Won · Pick the Job", "Verify & Sign In", "Add 3 More", "Bills & POs", "Saved — Open It", "Say “yes please” Now", "Yes/No", "+ New", "E-sign It", "Don't Stop", "(Optional) Field", "Import a .vcf", "Enable Tap to Pay on iPhone", "Get This iPhone Ready", "Back to Schedule", "Who's on the Clock", "Sign In with a Code", "Turn It On from Their Contact Page", "Swap Money In and Out", "Set Up Card Payments", "Phase A Loads", "No Job: A Reminder for Me", "Still on the Clock?", "SCOPE OF WORK", "Announce Tap to Pay on iPhone to the Crew"])
      expect(titleCaseOffence(ok), ok).toBeNull();
    expect(titleCaseOffence("Save changes")).toBe("changes");
    expect(titleCaseOffence("Won · pick the job")).toBe("pick");
    expect(titleCaseOffence("Verify & sign In")).toBe("sign");
    expect(titleCaseOffence("Open (your lien rights)")).toBe("(your");
    expect(titleCaseOffence("Yes/no")).toBe("no");
    expect(titleCaseOffence("iMessage Setup")).toBe("iMessage");
    // English (cn-v1148): a capital function word in the middle of a segment is the offence; the first and last word stay capital.
    expect(titleCaseOffence("Back To Schedule")).toBe("To");
    expect(titleCaseOffence("Won · Pick The Job")).toBe("The");
    expect(titleCaseOffence("Announce Tap to Pay on iPhone To The Crew")).toBe("To");
    expect(titleCaseOffence("Sign in with a Code")).toBe("in");
    expect(titleCaseOffence("Who's on the clock")).toBe("clock");
    expect(titleCaseOffence("Owed to")).toBe("to");
    // A (head) hit ends where a slot or a computed child begins, so its last word may be a lowercase function word.
    expect(titleCaseOffence("Billed by Hand on", "en", false, true)).toBeNull();
    expect(titleCaseOffence("Billed by Hand on")).toBe("on");
  });

  it("Spanish is judged by its own rule (cn-v1147): the significant words, a function word lowercase after the first", () => {
    expect(titleCaseOffence("Price List", "en")).toBeNull();
    expect(titleCaseOffence("Add to the Schedule", "en")).toBeNull();
    expect(titleCaseOffence("Add To The Schedule", "en")).toBe("To");
    expect(titleCaseOffence("Add to The Schedule", "en")).toBe("The");
    expect(titleCaseOffence("Lista de Precios", "es")).toBeNull();
    expect(titleCaseOffence("Lista De Precios", "es")).toBe("De");
    expect(titleCaseOffence("Lista de precios", "es")).toBe("precios");
    expect(titleCaseOffence("El Día de Todos", "es")).toBeNull();
    expect(titleCaseOffence("el Día de Todos", "es")).toBe("el");
    expect(titleCaseOffence("Ganada · Elegir el Trabajo", "es")).toBeNull();
    expect(titleCaseOffence("Fijar Arriba (Se Queda hasta que lo Desfijes)", "es")).toBeNull();
    expect(titleCaseOffence("Configurar Face ID / Llave de Acceso", "es")).toBeNull();
    // A tail (after a {slot}, or a t() value after a computed child) may start mid-value or start the value: its first
    // word, when a function word, may be either case; the rest is still judged.
    expect(titleCaseOffence("en Su Lugar", "es", true)).toBeNull();
    expect(titleCaseOffence("En Pausa", "es", true)).toBeNull();
    expect(titleCaseOffence("en Su Lugar", "es")).toBe("en");
    expect(titleCaseOffence("en Su Lugar De Hoy", "es", true)).toBe("De");
    // The hits a t() door gives carry their language, and the scan judges each by its own.
    const hits = collectClickables(`const A = () => <Button>{t("sh_dock_m-price")}</Button>;`, "a.tsx");
    expect(hits.map((h) => [h.text, h.via])).toEqual([["Price List", "en:sh_dock_m-price"], ["Lista de Precios", "es:sh_dock_m-price"]]);
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
      .map((h) => ({ ...h, word: titleCaseOffence(h.text, h.via?.startsWith("es:") ? "es" : "en", h.kind.includes("(tail)"), h.kind.includes("(head)")) }))
      .filter((h) => h.word)
      .map((h) => `${h.file}${h.via ? ` [${h.via}]` : ""}:${h.line} ${h.kind} "${h.text}" — "${h.word}"`);
    expect(offenders).toEqual([]);
  }, 60_000);
});
