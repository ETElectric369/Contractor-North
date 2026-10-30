import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { CATALOGS } from "@/lib/i18n";

/**
 * NO ENGLISH LEAKS ONTO A TECH'S SCREEN (cn-v1138). A screen a catalog names (lib/words/*.files) is
 * a screen a Spanish-speaking tech reads, so every word on it comes through t() / translator() /
 * fillText() and the catalog — never a literal in the source. This reads each named screen with
 * the compiler (the way tests/title-case.test.ts reads every clickable) and refuses:
 *
 *   · a JSX text of two or more words, or of ONE word of three or more letters ("Since", "Crew" —
 *     a heading is one word as often as two);
 *   · a string literal in a title=, placeholder=, aria-label= or label= attribute;
 *   · the arms of a {cond ? "A b" : "C d"} child when they are literals of two or more words;
 *   · the first argument of toast(…) when it is a literal, and of setError(…), setSaid(…) or
 *     setStatus(…) when it is a literal of two or more words (a status line is a tech's words);
 *   · a string literal under an object property named title, body, error, message or label, of
 *     two or more words;
 *   · a call to jobStatusLabel(…) or appointmentTypeLabel(…) with no language argument (the badge
 *     reads the catalog only when handed one);
 *   · an import of an all-caps *_LINE or *_FAILED constant from src/lib (an English sentence under
 *     an identifier the literal scan cannot see).
 *
 * It ignores a string with no letters, a template whose text is only punctuation, className,
 * imports, console calls, and the arguments of reportError / reportClientError (the sink is
 * English, by design). A deliberate English literal on a named screen goes in ALLOW with its why.
 *
 * Every catalog names its screens now (cn-v1138's fixers), so the scan reads them all: the floor
 * is the real count and rises as screens move over.
 */
const ROOT = process.cwd();

/** The screens the catalogs name at cn-v1139 (93 when the floor was set: the nav catalog's three; 90 at cn-v1138); raise it as screens move over. */
export const FILES_FLOOR = 93;

/** English that stands on a named screen on purpose: the exact words, the file, and why. */
const ALLOW: { file: string; text: string; why: string }[] = [
  // T2 (cn-v1138): the office's bell line is a RECORD, not a sentence — markDailyReportReviewed finds it
  // with .eq("title", `Daily report from ${name}`) and nort/updates reads it back with /^Daily report from/.
  { file: "src/app/(app)/timeclock/actions.ts", text: "Daily report from", why: "a stored title two readers match by its English words" },
  // T2: the document title of the PWA's offline fallback is the vendor's name on a page with no session.
  { file: "src/app/offline/page.tsx", text: "Offline · Contractor North", why: "the browser-tab title carries the vendor's name; the page's words are OfflineWords" },
];

export type Leak = { line: number; kind: string; text: string };

const WORD_ATTRS = new Set(["title", "placeholder", "aria-label", "label"]);
/** State setters whose first argument is a line a tech reads. */
const LINE_SETTERS = /^(setError|setSaid|setStatus)$/;
/** The two badge helpers that read the catalog only when handed a language. */
const LANG_LABELS = /^(jobStatusLabel|appointmentTypeLabel)$/;
/** An all-caps sentence constant: TRY_AGAIN_LINE, TAKES_READ_FAILED. */
const SENTENCE_CONST = /^[A-Z0-9_]+_(LINE|FAILED)$/;
const WORD_PROPS = new Set(["title", "body", "error", "message", "label"]);
/** Calls whose string arguments are never a tech's words: the translator's own, the sink's, the console's. */
const QUIET_CALLEE = /^(t|translator|fillText|reportError|reportClientError|reportErrorAwaited|console\.\w+)$/;

const letterWords = (s: string) => s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
const plain = (s: string) => s.replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

/**
 * The English a named screen shows that did not come through the catalog. Pure: text in, leaks out.
 */
export function collectLeaks(source: string, fileName: string): Leak[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const leaks: Leak[] = [];
  const add = (node: ts.Node, kind: string, raw: string) => {
    const text = plain(raw);
    if (!text || !/\p{L}/u.test(text)) return;
    leaks.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind, text });
  };
  /** Inside a call the translator, the sink or the console owns, or an import: not a tech's words. */
  const quiet = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isImportTypeNode(p)) return true;
      if (ts.isCallExpression(p) && QUIET_CALLEE.test(p.expression.getText(sf))) return true;
    }
    return false;
  };
  const literalText = (e: ts.Expression): string | null => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) {
      const text = [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(" ");
      return /\p{L}/u.test(text) ? text : null;
    }
    return null;
  };

  /** The string-literal arms of a conditional, however nested: {a ? "x" : b ? "y" : "z"}. */
  const arms = (e: ts.Expression): ts.Expression[] => {
    if (ts.isParenthesizedExpression(e)) return arms(e.expression);
    if (ts.isConditionalExpression(e)) return [...arms(e.whenTrue), ...arms(e.whenFalse)];
    return literalText(e) !== null ? [e] : [];
  };

  const walk = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const text = plain(n.text);
      if (letterWords(text) >= 2) add(n, "JSX text", n.text);
      else if (/^\p{L}{3,}$/u.test(text)) add(n, "JSX word", n.text);
    } else if (ts.isJsxExpression(n) && n.expression && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      // A child, not an attribute: {busy ? "Saving changes" : "Save changes"}, parenthesised or not.
      let inner: ts.Expression = n.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (ts.isConditionalExpression(inner) && !quiet(n)) {
        for (const arm of arms(inner)) {
          const text = literalText(arm);
          if (text !== null && letterWords(plain(text)) >= 2) add(arm, "{cond ? … : …}", text);
        }
      }
    } else if (ts.isImportDeclaration(n)) {
      const from = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : "";
      const named = n.importClause?.namedBindings;
      if (from.startsWith("@/lib/") && named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const name = (el.propertyName ?? el.name).text;
          if (SENTENCE_CONST.test(name)) add(el, "English constant import", name);
        }
      }
    } else if (ts.isCallExpression(n) && LANG_LABELS.test(n.expression.getText(sf))) {
      if (n.arguments.length < 2) add(n, "label without lang", `${n.expression.getText(sf)}(…)`);
    } else if (ts.isCallExpression(n) && LINE_SETTERS.test(n.expression.getText(sf)) && n.arguments.length) {
      const text = literalText(n.arguments[0]);
      if (text !== null && letterWords(plain(text)) >= 2 && !quiet(n)) add(n.arguments[0], `${n.expression.getText(sf)}(…)`, text);
    } else if (ts.isJsxAttribute(n)) {
      const name = n.name.getText(sf);
      if (WORD_ATTRS.has(name) && n.initializer) {
        const e = ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer;
        const text = e ? literalText(e) : null;
        if (text !== null && !quiet(n)) add(n, `${name}=`, text);
      }
    } else if (ts.isCallExpression(n) && n.expression.getText(sf) === "toast" && n.arguments.length) {
      const text = literalText(n.arguments[0]);
      if (text !== null && !quiet(n)) add(n.arguments[0], "toast(…)", text);
    } else if (ts.isPropertyAssignment(n)) {
      const name = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : n.name.getText(sf);
      if (WORD_PROPS.has(name)) {
        const text = literalText(n.initializer);
        if (text !== null && letterWords(plain(text)) >= 2 && !quiet(n)) add(n.initializer, `${name}:`, text);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return leaks;
}

const allowed = (file: string, text: string) => ALLOW.some((a) => a.text === text && file.endsWith(a.file));

describe("the scanner reads the shapes English leaks in", () => {
  it("a JSX text of two or more words leaks, and so does one word of three or more letters; a unit, punctuation, an entity, or a t() child does not", () => {
    const src = `
      const A = () => (
        <div>
          <p>You're not clocked in.</p>
          <p>{t("tc_notClockedIn")}</p>
          <span>Since</span>
          <span>ft</span>
          <span>OK</span>
          <span>{n} h</span>
          <span> — </span>
          <span>&nbsp;</span>
          <button>{busy ? t("tc_clockingIn") : t("tc_clockIn")}</button>
        </div>
      );`;
    expect(collectLeaks(src, "a.tsx").map((l) => [l.line, l.kind, l.text])).toEqual([
      [4, "JSX text", "You're not clocked in."],
      [6, "JSX word", "Since"],
    ]);
  });

  it("the literal arms of a {cond ? … : …} child leak, however nested; a t() arm, a one-word arm and an attribute's conditional do not", () => {
    const src = `
      const A = () => (
        <div>
          <button>{busy ? "Saving changes" : t("tc_save")}</button>
          <p>{a ? "Nothing here" : b ? "Jobs" : "Pick a job"}</p>
          <p>{(busy ? "Saving now" : "Done")}</p>
          <input title={busy ? "Saving changes" : "Save"} />
        </div>
      );`;
    expect(collectLeaks(src, "a.tsx").map((l) => [l.kind, l.text])).toEqual([
      ["{cond ? … : …}", "Saving changes"],
      ["{cond ? … : …}", "Nothing here"],
      ["{cond ? … : …}", "Pick a job"],
      ["{cond ? … : …}", "Saving now"],
    ]);
  });

  it("setError, setSaid and setStatus leak a literal first argument of two or more words; a t() line, one word, or another setter does not", () => {
    const src = `
      function go() {
        setError("Could not save.");
        setSaid(\`Switched to \${job} just now\`);
        setStatus(speech.speechSupported() ? "Tap Talk To Nort to try again" : t("nt_noVoiceLine"));
        setStatus(t("nt_tryAgainLine"));
        setError("Saved");
        setOpen("two words");
      }`;
    expect(collectLeaks(src, "a.tsx").map((l) => [l.kind, l.text])).toEqual([
      ["setError(…)", "Could not save."],
      ["setSaid(…)", "Switched to just now"],
    ]);
  });

  it("jobStatusLabel and appointmentTypeLabel leak when called without a language; with one they pass", () => {
    const src = `
      const A = () => (
        <>
          <Badge>{jobStatusLabel(job.status)}</Badge>
          <Badge>{appointmentTypeLabel(a.type)}</Badge>
          <Badge>{jobStatusLabel(job.status, lang)}</Badge>
          <Badge>{appointmentTypeLabel(a.type, lang)}</Badge>
        </>
      );`;
    expect(collectLeaks(src, "a.tsx").map((l) => [l.kind, l.text])).toEqual([
      ["label without lang", "jobStatusLabel(…)"],
      ["label without lang", "appointmentTypeLabel(…)"],
    ]);
  });

  it("an all-caps *_LINE or *_FAILED constant imported from src/lib leaks; a builder, a type or a local module does not", () => {
    const src = `
      import { NO_VOICE_LINE, TRY_AGAIN_LINE, tryAgainLine } from "@/lib/voice-failure";
      import { TAKES_READ_FAILED as READ_FAILED, takeLine, type JobTake } from "@/lib/stock-take";
      import { MAX_SHIFT_HOURS } from "@/lib/long-shift";
      import { SOME_LINE } from "./words";`;
    expect(collectLeaks(src, "a.tsx").map((l) => [l.kind, l.text])).toEqual([
      ["English constant import", "NO_VOICE_LINE"],
      ["English constant import", "TRY_AGAIN_LINE"],
      ["English constant import", "TAKES_READ_FAILED"],
    ]);
  });

  it("a literal title=, placeholder=, aria-label= or label= leaks; className and a t() value do not", () => {
    const src = `
      const A = () => (
        <>
          <input placeholder="Summarize the work performed…" className="text-sm border" />
          <input placeholder={t("tc_summarize")} />
          <button aria-label="Toggle password" title={\`Edit \${name}\`} />
          <Field label="Assigned to" />
          <Modal title={t("tc_title")} />
        </>
      );`;
    expect(collectLeaks(src, "a.tsx").map((l) => [l.kind, l.text])).toEqual([
      ["placeholder=", "Summarize the work performed…"],
      ["aria-label=", "Toggle password"],
      ["title=", "Edit"],
      ["label=", "Assigned to"],
    ]);
  });

  it("toast's first argument leaks when it is a literal, not when it is translated", () => {
    const src = `
      function go() {
        toast("Saved. Reload to see it.");
        toast(t("tc_saved"));
        toast(\`Switched to \${job}.\`);
        toast(\`\${n}\`);
      }`;
    expect(collectLeaks(src, "a.tsx").map((l) => [l.kind, l.text])).toEqual([
      ["toast(…)", "Saved. Reload to see it."],
      ["toast(…)", "Switched to ."],
    ]);
  });

  it("a title / body / error / message / label property of two or more words leaks; one word, the sink's words and the console's do not", () => {
    const src = `
      const words = { title: "Clock out when you leave.", body: t("nb_body"), label: "Jobs", error: "Could not save." };
      reportError("timeclock:punch", e, { message: "the punch did not land", title: "Two words" });
      void reportClientError("shell-navigation", "Download: the share sheet refused the file", { error: "two words" });
      console.error("two words here");
      import("x");`;
    expect(collectLeaks(src, "a.ts").map((l) => [l.kind, l.text])).toEqual([
      ["title:", "Clock out when you leave."],
      ["error:", "Could not save."],
    ]);
  });

  it("an allowed text passes by its file; the same words elsewhere do not", () => {
    const allow = [{ file: "src/app/(app)/timeclock/x.tsx", text: "Pick The Job", why: "a test" }];
    const ok = (file: string, text: string) => allow.some((a) => a.text === text && file.endsWith(a.file));
    const src = `const A = () => <button>Pick The Job</button>;`;
    const leaks = collectLeaks(src, "src/app/(app)/timeclock/x.tsx");
    expect(leaks.map((l) => l.text)).toEqual(["Pick The Job"]);
    expect(leaks.filter((l) => !ok("src/app/(app)/timeclock/x.tsx", l.text))).toEqual([]);
    expect(leaks.filter((l) => !ok("src/app/(app)/jobs/x.tsx", l.text))).toHaveLength(1);
  });
});

describe("every named screen's words come through the catalog", () => {
  const files = Array.from(new Set(CATALOGS.flatMap((c) => c.files)));
  const leaks = files.flatMap((f) => collectLeaks(readFileSync(join(ROOT, f), "utf8"), f).map((l) => ({ ...l, file: f })));

  it("the catalogs loaded and the scan read every screen they name", () => {
    expect(CATALOGS.length).toBe(12);
    expect(files.length).toBeGreaterThanOrEqual(FILES_FLOOR);
  });

  it("every allowlisted line is still on its screen (a stale entry is a hole)", () => {
    for (const a of ALLOW) expect(leaks.some((l) => l.text === a.text && l.file.endsWith(a.file)), `${a.file} "${a.text}"`).toBe(true);
  });

  it("names every English literal a named screen still shows", () => {
    const strays = leaks.filter((l) => !allowed(l.file, l.text)).map((l) => `${l.file}:${l.line} ${l.kind} "${l.text}"`);
    expect(strays, "These words are on a screen a Spanish-speaking tech reads and are not in its catalog. Move each into lib/words and read it through t().").toEqual([]);
  }, 60_000);
});
