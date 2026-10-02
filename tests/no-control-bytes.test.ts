import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NO SOURCE FILE CARRIES A RAW CONTROL BYTE (cn-v1041).
 *
 * The scrub that swapped every real customer name for an invented one did it with a tool that
 * wrapped its own placeholders in NUL bytes, and one placeholder was never substituted back. Two
 * raw NULs shipped inside a string in src/app/(app)/planner/page.tsx, in the quote of the day that
 * renders at the top of My Day for every role — so about eleven days a year the first thing the
 * crew read on opening the app was a mangled line with two control characters in it, and the NULs
 * went out in the server-rendered HTML.
 *
 * Nothing caught it. tsc, the unit suite and lint all pass over a NUL quite happily. Worse, a NUL
 * makes a file BINARY to the ordinary tools: `grep`, `git grep`, `sed` and `awk` stop printing
 * lines and say "Binary file matches" instead, so the file goes quiet exactly when somebody is
 * searching it for the damage. The first review sweep of that commit missed the line for that
 * reason, and so did a search of the diff.
 *
 * So this reads the BYTES, not the lines, and not through any tool that can be blinded by them.
 * A control byte in a text file is never deliberate here: tab, newline and carriage return are the
 * only ones a source file has any use for.
 */

/** Tab, newline and carriage return are the only control bytes a source file needs. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);
const isControl = (c: number) => (c < 0x20 && !ALLOWED.has(c)) || c === 0x7f;

/** Everything that is text, by extension, so the real binaries (png, jpg, ico, xlsx) stay out. */
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|svg|sql|json|md|ya?ml|html|txt)$/i;

/** Every directory that holds hand-written files, plus the config files at the root. */
const DIRS = ["src", "tests", "docs", "scripts", ".github", "public", "supabase"];

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function textFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) textFiles(p, out);
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

/** The byte offset of the first control byte, and which byte it was. */
function firstControl(buf: Buffer): { at: number; byte: number } | null {
  for (let i = 0; i < buf.length; i++) if (isControl(buf[i])) return { at: i, byte: buf[i] };
  return null;
}

/** The line and column a byte offset lands on, so a failure says where to look. */
function placeOf(buf: Buffer, at: number): string {
  const before = buf.subarray(0, at);
  let line = 1;
  for (const c of before) if (c === 0x0a) line++;
  const lastBreak = before.lastIndexOf(0x0a);
  return `${line}:${at - lastBreak}`;
}

describe("the scanner can see a control byte", () => {
  it("finds a NUL, an escape and a delete, and leaves tab, newline and return alone", () => {
    expect(firstControl(Buffer.from("do your work\u0000TESS\u0000"))?.byte).toBe(0x00);
    expect(firstControl(Buffer.from("colour \u001b[31mred"))?.byte).toBe(0x1b);
    expect(firstControl(Buffer.from("a\u007f"))?.byte).toBe(0x7f);
    expect(firstControl(Buffer.from("tabs\tand\nlines\r\nare fine"))).toBeNull();
    expect(firstControl(Buffer.from("plain text"))).toBeNull();
  });

  it("says which line the byte is on", () => {
    expect(placeOf(Buffer.from("one\ntwo\nthr\u0000ee"), 11)).toBe("3:4");
  });
});

describe("no shipped text file carries a raw control byte", () => {
  it("every hand-written text file is clean", () => {
    const files = DIRS.flatMap((d) => {
      const dir = path.join(ROOT, d);
      expect(statSync(dir).isDirectory(), `${d}/ is not there to walk`).toBe(true);
      return textFiles(dir);
    });
    for (const name of readdirSync(ROOT)) {
      const p = path.join(ROOT, name);
      if (statSync(p).isFile() && TEXT.test(name)) files.push(p);
    }

    const bad: string[] = [];
    let bytesRead = 0;
    for (const f of files) {
      const buf = readFileSync(f);
      bytesRead += buf.length;
      const hit = firstControl(buf);
      if (hit) {
        bad.push(
          `${path.relative(ROOT, f)}:${placeOf(buf, hit.at)} carries a raw 0x${hit.byte.toString(16).padStart(2, "0")} ` +
            `byte — write the character, or nothing, but never the control byte`,
        );
      }
    }

    // It read the repo, not an empty list: a broken walk or a bad filter fails here, not quietly.
    expect(files.length, "the walk found almost no files").toBeGreaterThan(1500);
    expect(bytesRead, "the files read almost empty").toBeGreaterThan(5_000_000);
    expect(bad, `${bad.length} file(s) carry a control byte:\n${bad.join("\n")}`).toEqual([]);
  });
});
