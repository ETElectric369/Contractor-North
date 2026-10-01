import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * READING THE DATABASE'S OWN WORDS, FROM THE MIGRATIONS, WITH NO CREDENTIALS.
 *
 * Several rules in this app are deliberately written twice — once in the app, so a person is told
 * before they waste the typing, and once in the database, which is the boundary nothing gets past.
 * Two copies are only safe when something FAILS the moment they disagree, and a test that needs a
 * database password cannot be that something: it skips on every machine without one.
 *
 * So these read the migration FILES. The live definition of a function is the one in the LAST
 * migration that creates-or-replaces it, which is exactly what `supabase db push` leaves in the
 * database. Case is ignored: some migrations were pasted back from pg_get_functiondef, which prints
 * `CREATE OR REPLACE FUNCTION … AS $function$`.
 *
 * Used by src/lib/shift-ceiling.test.ts (W4), src/lib/customer-visible-docs.test.ts (W3),
 * src/lib/office-roles.test.ts (W2) and src/lib/vendor-words.test.ts (W1). Its own behaviour — what
 * a tripwire can and cannot see — is pinned in src/lib/migration-body.test.ts. Never shipped: this
 * file is a test utility, and the unit project's include pattern (`*.test.ts`) does not pick it up
 * as a suite of its own.
 */

const DIR = join(process.cwd(), "supabase/migrations");

/** Every migration, in the order they are applied. */
export function migrationFiles(): string[] {
  return readdirSync(DIR)
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .sort();
}

export function migrationText(file: string): string {
  return readFileSync(join(DIR, file), "utf8");
}

/**
 * The LIVE body of a database function: the last migration that creates-or-replaces it wins, and
 * the body is what sits inside its dollar quotes. null when no migration defines it at all — which
 * a caller should assert on rather than skip, because a vanished function is itself the news.
 */
export function liveFunctionBody(fn: string): { file: string; body: string } | null {
  const files = migrationFiles();
  const head = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`, "i");
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = migrationText(files[i]);
    const m = head.exec(sql);
    if (!m) continue;
    const from = sql.slice(m.index);
    // The dollar-quoted body: `as $$ … $$` or `AS $function$ … $function$`.
    const tag = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(from);
    if (!tag) return { file: files[i], body: "" };
    const start = from.indexOf(tag[1], tag.index) + tag[1].length;
    const end = from.indexOf(tag[1], start);
    return { file: files[i], body: end > start ? from.slice(start, end) : "" };
  }
  return null;
}

/**
 * Every `<col> in ('a', 'b', …)` list in a body, as arrays of the quoted words, keyed by nothing —
 * the caller says which column it wants. Whitespace and line breaks inside the list are fine.
 */
export function statusListsOf(body: string, column: string): string[][] {
  const re = new RegExp(`\\b${column}\\s+in\\s*\\(([^)]*)\\)`, "gi");
  const out: string[][] = [];
  for (const m of body.matchAll(re)) {
    const words = [...m[1].matchAll(/'([^']*)'/g)].map((w) => w[1]);
    if (words.length) out.push(words);
  }
  return out;
}

/**
 * WHAT A FILE SAYS, WITH WHAT IT EXPLAINS TAKEN OUT. ONE RULE, ONE PLACE: every bypass tripwire
 * reads its files through here, so what counts as a comment is decided once.
 *
 * A COMMENT OPENER IS ONLY AN OPENER WHERE A COMMENT CAN START — at the top of a file, after
 * whitespace, or after the `{` or `(` an inline JSX or argument comment sits inside. This used to
 * treat every opener-looking pair of characters as one, including the pair inside a string like
 * `accept="image/` + a star + `,application/pdf"`, which opened a comment that ran on to the next
 * real comment close in the file and blanked everything between. Eighteen app files had code hidden
 * from all three tripwires that way — src/middleware.ts for 118 lines, one span covering 79 to 286
 * — so an office-role list or a Supplier label written out by hand inside one of those spans passed
 * every tripwire by name. The repo has no real block comment that opens after a word character, and
 * erring this way is the safe direction: a comment this keeps can only make a tripwire FIRE and say
 * which file it read, never hide a file from it. Pinned in migration-body.test.ts.
 */
export function codeOnly(text: string): string {
  return text
    .replace(/(^|[\s{(])\/\*[\s\S]*?\*\//g, "$1")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|--)/.test(l))
    .join("\n");
}

/**
 * Walk every app source file (never a test, a fixture or a db-suite) and hand each one's text with
 * comments stripped, so a bypass tripwire reads what the app SAYS rather than what it explains.
 */
export function eachAppSource(visit: (path: string, codeOnly: string) => void, skip: readonly string[] = []): void {
  const root = join(process.cwd(), "src");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(e.name)) continue;
      if (/\.(test|db-suite|test-util|test-fixture|db-fixture|cases)\.tsx?$/.test(e.name)) continue;
      if (skip.some((s) => p.endsWith(s))) continue;
      visit(p, codeOnly(readFileSync(p, "utf8")));
    }
  };
  walk(root);
}
