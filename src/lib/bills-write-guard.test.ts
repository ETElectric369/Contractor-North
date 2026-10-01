import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE TRIPWIRE FOR BOTH COST RULES (items C1 and C2) — a DELIBERATE BYPASS CHECK, not the proof the
 * behaviour works. The behaviour is pinned by real tests (jobs/cost-scope-and-returns.test.ts,
 * organize/paperwork.test.ts, lib/bill-scope.test.ts, lib/job-cost-guard.test.ts).
 *
 * WHY IT HAS TO EXIST. Both items are the SAME defect twice: a rule written at one door while three
 * other doors write the same row. A shared helper does not stop a fifth door from writing `bills`
 * straight: this is what makes it fail loudly instead.
 *
 * Add a door that writes the `bills` table and this test fails until the door either goes through
 * the one guard or is listed here with a reason a person can read.
 */

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => p.slice(SRC.length + 1).split("\\").join("/");

/**
 * EVERY FILE ALLOWED TO WRITE THE `bills` TABLE, and why that write cannot put an uncheckable cost on
 * a job. "guarded" = the file asks lib/job-cost-guard before it writes. Anything else states the
 * reason in words, and the reason is the thing a reviewer checks.
 */
const MAY_WRITE_BILLS: Record<string, string> = {
  // The two real cost writers: both ask jobCostRefusal and both decide scope through scopeForWrite.
  "app/(app)/organize/paperwork-core.ts": "guarded",
  "app/(app)/jobs/actions.ts": "guarded",
  // Record a supplier's own invoice as a bill: guarded (it can put a credit memo on a job).
  "app/(app)/bills/supplier-actions.ts": "guarded",
  // A bank download's costs are ALWAYS job_id: null — the company's own book, which never reaches a
  // customer. Re-pointing one onto a job happens in updateBill, which is guarded.
  "app/(app)/bills/bank-core.ts": "job_id is null on every row it writes (a business cost)",
  // A recurring expense is a business cost: job_id: null, hard-coded.
  "lib/recurring-engine.ts": "job_id is null on every row it writes (a business cost)",
  // The shelf: on_shelf flips on a bill that already has no job (.is('job_id', null) on the write).
  "app/(app)/inventory/actions.ts": "only flips on_shelf, and only on a bill with no job",
};

describe("the bills table has one write boundary (items C1, C2)", () => {
  const writers = new Map<string, number[]>();
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const at = line.indexOf('from("bills")');
      if (at < 0) return;
      // The verb can sit on a following line in a chained query, so read forward — but stop at the
      // next table, or a read of `bills` followed by a write to something else reads as a bill write.
      const after = [line.slice(at + 'from("bills")'.length), ...lines.slice(i + 1, i + 8)].join("\n");
      const nextTable = after.indexOf('from("');
      const chain = nextTable >= 0 ? after.slice(0, nextTable) : after;
      if (!/\.(insert|update|upsert)\(/.test(chain)) return;
      const key = rel(file);
      writers.set(key, [...(writers.get(key) ?? []), i + 1]);
    });
  }

  it("no file writes bills unless it is on the list, with a reason", () => {
    const strangers = [...writers.keys()].filter((f) => !(f in MAY_WRITE_BILLS)).sort();
    expect(
      strangers,
      "A new door writes the bills table. Ask lib/job-cost-guard's jobCostRefusal before the write " +
        "(and lib/bill-scope's scopeForWrite for the part of the job), then add the file to MAY_WRITE_BILLS.",
    ).toEqual([]);
  });

  it("every file listed as guarded really asks the guard", () => {
    for (const [file, why] of Object.entries(MAY_WRITE_BILLS)) {
      if (why !== "guarded") continue;
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src, `${file} is listed as guarded but never calls jobCostRefusal`).toContain("jobCostRefusal(");
    }
  });

  it("the list has no stale entries (a file that no longer writes bills)", () => {
    const stale = Object.keys(MAY_WRITE_BILLS).filter((f) => !writers.has(f)).sort();
    expect(stale, "These files are on MAY_WRITE_BILLS but write no bill any more — drop them.").toEqual([]);
  });
});

describe("one place decides which part of the job a cost is (item C1)", () => {
  const files = walk(SRC);

  it("only the bill writers put scope_category into a write", () => {
    // Writers of the column, by the object-key shape a PostgREST payload uses. A screen that sends
    // `scope_category` through the action registry is not a write — the registry hands it to
    // updateBill, which decides. So this check is scoped to files that write the bills table.
    const offenders = files
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return /\bscope_category:/.test(src) && src.includes('from("bills")') && /\.(insert|update|upsert)\(/.test(src);
      })
      .map(rel)
      .filter((f) => !["app/(app)/organize/paperwork-core.ts", "app/(app)/jobs/actions.ts", "app/(app)/bills/supplier-actions.ts"].includes(f))
      .sort();
    expect(
      offenders,
      "A door is choosing a cost's part of the job for itself. Hand lib/bill-scope's scopeForWrite a " +
        "BillScopeAnswer and write what it decides.",
    ).toEqual([]);
  });

  it("no door writes the lineless-return test itself", () => {
    // isLinelessReturn is the predicate behind the rule. lib/paperwork.ts asks it to paint a door grey
    // BEFORE anyone taps (the screen's half); anywhere else it would be a second opinion that can
    // drift from the boundary — which is exactly how three doors ended up without the rule.
    const offenders = files
      .filter((f) => /\bisLinelessReturn\b/.test(readFileSync(f, "utf8")))
      .map(rel)
      .filter((f) => !["lib/job-cost-guard.ts", "lib/paperwork.ts"].includes(f))
      .sort();
    expect(
      offenders,
      "Ask lib/job-cost-guard's jobCostRefusal (it returns the sentence to say) instead of re-testing " +
        "for a lineless return at the door.",
    ).toEqual([]);
  });
});
