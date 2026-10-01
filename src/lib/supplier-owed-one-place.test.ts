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

/**
 * WRITES THAT ASK WHETHER A PAPER IS ALREADY FILED, which is a question about the stored column and
 * is answerable only by reading it. Filing a paper onto an account, and refusing to move one that is
 * already somewhere else, are the two places `bills.supplier_account_id` is the subject rather than a
 * shortcut to the supplier's identity. Each still has to be argued for in writing.
 */
const FILES_THE_PAPER: { file: string; why: string }[] = [
  {
    file: "src/app/(app)/bills/supplier-actions.ts",
    why: "filing and alias actions ask whether a bill is ALREADY on an account, and whether it is a DIFFERENT one, before moving it; the stored column is the subject of that question",
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

  /**
   * A FIGURE READER THAT GATES A TICKET ON THE RAW `bills.supplier_account_id` COLUMN.
   *
   * This is the half of the bug no predicate fix could reach, and it came back AFTER the fix: the
   * P&L card's model-B arm built its covering walk with the resolver and then re-filtered the
   * covering tickets by the stored column, which is null on more than half his book. The ticket
   * dropped out of "covered" and the card named it as money the supplier had never billed - beside
   * the very invoice printed on that ticket's own line.
   *
   * `supplierAccountForPaper` is the only thing that decides which supplier a paper belongs to, so
   * comparing the stored column to an account id is always either this fault or a write deciding
   * whether a paper is ALREADY filed - and the ones that are get named below.
   */
  it("no figure gates a ticket on the stored supplier_account_id column", () => {
    // A BILL's column, named as one. A PAYMENT carries `supplier_account_id` too and that one IS the
    // stored fact about it (a cheque was sent to an account, not to a spelling), as does the record of
    // what applying an open list wrote; neither is a paper looking for its supplier.
    const billColumn = String.raw`\b(b|bill|bills|ticket|paper)\s*(\?\.)?\.supplier_account_id\b`;
    const anAccount = String.raw`\b(row\.id|account|accountId|acctId|opts\.accountId)\b`;
    const hits = scan(
      (l) =>
        new RegExp(`${billColumn}[^\\n]*(===|!==)[^\\n]*${anAccount}`).test(l) ||
        new RegExp(`${anAccount}[^\\n]*(===|!==)[^\\n]*${billColumn}`).test(l),
    ).filter((h) => !FILES_THE_PAPER.some((e) => h.startsWith(`${e.file}:`)));
    expect(hits).toEqual([]);
  });

  /**
   * COULD THIS FIGURE BE TOTALLED AT ALL, WRITTEN OUT AGAIN. It was spelled out at four doors and
   * one of them - Nort's - left THE SUPPLIER'S OWN PAPERS off the list, so /bills refused to total
   * while he quoted the bills-less-payments number for the same account. `supplierFigureUnread` is
   * the expression; a door calls it.
   */
  it("no reader writes the could-not-total test itself", () => {
    const hits = scan((l) => /model\s*(!==|===)\s*["'`]supplier-invoices["'`]/.test(l) && /onAccount/.test(l));
    expect(hits).toEqual([]);
  });

  /**
   * ── /reconcile MAY NOT WORK OUT A SUPPLIER FIGURE ITSELF (cn-v1037) ──────────────────────────
   *
   * Reconcile's whole job is to draw two records against each other, which makes it the FOURTH door
   * to the one supplier figure (supplier-owed-parity.test.ts: "one book, three doors, one figure").
   * The only safe fourth door is one that calls the same read: `readSupplierOwed`. A page that built
   * its own model-B arm to show "what they say" beside "what we bought" would be 8a982483 with a new
   * file name — and it would be the MOST convincing wrong screen in the app, because two numbers
   * drawn against each other read as having been checked against each other.
   *
   * This lives here, beside its siblings, rather than in a second scanner that could disagree with
   * this one about what a line of code is.
   */
  it("/reconcile calls the one read and never a figure function of its own", () => {
    const dir = join(ROOT, "src/app/(app)/reconcile");
    const banned = ["whatISupplierOwed(", "whatIBoughtNotSettled(", "supplierBalance(", "supplierCoverage(", "supplierSaysBalance("];
    const hits: string[] = [];
    for (const f of files(dir)) {
      const rel = relative(ROOT, f);
      // Its own tests may name a figure function to prove the read hands one back.
      if (/\.test\.tsx?$/.test(rel)) continue;
      const lines = code(readFileSync(f, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        for (const b of banned) if (lines[i].includes(b)) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
      }
    }
    expect(hits).toEqual([]);
    // And it really does go through the one read, per account as well as in total.
    const page = readFileSync(join(dir, "page.tsx"), "utf8");
    expect(page).toContain("readSupplierOwed(supabase, orgId)");
    // The rows themselves are built in the read, out of what that one read handed back: the page asks
    // for them by name and adds up nothing of its own.
    expect(page).toContain("supplierGapRows(owed)");
    const read = readFileSync(join(dir, "reconcile-read.ts"), "utf8");
    expect(read).toContain("owed?.boughtByAccount[a.accountId]");

    /**
     * AND THE ROWS COME OFF `accounts`, NEVER OFF `owed.lines`. This is not style: a LINE on "what
     * you owe your suppliers" exists only where an account is owed MONEY, so an account whose own
     * papers are all CLOSED — their book says nothing is open, ours says four tickets are — had no
     * line, got no row, and the page led with "No money gap" over the loudest disagreement in the
     * book. Filtering the lines is the obvious way to write this and it is the wrong one, so the
     * tripwire names it rather than trusting a comment to be read.
     */
    expect(read).toContain("owed?.accounts ?? []");
    expect(read, "the gap rows must not be filtered off whatISupplierOwed's lines").not.toMatch(/owed[?!.]*\.owed\.lines/);
    expect(page, "the gap rows must not be filtered off whatISupplierOwed's lines").not.toMatch(/owed[?!.]*\.owed\.lines/);
    // And "do we hold their own papers" is asked through the owning module's one expression, because
    // that is the question that decides whether two records exist to disagree at all.
    expect(read).toContain("holdsTheirOwnPapers(a)");
    for (const f of ["page.tsx", "supplier-gap.tsx"]) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toContain('"supplier-invoices"');
    }
    // THE GAP SECTION IS HANDED NUMBERS, NEVER ROWS. It subtracts two figures and adds up the
    // DIFFERENCES — "how far apart" is this page's own reading and no function in supplier-owed.ts
    // produces it — but it must never touch a bill, a payment or a paper, because that is the step
    // where a screen starts totalling a supplier's money a second way.
    const gap = readFileSync(join(dir, "supplier-gap.tsx"), "utf8");
    for (const row of ["bill_line_items", "supplier_account_id", ".status", "isStillOwed", "isOnAccountBill", "settledBySupplier"]) {
      expect(gap, row).not.toContain(row);
    }
    expect(gap).not.toMatch(/\bfrom "@\/lib\/supplier-owed"/);
  });

  /**
   * AND THE COSTS TAB MAY NOT DRAW A BILL ROW WITHOUT THE SUPPLIER'S VERDICT. The component was
   * taught `billSettledLabel` and the job page never passed the fact, so the badge could not fire
   * there however right the expression was. A grep cannot see an unpassed prop; this checks the one
   * thing a grep can see, that the page goes through the shared read and hands the row down.
   */
  it("the job's Costs tab gets the fact from the one read", () => {
    const page = readFileSync(join(ROOT, "src/app/(app)/jobs/[id]/page.tsx"), "utf8");
    expect(page).toContain("readSettledBySupplier(supabase, j.org_id,");
    expect(page).toContain("settledBySupplier: says !== undefined");
    expect(page).toContain("bills={costBills as any}");
    expect(page).toContain("settledSaysUnread={settledSays.unread}");
  });

  /**
   * AND THE P&L CARD AND THE WORKBOOK GET THE FILED SPELLINGS. `supplierAliases` is required on
   * OwnerMoneyInputs now, so nothing can omit it - but a required field can still be handed an empty
   * array, and the only reader that should is a test. The production read must fetch the table.
   */
  it("the owner-money read fetches the filed spellings", () => {
    const src = readFileSync(join(ROOT, "src/lib/analytics/owner-money.ts"), "utf8");
    expect(src).toContain('supabase.from("supplier_aliases").select("alias, supplier_account_id")');
    expect(src).toContain("supplierAliases: supplierAliases.rows");
  });

  /** Every named exception still exists and still says why. A stale allowlist entry is an invitation. */
  it("every exception names a file that exists and gives its reason", () => {
    for (const e of [...NOT_THIS_RULE, ...FILES_THE_PAPER]) {
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
