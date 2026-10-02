import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A PRODUCTION REPLAY'S INPUTS CANNOT BE INVENTED ONES (cn-v1041).
 *
 * A *.prod-replay.test.ts replays one of Erik's own days read-only against the live books. Its
 * fixture is therefore not decoration: the columns it carries are compared against production rows,
 * and the assertions turn on them matching.
 *
 * That collides with the name scrub. When every real identifier in the repo was swapped for an
 * invented one of the same shape, a replay's supplier Account # column was swapped too — and an
 * invented account number matches nothing in production, so resolveAccount stopped answering
 * from: "number", fell through to the "papers" path, and the replay broke with a confusing
 * "expected 'papers' to be 'number'". Nothing went red, because a replay needs REPLAY_DB_* and
 * OPEN_LIST_REPLAY=1 and never runs in CI: it simply stops working the next time Erik runs it.
 *
 * The rule, then: a real identifier a replay has to match comes from the ENVIRONMENT when it runs,
 * never from a literal in the file. The repo keeps the invented stand-in; Erik passes the real one.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function replayFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) replayFiles(p, out);
    else if (name.endsWith(".prod-replay.test.ts")) out.push(p);
  }
  return out;
}

const FILES = replayFiles(path.join(ROOT, "src")).map((f) => [path.relative(ROOT, f), readFileSync(f, "utf8")] as const);

describe("every production replay", () => {
  it("is there to be read", () => {
    // A walk that finds none would pass every check below without checking anything.
    expect(FILES.length, "no production replay was found").toBeGreaterThan(0);
  });

  it("takes the account number it matches against production from the environment", () => {
    const wrong: string[] = [];
    for (const [rel, src] of FILES) {
      // An assertion that the account resolved BY ITS NUMBER means the fixture's number is compared
      // against a stored one. Only the real number can match, so it must come in at run time.
      if (!/toBe\(\s*"number"\s*\)/.test(src)) continue;
      if (!src.includes("REPLAY_ACCOUNT_NUMBER")) {
        wrong.push(
          `${rel} asserts the account resolved from its NUMBER, but takes that number from a literal in the file. ` +
            `An invented stand-in cannot match production: read the real number from REPLAY_ACCOUNT_NUMBER and ` +
            `substitute it into the fixture at run time.`,
        );
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("skips unless every input it insists on was actually given", () => {
    // An input the file dereferences with `!` is one it has decided cannot be missing, so the opt-in
    // gate has to require it. Otherwise a missing variable does not skip the suite: it replays with
    // "undefined" substituted in and fails somewhere further down, which is the opposite of nothing
    // silent. An input with a `|| default` behind it is genuinely optional and is not asked about.
    const wrong: string[] = [];
    for (const [rel, src] of FILES) {
      const destructured = [...src.matchAll(/const\s*\{([^}]*)\}\s*=\s*process\.env/g)].flatMap((m) =>
        m[1].split(",").map((s) => s.trim().split(":")[0].trim()).filter(Boolean),
      );
      const gate = src.slice(src.indexOf("= process.env"), src.indexOf("describe.skip"));
      for (const name of destructured) {
        if (!src.includes(`${name}!`)) continue;
        if (!gate.includes(name)) wrong.push(`${rel} treats ${name} as always present but does not require it before replaying`);
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });
});
