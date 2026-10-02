import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { jobMaterialCostFrom, splitJobMaterialCost } from "@/lib/job-cost";
import {
  NOTHING_KEPT_NO_JOB_LINE,
  NO_JOB_ON_YOUR_LIST_LINE,
  SHOP_STOCK_NO_JOB_LINE,
  shopStockPileClause,
  wentBackPileClause,
} from "./supplier-reconcile";

/**
 * A SHOP-STOCK TICKET DOES NOT "STAY AS OVERHEAD" (Shop Stock, migrations 0303-0350).
 *
 * Two places on the Suppliers card used to tell him so: the pile's own heading and every row in it.
 * Both were written before the shelf was a ledger, and both went on saying it afterwards. What is
 * actually true is in src/lib/job-cost.ts: job material cost is `bills - off_shelf + from_shelf`, and
 * 0303's job_shelf_net defines from_shelf as the live draws onto a job — so the cost of a piece taken
 * out of stock lands on the job that took it, stamped from its own lot. The old sentence taught a
 * dead end that does not exist: he would stop looking for that money on the job that used it.
 *
 * ONE SENTENCE, ONE PLACE, so the next door to say it cannot say it differently.
 */
const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(p) && !/\.(test|db-suite|db-fixture)\.tsx?$/.test(p) && !/\.d\.ts$/.test(p) ? [relative(ROOT, p)] : [];
  });
}
const FILES = sourceFiles(join(ROOT, "src"));
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("the arithmetic the sentence has to match", () => {
  it("a piece taken out of stock becomes the taking job's cost, and the buying job stops carrying it", () => {
    // $400 of tickets, $150 of it put into stock, $25 of someone else's lot taken onto this job.
    expect(jobMaterialCostFrom(400, { offShelf: 150, fromShelf: 25 })).toBe(275);
    const split = splitJobMaterialCost(400, { offShelf: 150, fromShelf: 25 });
    expect(split.tickets).toBe(250);
    expect(split.fromStock).toBe(25);
    expect(split.shelfTouched).toBe(true);
    // A job that only took pieces still carries a material cost, which is the whole point.
    expect(jobMaterialCostFrom(0, { offShelf: 0, fromShelf: 43.24 })).toBe(43.24);
  });
});

describe("what the card now says about a stock ticket", () => {
  it("it names the two things that are true and never calls the cost overhead", () => {
    expect(SHOP_STOCK_NO_JOB_LINE).toContain("no job to put it on");
    expect(SHOP_STOCK_NO_JOB_LINE).toContain("Record it to stock");
    expect(SHOP_STOCK_NO_JOB_LINE).toContain("carries exactly what that piece cost");
    expect(SHOP_STOCK_NO_JOB_LINE.toLowerCase()).not.toContain("overhead");
  });

  it("the pile's heading says the same thing, with its count and its money", () => {
    expect(shopStockPileClause(1, "$114.40")).toBe(
      "1 is shop stock ($114.40): record them to stock, and each job that takes a piece out carries what that piece cost.",
    );
    expect(shopStockPileClause(2, "$114.40")).toContain("2 are shop stock ($114.40)");
    expect(shopStockPileClause(2, "$114.40").toLowerCase()).not.toContain("overhead");
    // Nothing in the pile, nothing said: no heading clause over an empty count.
    expect(shopStockPileClause(0, "$0.00")).toBe("");
  });
});

describe("nothing in the app teaches the dead end again", () => {
  /**
   * WORDS A PERSON READS, by the compiler's own reading of the file (the no-shelf-words.test.ts
   * method): every string literal, template chunk and piece of JSX text in src. Comments are not
   * words on a screen, and the comments here quote the old sentence on purpose, to say what it got
   * wrong — a plain grep would trip on them and teach the next person to delete the explanation.
   */
  function wordsIn(file: string): string[] {
    const src = read(file);
    if (!/overhead/i.test(src)) return [];
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
      else if (ts.isTemplateExpression(n)) {
        out.push(n.head.text);
        for (const s of n.templateSpans) out.push(s.literal.text);
      } else if (ts.isJsxText(n)) out.push(n.getText(sf));
      ts.forEachChild(n, walk);
    };
    walk(sf);
    return out;
  }

  it("no screen says a stock ticket stays as overhead", () => {
    const hits = FILES.flatMap((f) =>
      wordsIn(f)
        .filter((w) => /stays? as overhead/i.test(w))
        .map((w) => `${f}: ${w.replace(/\s+/g, " ").trim().slice(0, 120)}`),
    );
    expect(hits).toEqual([]);
  }, 60_000);

  it("the Suppliers card takes both sentences from the one place rather than typing them", () => {
    const card = read("src/app/(app)/bills/supplier-invoices-card.tsx");
    // The row's sentence comes from the one function that knows WHICH of them this row gets, and the
    // pile's clause counts only the rows that can be recorded.
    expect(card).toContain("noJobRowLine(row)");
    expect(card).toContain("shopStockPileClause(needJobTotals.stock");
    expect(card).not.toContain("shop stock (");
  });
});

/**
 * AND THE SENTENCE ONLY GOES TO A ROW THAT HAS THE BUTTON IT NAMES (2026-10-02).
 *
 * "Record it to stock" is an instruction, and the pile it was printed in admits papers no Record To
 * Stock control is ever drawn for: a credit memo (the server refuses one in those words — "Only an
 * invoice can go into stock.") and a purchase a credit memo already took back, which the other fold
 * words as "nothing to record". `noJobRowLine` is where that is decided, once, and these are the words
 * each row may be given. The behaviour itself is pinned in supplier-reconcile.test.ts, on real rows.
 */
describe("the stock instruction goes only to a row that can be recorded", () => {
  it("a return is told nothing was kept, and never told to record anything", () => {
    expect(NOTHING_KEPT_NO_JOB_LINE).toContain("went back on a credit memo");
    expect(NOTHING_KEPT_NO_JOB_LINE).toContain("nothing to record");
    expect(NOTHING_KEPT_NO_JOB_LINE).not.toContain("Record it to stock");
    expect(NOTHING_KEPT_NO_JOB_LINE.toLowerCase()).not.toContain("overhead");
  });

  it("a book with no job to offer is told to add the job, which is a door and not a dead end", () => {
    expect(NO_JOB_ON_YOUR_LIST_LINE).toContain("no job on your list");
    expect(NO_JOB_ON_YOUR_LIST_LINE).toContain("Add the job");
    expect(NO_JOB_ON_YOUR_LIST_LINE).not.toContain("Record it to stock");
  });

  it("the went-back count has its own clause, so the pile's figure is never silent", () => {
    expect(wentBackPileClause(1, "$76.20")).toBe("1 paper went back on a credit memo ($76.20): nothing kept, so there is nothing to record.");
    expect(wentBackPileClause(2, "$0.00")).toContain("2 papers went back on credit memos ($0.00)");
    expect(wentBackPileClause(0, "$0.00")).toBe("");
  });
});
