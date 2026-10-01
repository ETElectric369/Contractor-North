import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { codeOnly, eachAppSource } from "@/lib/migration-body.test-util";

/**
 * WHAT THE BYPASS TRIPWIRES CAN SEE (batch item 1).
 *
 * Four tripwires — W1's vendor words, W2's office roles, W3's customer-visible papers, W4's shift
 * ceiling — all claim their teeth from one scan of the app's own source. They were blind in
 * eighteen files, and nobody could tell, because a scan that skips a file reports nothing.
 *
 * The cause was one character of context. `codeOnly` stripped every opener-looking pair of
 * characters as a comment, including the pair inside a string like `accept="image/` + a star +
 * `,application/pdf"` on a camera input. That opened a comment which ran on to the next real
 * comment close in the file and blanked everything between: 160 lines of
 * jobs/[id]/job-portal-papers.tsx, 118 of middleware.ts (one span from 79 to 286), 78 of
 * snap-or-note.tsx, 72 of quick-cost-button.tsx. A role gate or a hand-typed Supplier label written
 * inside one of those spans passed all four tripwires BY NAME: the same line twenty lines higher
 * failed them.
 *
 * Reproduced before the fix: the first case here fails on the old stripper (the string comes back
 * cut at the star, and SNEAKY_OFFICE — standing in for the role list a developer would write out by
 * hand — is gone from what the tripwires read).
 */
describe("the one comment stripper every bypass tripwire reads through", () => {
  it("an opener inside a STRING is not an opener: the string, and the code under it, stay visible", () => {
    const door = [
      "export function SnapDoor() {",
      '  return <input type="file" accept="image/*,application/pdf" capture="environment" />;',
      "}",
      // Under the old stripper this sat inside the fake comment's span, and every tripwire missed it.
      'const SNEAKY_OFFICE = ["owner", "admin", "office"];',
      "/** A real comment, which IS taken out. */",
      "const AFTER = 1;",
    ].join("\n");
    const seen = codeOnly(door);
    expect(seen, "the accept= string came back cut at the star").toContain('accept="image/*,application/pdf"');
    expect(seen, "code below a string with an opener in it was blanked").toContain("SNEAKY_OFFICE");
    expect(seen).toContain("AFTER");
    // What it is for: the real comment is still gone, so a tripwire reads what the app SAYS.
    expect(seen).not.toContain("A real comment");
  });

  it("a real comment is still taken out, wherever a comment can start", () => {
    expect(codeOnly("/** at the top */\nconst a = 1;")).not.toContain("at the top");
    expect(codeOnly("const a = 1; /* after code */\nconst b = 2;")).not.toContain("after code");
    expect(codeOnly("<div>{/* a JSX note */}</div>")).not.toContain("a JSX note");
    expect(codeOnly("fn(/* an argument note */ x)")).not.toContain("an argument note");
    expect(codeOnly("  // a line comment\nconst a = 1;")).not.toContain("a line comment");
    expect(codeOnly(" * a JSDoc continuation\nconst a = 1;")).not.toContain("JSDoc continuation");
    // A comment spanning lines goes whole, and the code on either side of it stays.
    const multi = codeOnly("const before = 1;\n/*\n a reason\n*/\nconst after = 2;");
    expect(multi).not.toContain("a reason");
    for (const kept of ["before", "after"]) expect(multi).toContain(kept);
  });

  /**
   * END TO END, ON THE REAL REPO, with no path or line number to go stale: every `accept=` attribute
   * in the app that carries an opener inside its quotes is handed to the tripwires WHOLE. That is
   * the exact shape that opened the hole, on the ~30 camera and file inputs that have it. Comment
   * lines are skipped, because a comment that merely mentions one is not code and is meant to go.
   */
  it("every accept= attribute with an opener inside its quotes survives the strip", () => {
    const inCode = /accept="[^"\n]*\/\*[^"\n]*"/;
    const commentLine = /^\s*(\/\/|\/\*|\*|--)/;
    let found = 0;
    const blind: string[] = [];
    eachAppSource((p, code) => {
      const raw = readFileSync(p, "utf8");
      raw.split("\n").forEach((line, i) => {
        if (commentLine.test(line)) return;
        const m = inCode.exec(line);
        if (!m) return;
        found++;
        if (!code.includes(m[0])) blind.push(`${p}:${i + 1} ${m[0]}`);
      });
    });
    expect(found, "no app file writes an opener inside an accept= any more — re-point this case at the shape that replaced it").toBeGreaterThan(20);
    expect(
      blind,
      `the stripper opened a fake comment here, hiding the code that follows from every tripwire: ${blind.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * AND THE SCAN ITSELF REACHES THE WHOLE FILE. A tripwire's teeth are worth exactly what it reads,
   * so this holds the floor: for every app source, what the tripwires see keeps most of the file's
   * own code lines. A fake comment span is a cliff (middleware.ts lost 118 of its ~300), so a new
   * way of blanking a file fails here even if it is nothing to do with a string.
   */
  it("no app file comes back with most of its code missing", () => {
    const thin: string[] = [];
    eachAppSource((p, code) => {
      const raw = readFileSync(p, "utf8");
      // Lines that are plainly code: not blank, not a comment line, not a lone brace.
      const isCode = (l: string) => !!l.trim() && !/^\s*(\/\/|\/\*|\*|--)/.test(l);
      const before = raw.split("\n").filter(isCode).length;
      const after = code.split("\n").filter((l) => !!l.trim()).length;
      if (before >= 40 && after < before * 0.6) thin.push(`${p} (${after} of ${before})`);
    });
    expect(thin, `the tripwires read only a fraction of these files: ${thin.join(", ")}`).toEqual([]);
  });
});
