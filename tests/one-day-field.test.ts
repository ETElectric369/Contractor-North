import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ONE DAY FIELD (cn-v1153).
 *
 * Erik, 2026-11-07: "sometimes on my phone the calendar that pops up is the iphone native calendar
 * which is better then using our own but then sometimes the app calendar pops up on others, maybe we
 * should look into continuity of systems and single source of truth." So every day box in the app is
 * src/components/day-field.tsx, and only it may draw an `<input type="date">` (through the house
 * `<Input>` or raw). A screen that draws its own fails here, by file and line, so the next date box
 * someone adds goes through the one door.
 *
 * The two `type="datetime-local"` boxes in work-orders are a different thing (a day AND a time) and
 * are allowed by name; a third one anywhere else fails too, so that exception stays two.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(ROOT, "src");

/** The one file that may draw a date input. */
const THE_ONE = "src/components/day-field.tsx";

/** The day-and-time boxes, allowed by name. */
const DATETIME_ALLOWED = new Set([
  "src/app/(app)/work-orders/new-wo-button.tsx",
  "src/app/(app)/work-orders/[id]/wo-edit-button.tsx",
]);

function screens(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) screens(p, out);
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

/** The end of a JSX tag that starts at `from` (just past `<name`): the first `>` outside braces and
 *  quotes, so an `onChange={(e) => …}` before the type attribute does not end the tag early. */
function tagEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (depth === 0 && (c === '"' || c === "'")) {
      const close = src.indexOf(c, i + 1);
      if (close === -1) return src.length;
      i = close;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0) return i;
  }
  return src.length;
}

/** Every `<name …>` tag's text and 1-based line, for a tag name taken whole (`<input` is not `<inputs`). */
export function tagsNamed(src: string, name: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const open = `<${name}`;
  let at = src.indexOf(open);
  while (at !== -1) {
    const next = src[at + open.length];
    if (next === undefined || /[\s/>]/.test(next)) {
      const end = tagEnd(src, at + open.length);
      out.push({ text: src.slice(at, end + 1), line: src.slice(0, at).split("\n").length });
    }
    at = src.indexOf(open, at + open.length);
  }
  return out;
}

const DATE = /\btype\s*=\s*(?:"date"|'date'|\{\s*["']date["']\s*\})/;
const DATETIME = /\btype\s*=\s*(?:"datetime-local"|'datetime-local'|\{\s*["']datetime-local["']\s*\})/;

/** The lines in `src` that draw an input of the given type, through `<input` or the house `<Input`. */
export function inputsOfType(src: string, type: RegExp): number[] {
  return [...tagsNamed(src, "input"), ...tagsNamed(src, "Input")]
    .filter((t) => type.test(t.text))
    .map((t) => t.line)
    .sort((a, b) => a - b);
}

describe("the scanner can see a date input", () => {
  it("finds a raw one, the house Input, a multi-line one, and one whose onChange arrow comes before its type", () => {
    expect(inputsOfType('<input type="date" />', DATE)).toEqual([1]);
    expect(inputsOfType('<Input id="d" type="date" value={v} onChange={(e) => set(e.target.value)} />', DATE)).toEqual([1]);
    expect(inputsOfType('<div>\n  <input\n    type="date"\n    value={date}\n  />\n</div>', DATE)).toEqual([2]);
    expect(inputsOfType('<input value={x} onChange={(e) => f(e)} type="date" />', DATE)).toEqual([1]);
    expect(inputsOfType("<input type={'date'} />", DATE)).toEqual([1]);
  });

  it("leaves text boxes, the DayField, datetime-local and look-alike names alone", () => {
    expect(inputsOfType('<input type="text" />', DATE)).toEqual([]);
    expect(inputsOfType('<DayField value={d} onChange={set} />', DATE)).toEqual([]);
    expect(inputsOfType('<input type="datetime-local" />', DATE)).toEqual([]);
    expect(inputsOfType('<InputRow type="date" />', DATE)).toEqual([]);
    expect(inputsOfType('<input type="datetime-local" />', DATETIME)).toEqual([1]);
    expect(inputsOfType('<input type="date" />', DATETIME)).toEqual([]);
  });
});

describe("one day field", () => {
  const files = screens(SRC);
  const rel = (p: string) => path.relative(ROOT, p);

  it("the one file exists and draws the date input", () => {
    const src = readFileSync(path.join(ROOT, THE_ONE), "utf8");
    expect(inputsOfType(src, DATE)).not.toEqual([]);
    expect(src).toContain("export const DayField");
  });

  it("no other screen draws its own <input type=\"date\">: every day box is the DayField", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (rel(f) === THE_ONE) continue;
      const lines = inputsOfType(readFileSync(f, "utf8"), DATE);
      for (const line of lines) offenders.push(`${rel(f)}:${line}`);
    }
    const byFile = new Set(offenders.map((o) => o.replace(/:\d+$/, "")));
    expect(
      offenders,
      `${offenders.length} date input(s) in ${byFile.size} file(s) outside ${THE_ONE} — render <DayField> from @/components/day-field instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the day-and-time boxes are the two in work-orders, by name", () => {
    const where: string[] = [];
    for (const f of files) {
      const lines = inputsOfType(readFileSync(f, "utf8"), DATETIME);
      for (const line of lines) where.push(`${rel(f)}:${line}`);
    }
    const strangers = where.filter((w) => !DATETIME_ALLOWED.has(w.replace(/:\d+$/, "")));
    expect(strangers, `datetime-local outside the two allowed work-orders files:\n  ${strangers.join("\n  ")}`).toEqual([]);
    expect(new Set(where.map((w) => w.replace(/:\d+$/, "")))).toEqual(DATETIME_ALLOWED);
  });
});
