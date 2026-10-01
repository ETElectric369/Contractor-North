import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ONE RULE, ONE PLACE - WITH A TRIPWIRE ON IT (8a982483).
 *
 * ── WHY A TRIPWIRE, AND NOT ONE OF THE OTHER TWO ───────────────────────────────────────────────
 *
 * This project has three proven ways to make a rule impossible to bypass, and only one of them fits
 * this rule:
 *
 *   (1) A TYPED EXHAUSTIVE RECORD, so a new case will not compile. It does not apply: "is this
 *       paper still owed" is a predicate over three booleans, not a case space. There is no new
 *       member anyone could add that a Record would catch.
 *
 *   (2) AN APP RULE WITH A SQL TWIN, pinned by shared cases (job-name.cases.ts + migration 0369).
 *       There is nothing to twin. Nothing in supabase/migrations computes either figure: every SQL
 *       function touching `bills` reads amounts, lines, shelf movements or claims. The only
 *       supplier-name SQL is `customer_supplier_key` in 0315, which answers "is this word one of my
 *       suppliers' names" for the customer-copy scrub - a different question, and wiring the
 *       resolver into it would change what a customer's invoice prints.
 *
 *   (3) A TEST THAT FAILS IF ANY READER WRITES THE PREDICATE ITSELF. This one. The fault here was
 *       never a missing abstraction - `isOnAccountBill` was exported and imported - it was that
 *       three more copies were written anyway, each knowing a different subset of the facts, and
 *       nothing noticed. A shared helper is not enough when a hand-written copy compiles fine.
 *
 * ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────────────────────────
 *
 * A BYPASS TRIPWIRE, not the proof. What the figures actually ARE is proved behaviourally in
 * supplier-owed.test.ts, which builds a whole book of paper and asserts both figures to the cent.
 * This test only answers "did somebody write the rule again somewhere else", which is the thing
 * that has happened three times.
 *
 * Comments are stripped before scanning, so the comment above may name the predicate it bans. The
 * scanner is the one in no-supplier-name.test.ts, which this copies deliberately: two tripwires
 * that disagree about what a line of code is would be the same fault wearing a third hat.
 */

const ROOT = process.cwd();

/** The module that owns these rules. Everything else is a reader. */
const OWNERS = [
  "src/lib/supplier-owed.ts",
  "src/lib/supplier-owed.test.ts",
  "src/lib/supplier-owed-one-place.test.ts",
];

/**
 * NAMED EXCEPTIONS, each with the reason it is not this rule. An exception has to be argued for in
 * writing, which is the point: a silent allowlist is how the fourth copy gets written.
 */
const NOT_THIS_RULE: { file: string; why: string }[] = [
  {
    // supplier_invoices.closed is the SUPPLIER's verdict on the supplier's OWN document. It is the
    // correct inner rule of question (a) and it is not a predicate over a bill at all.
    file: "src/app/(app)/bills/supplier-balance.ts",
    why: "openInvoices reads supplier_invoices.closed - the supplier's word about their own paper, not a bill's status",
  },
  {
    file: "src/app/(app)/bills/supplier-reconcile.ts",
    why: "supplierSaysOpen reads supplier_invoices.closed, pinned to openBalanceOf by its own doc comment",
  },
  {
    // Applying an open list WRITES supplier_invoices.closed and never a bill. That asymmetry is
    // correct and load-bearing: the fix for 8a982483 was in the reading, never the write.
    file: "src/app/(app)/bills/open-list-core.ts",
    why: "writes supplier_invoices.closed when an open list is applied; touches no bill",
  },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

/** Comments out, so a comment may describe the rule it bans. Copied from no-supplier-name.test.ts. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const scan = (test: (line: string) => boolean) => {
  const hits: string[] = [];
  for (const f of files(join(ROOT, "src"))) {
    const rel = relative(ROOT, f);
    if (OWNERS.includes(rel)) continue;
    if (NOT_THIS_RULE.some((e) => e.file === rel)) continue;
    const lines = code(readFileSync(f, "utf8")).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
    }
  }
  return hits;
};

describe("the still-owed rule is written in exactly one place", () => {
  /**
   * THE PREDICATE, HAND-WRITTEN. `isOpenBill`, `isOnAccountBill` and an inline copy on the suppliers
   * card each tested `status` against "paid" themselves, and each knew a different subset of
   * superseded / settled-by-the-supplier - so the same ticket was settled on one line of a screen
   * and owed on the next. `isStillOwed` is the expression; a reader calls it.
   */
  it("no reader compares a bill's status to paid itself", () => {
    // A BILL's status, named as one. A job, an invoice, an appointment and a purchase order each
    // have their own `status` meaning their own thing, with their own open test in open-counts.ts;
    // this rule is only about `bills.status`, which says HOW a thing was BOUGHT.
    const hits = scan(
      (l) =>
        /\b(bill|bills|b|ticket|paper)\s*(\?\.)?\.status\b[^\n]*(!==|===|==|!=)\s*["'`]paid["'`]/.test(l) ||
        /["'`]paid["'`]\s*(!==|===|==|!=)\s*[^\n]*\b(bill|bills|b|ticket|paper)\s*(\?\.)?\.status\b/.test(l) ||
        /\b(bill|bills|b|ticket|paper)\s*(\?\.)?\.status[^\n]*toLowerCase\(\)[^\n]*(!==|===|==|!=)\s*["'`]paid["'`]/.test(l),
    );
    expect(hits).toEqual([]);
  });

  /** The same rule asked of the database instead of in TypeScript. A query that filters bills by
   *  status is the predicate, moved somewhere a grep for `status !== "paid"` would not find it. */
  it("no reader asks the database for unpaid bills by status", () => {
    const hits = scan((l) => /\.(eq|neq|in|not)\(\s*["'`]status["'`]\s*,[^)]*["'`](unpaid|paid)["'`]/.test(l) && /bill/i.test(l));
    expect(hits).toEqual([]);
  });

  /**
   * A SUPPLIER MATCHED BY A NAME STRING. `supplierAccountForPaper` is the only thing that decides
   * which supplier a paper belongs to, and `aliasKey` is the only rule for "is this the same
   * spelling". A reader that writes its own key is building a second set of paper, which is the half
   * of this bug no predicate fix could reach: one total joined through `bills.supplier_account_id`
   * while another grouped the typed spelling, and the two could never be reconciled.
   */
  it("no reader writes its own supplier-spelling key", () => {
    const hits = scan((l) =>
      /\b(spellingKey|supplierKey|sameSpelling|aliasKey)\s*=\s*\([^)]*\)\s*(:[^=]*)?=>\s*String\(/.test(l),
    );
    expect(hits).toEqual([]);
  });

  /**
   * THE ROW'S OWN WORDS, ONCE. The same bill read "On Account" on a job's Costs tab and
   * "Settled · <supplier> Says" on /bills, because the badge was written out by hand in both and
   * only one of them had been told about the supplier's closed paper. `billSettledLabel` makes them.
   */
  it("no screen writes the Settled / On Account badge out by hand", () => {
    const hits = scan((l) => /["'`]On Account["'`]/.test(l) && /["'`]Settled/.test(l));
    expect(hits).toEqual([]);
  });

  /** Every named exception still exists and still says why. A stale allowlist entry is an invitation. */
  it("every exception names a file that exists and gives its reason", () => {
    for (const e of NOT_THIS_RULE) {
      expect(() => statSync(join(ROOT, e.file)), `${e.file} is listed as an exception but is not there`).not.toThrow();
      expect(e.why.length, `${e.file} needs a reason`).toBeGreaterThan(20);
    }
  });

  /** And the owning module is where it says it is: a rename that left the tripwire pointing at
   *  nothing would make this whole file pass by scanning an allowlist of ghosts. */
  it("the owning module exists", () => {
    for (const o of OWNERS) expect(() => statSync(join(ROOT, o)), `${o} is missing`).not.toThrow();
  });
});
