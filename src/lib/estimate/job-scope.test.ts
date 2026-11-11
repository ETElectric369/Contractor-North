import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jobTakesScope, scopeForJob, scopeText } from "./job-scope";

/**
 * A JOB BORN FROM AN ESTIMATE TAKES THE ESTIMATE'S SCOPE (cn-v1160). The owner, 2026-11-10, on a job
 * made from an accepted estimate: "the scope remains empty when that can be filled from the estimate
 * description all the way through we already have the information right?"
 *
 * This is the rule with no door and no database: what is taken (the estimate's description with the
 * blank space at its ends removed) and when it lands (only while the job's own Description is
 * empty). The office's door, the customer's own Accept and the one-time backfill all read it, and the
 * last two are SQL, so WHAT COUNTS AS BLANK is pinned here to the character: a space, a tab, a line
 * feed and a carriage return, and nothing else (SQL: btrim(x, E' \t\n\r')). JavaScript's own trim()
 * strips more than that, and a rule that used it would call a job's Description empty in one door
 * and full in the other.
 */

/** The four characters the rule calls blank, each written as its escape. */
const BLANK = [" ", "\t", "\n", "\r"];

/**
 * Every OTHER character JavaScript's trim() strips (the WhiteSpace and LineTerminator sets), each
 * written as its escape so no raw control byte sits in this file: a vertical tab, a form feed, a
 * no-break space, the byte-order mark, the two Unicode line breaks and the space separators.
 * Postgres's btrim with a four-character list strips none of them, so the rule keeps every one.
 */
const NOT_BLANK = [
  "\u000b",
  "\u000c",
  " ",
  "﻿",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  " ",
  "　",
];
const code = (ch: string) => `U+${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`;

describe("scopeText: the blank space at the ends, and only that", () => {
  it.each(BLANK.map((ch) => [code(ch), ch]))("%s is blank: stripped from both ends, alone or in a run", (_name, ch) => {
    expect(scopeText(`${ch}Panel swap${ch}`)).toBe("Panel swap");
    expect(scopeText(`${ch}${ch}${ch}Panel swap`)).toBe("Panel swap");
    expect(scopeText(`Panel swap${ch}${ch}`)).toBe("Panel swap");
    expect(scopeText(ch)).toBe("");
    expect(scopeText(ch.repeat(40))).toBe("");
  });

  it("the four are stripped in any mix, at either end", () => {
    expect(scopeText(" \t\r\n Panel swap \n\r\t ")).toBe("Panel swap");
    expect(scopeText("\r\n\r\nReplace the 100 A panel.\r\n")).toBe("Replace the 100 A panel.");
    expect(scopeText(" \t\n\r")).toBe("");
  });

  it.each(NOT_BLANK.map((ch) => [code(ch), ch]))("%s is NOT blank: JavaScript's trim() would strip it, the rule keeps it", (_name, ch) => {
    const words = `${ch}Panel swap${ch}`;
    // The premise: this is a character trim() takes, so a rule built on trim() would differ here.
    expect(words.trim()).toBe("Panel swap");
    expect(scopeText(words)).toBe(words);
    // It also stops the strip: a blank beyond it is inside the text now, not at its end.
    expect(scopeText(` ${ch} Panel swap ${ch} `)).toBe(`${ch} Panel swap ${ch}`);
    // Alone it is words, as it is to Postgres.
    expect(scopeText(ch)).toBe(ch);
  });

  it("the two lists together are everything trim() strips: no blank character was left unjudged", () => {
    const stripped: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (ch.trim() === "") stripped.push(ch);
    }
    expect(stripped.map(code).sort()).toEqual([...BLANK, ...NOT_BLANK].map(code).sort());
  });

  it("nothing inside the text is touched: its own line breaks, tabs and double spaces stay", () => {
    const scope = "Replace the 100 A panel.\n\n\tNew 200 A service,  two  ground rods.\r\nPermit by owner.";
    expect(scopeText(scope)).toBe(scope);
    expect(scopeText(`\n\n  ${scope} \n`)).toBe(scope);
  });

  it("anything that is not text is no text", () => {
    for (const v of [null, undefined, 0, 12, true, false, {}, [], ["Panel swap"], { description: "Panel swap" }, Symbol("x")]) {
      expect(scopeText(v)).toBe("");
    }
  });

  it("trimming twice changes nothing, and one call does not colour the next", () => {
    const once = scopeText(" \n Panel swap \t");
    expect(scopeText(once)).toBe(once);
    // The pattern is global: asked again and again it gives the same answer every time.
    for (let i = 0; i < 5; i++) expect(scopeText("  Panel swap  ")).toBe("Panel swap");
  });
});

describe("scopeForJob: what a job takes from an estimate's description", () => {
  it("the trimmed words", () => {
    expect(scopeForJob("  Replace the 100 A panel.\n")).toBe("Replace the 100 A panel.");
    expect(scopeForJob("Panel swap")).toBe("Panel swap");
    expect(scopeForJob("\tLine one\nLine two\r\n")).toBe("Line one\nLine two");
  });

  it("nothing when there are no words: null, never an empty string for a column to hold", () => {
    for (const v of [null, undefined, "", " ", "\t", "\n", "\r", " \t\n\r \r\n"]) expect(scopeForJob(v)).toBeNull();
    for (const v of [0, 12, true, {}, []]) expect(scopeForJob(v)).toBeNull();
  });

  it("a description of only a no-break space is words to the rule, as it is to Postgres", () => {
    expect(scopeForJob(" ")).toBe(" ");
  });
});

describe("jobTakesScope: only while the job's own Description is empty", () => {
  it("an empty Description takes one: null, nothing at all, or only blank space", () => {
    for (const v of [null, undefined, "", " ", "\t", "\n", "\r", "   \r\n\t  "]) expect(jobTakesScope(v)).toBe(true);
  });

  it("words a person typed are never replaced", () => {
    for (const v of ["Panel swap", " x ", "\n.\n", "0", " "]) expect(jobTakesScope(v)).toBe(false);
  });

  it("it is the same blank as the one that is trimmed: a job reads empty exactly when its trimmed text is empty", () => {
    for (const v of ["", " \t\n\r", "x", " x ", "\u000b", "  ", null, undefined]) expect(jobTakesScope(v)).toBe(scopeText(v) === "");
  });

  it("a revision or a second estimate changes nothing once the job has a scope", () => {
    // The first estimate's words land on an empty job…
    const first = scopeForJob("  Replace the 100 A panel.  ");
    expect(jobTakesScope(null)).toBe(true);
    // …and from then on the job has words of its own, whoever's they were.
    expect(jobTakesScope(first)).toBe(false);
  });
});

describe("the rule's own file", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/estimate/job-scope.ts"), "utf8");

  it("never calls JavaScript's trim(), and names the SQL twin's own spelling of the four characters", () => {
    expect(src).not.toMatch(/\.trim(Start|End)?\(/);
    expect(src).toContain("btrim(x, E' \\t\\n\\r')");
  });

  it("carries no words and reads no database: three pure functions", () => {
    expect(src).not.toMatch(/^import /m);
    expect([...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]).sort()).toEqual(["jobTakesScope", "scopeForJob", "scopeText"]);
  });
});
