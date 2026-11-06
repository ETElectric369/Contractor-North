import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { Input } from "@/components/ui/input";

/**
 * NO FIELD IS A LOGIN BY ACCIDENT (2026-11-04: clicking My Day's "Add a Reminder or Task…" box made
 * macOS Safari open its Passwords panel). Safari guesses "username" for a text field that declares
 * nothing (no type, name, id or autocomplete) — the lone box in a form-less group is the classic
 * case — and a field named/id'd like a login (email, name, user…) is guessed at the same way.
 *
 * THE CURE: the shared <Input> defaults to autocomplete="off" (plus the 1Password / LastPass ignore
 * marks) before its props, so a field that declares its own token wins. This check keeps it so:
 *
 *   1. a raw <input> that is a typing field (no type, or text/email/tel/search/number/url/password,
 *      or a computed type) declares autoComplete — it bypasses <Input>'s default;
 *   2. an input-like element (<input>, <Input>, <PasswordInput>, <PhoneInput>) whose name or id
 *      reads like a login (user, username, email, login, account, password, pw, name) declares an
 *      explicit token — "email"/"name"/"organization" when it honestly is one, "off" otherwise,
 *      "new-password" on a teammate's password;
 *      (the four sign-in doors below are left exactly as they are and are not judged by this rule);
 *   3. only the four sign-in doors (login, reset, set-password, the portal's sign-in) may say
 *      "username" or "current-password";
 *   4. on those four doors a password field (<PasswordInput>, or type="password") declares
 *      "new-password" or "current-password" — never the <Input> default "off", which hides it from
 *      every password manager (2026-11-05: the reset door's new password could not be offered or saved).
 *
 * A raw <input> carrying a {...spread} is skipped (its token may ride the spread). The scan counts
 * what it read and fails if that is implausibly small, so it cannot pass by scanning nothing.
 */

const ROOT = process.cwd();

const SIGN_IN_FILES = [
  "src/app/login/page.tsx",
  "src/app/reset/page.tsx",
  "src/app/set-password/set-password-form.tsx",
  "src/components/portal/portal-sign-in.tsx",
];
const INPUT_TAGS = new Set(["input", "Input", "PasswordInput", "PhoneInput"]);
const NOT_TYPING = new Set(["checkbox", "radio", "file", "hidden", "range", "color", "submit", "button", "reset", "image", "date", "time", "datetime-local", "month", "week"]);
const LOGIN_WORDS = new Set(["user", "username", "email", "login", "account", "password", "pw", "name"]);
const LOGIN_TOKENS = new Set(["username", "current-password"]);
const PASSWORD_TOKENS = new Set(["new-password", "current-password"]);

export type Field = { line: number; tag: string; problem: string };

const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
export const loginLike = (s: string) => words(s).some((w) => LOGIN_WORDS.has(w));

function stringsIn(n: ts.Node): string[] {
  const out: string[] = [];
  const visit = (x: ts.Node) => {
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) out.push(x.text);
    ts.forEachChild(x, visit);
  };
  visit(n);
  return out;
}

/** Reads one file and returns every field that breaks a rule, plus how many input-like elements it read. */
export function checkFields(src: string, file: string): { read: number; problems: Field[] } {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: Field[] = [];
  let read = 0;
  const signIn = SIGN_IN_FILES.some((f) => file.endsWith(f));

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const attrs = new Map<string, ts.JsxAttribute>();
      let spread = false;
      for (const p of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(p)) spread = true;
        else attrs.set(p.name.getText(sf), p);
      }
      const literal = (name: string): string | null | undefined => {
        const a = attrs.get(name);
        if (!a) return undefined;
        if (!a.initializer) return "";
        if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
        if (ts.isJsxExpression(a.initializer) && a.initializer.expression && ts.isStringLiteral(a.initializer.expression)) return a.initializer.expression.text;
        return null; // computed
      };
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const ac = attrs.get("autoComplete");

      // Rule 3 applies to any element: the login tokens belong to the sign-in doors only.
      if (ac?.initializer && !signIn) {
        const bad = stringsIn(ac.initializer).filter((s) => LOGIN_TOKENS.has(s));
        if (bad.length) problems.push({ line, tag, problem: `says autoComplete="${bad[0]}" outside the sign-in doors` });
      }

      if (INPUT_TAGS.has(tag)) {
        read++;
        const type = literal("type");
        // Rule 4: a sign-in door's password field says which password it is.
        if (signIn && (tag === "PasswordInput" || type === "password")) {
          const said = ac?.initializer ? stringsIn(ac.initializer) : [];
          if (!said.length || !said.every((s) => PASSWORD_TOKENS.has(s))) {
            problems.push({ line, tag, problem: `a sign-in door's password field must say autoComplete="new-password" or "current-password"` });
          }
        }
        if (tag === "input" && !spread && !ac && (type === undefined || type === null || !NOT_TYPING.has(type))) {
          problems.push({ line, tag, problem: `raw typing field (type=${type === undefined ? "none" : type ?? "computed"}) with no autoComplete` });
        } else if (!ac && !signIn && !(tag === "input" && type && NOT_TYPING.has(type))) {
          for (const key of ["name", "id"]) {
            const v = literal(key);
            if (v && loginLike(v)) {
              problems.push({ line, tag, problem: `${key}="${v}" reads like a login and declares no autoComplete` });
              break;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { read, problems };
}

function screenFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...screenFiles(p));
    else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

describe("the checker reads the shapes a field takes", () => {
  it("flags a bare raw input, a login-like name, and a stray login token; passes declared ones", () => {
    const src = `
      const A = () => (
        <>
          <input value={v} />
          <input type="checkbox" name="email" />
          <input type="text" autoComplete="off" />
          <Input name="email" type="email" />
          <Input id="customer-name" autoComplete="name" />
          <Input id="title" />
          <PasswordInput autoComplete="current-password" />
          <input {...props} />
        </>
      );`;
    const { read, problems } = checkFields(src, "src/app/x.tsx");
    expect(read).toBe(8);
    expect(problems.map((p) => p.line)).toEqual([4, 7, 10]);
  });

  it("lets the sign-in doors say username / current-password", () => {
    const src = `const A = () => <PasswordInput autoComplete={signup ? "new-password" : "current-password"} />;`;
    expect(checkFields(src, "src/app/login/page.tsx").problems).toEqual([]);
    expect(checkFields(src, "src/app/x.tsx").problems).toHaveLength(1);
  });

  it("a sign-in door's password field must say new-password or current-password", () => {
    const door = "src/app/reset/page.tsx";
    expect(checkFields(`const A = () => <PasswordInput id="password" name="password" />;`, door).problems).toHaveLength(1);
    expect(checkFields(`const A = () => <PasswordInput autoComplete="off" />;`, door).problems).toHaveLength(1);
    expect(checkFields(`const A = () => <Input type="password" />;`, door).problems).toHaveLength(1);
    expect(checkFields(`const A = () => <PasswordInput autoComplete="new-password" />;`, door).problems).toEqual([]);
    expect(checkFields(`const A = () => <Input type="password" autoComplete="current-password" />;`, door).problems).toEqual([]);
  });

  it("reads login-like words through snake, kebab and camel case", () => {
    expect(loginLike("company_name")).toBe(true);
    expect(loginLike("m-email")).toBe(true);
    expect(loginLike("userId")).toBe(true);
    expect(loginLike("rename")).toBe(false);
    expect(loginLike("r-phone")).toBe(false);
  });
});

describe("the shared Input defaults to no AutoFill", () => {
  it("renders autocomplete off and the password-manager ignore marks", () => {
    // React writes the prop's camelCase name; HTML attribute names are case-insensitive.
    const html = renderToStaticMarkup(createElement(Input)).toLowerCase();
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('data-lpignore="true"');
    expect(html).toContain('data-1p-ignore=""');
  });

  it("a field that declares its own token keeps it", () => {
    const html = renderToStaticMarkup(createElement(Input, { autoComplete: "email" })).toLowerCase();
    expect(html).toContain('autocomplete="email"');
    expect(html).not.toContain('autocomplete="off"');
  });
});

describe("every field in the app declares what it is", () => {
  const files = screenFiles(join(ROOT, "src")).map((f) => relative(ROOT, f));
  const results = files.map((f) => ({ file: f, ...checkFields(readFileSync(join(ROOT, f), "utf8"), f) }));

  it("scans the app", () => {
    expect(files.length).toBeGreaterThan(300);
    const read = results.reduce((n, r) => n + r.read, 0);
    expect(read).toBeGreaterThan(400);
  });

  it("names every field Safari could take for a login", () => {
    const offenders = results.flatMap((r) => r.problems.map((p) => `${r.file}:${p.line} <${p.tag}> ${p.problem}`));
    expect(offenders).toEqual([]);
  }, 60_000);
});
