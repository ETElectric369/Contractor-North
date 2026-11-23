import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE APP HAS ONE THEME (cn-v1187; the owner, of the door that files a credit with its bills:
 * "i can barely see whats in that box im supposed to click").
 *
 * Nothing in the app's own styles answers a device set to dark: every card stays white. Tailwind's
 * `dark:` variant follows the DEVICE, so a class like `dark:text-slate-100` painted near-white words
 * on a white card for anyone whose computer or phone was in dark mode. Two components carried such
 * classes; the box that names which bills a credit will be filed with was one of them. Until the app
 * has a dark theme of its own, no screen may carry a `dark:` class.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("the app has one theme", () => {
  it("no screen carries a dark: class (it follows the device, and every card stays white)", () => {
    const bad: string[] = [];
    for (const file of walk(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/(^|[\s"'`])dark:[a-z\[]/.test(line)) bad.push(`${path.relative(root, file)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("the scan sees the shape it is for", () => {
    expect(/(^|[\s"'`])dark:[a-z\[]/.test('className="text-slate-900 dark:text-slate-100"')).toBe(true);
    expect(/(^|[\s"'`])dark:[a-z\[]/.test("// silent in the dark: it is not tried")).toBe(false);
  });
});
