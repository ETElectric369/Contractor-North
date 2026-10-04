import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY DOOR THAT MAKES A JOB SAYS HOW IT BILLS.
 *
 * The chain audit, 2026-10-03. `jobs.billing_type` defaulted to 'fixed' and FOUR doors named it not
 * at all — createJobFromQuote, createJobFromAppointment, recurring-engine, and accept_public_quote
 * (the customer's own Accept link, in SQL). Only the New Job form ever asked. On a book that is 27
 * T&M against 9 fixed, 'fixed' is the wrong answer nearly every time.
 *
 * AND IT IS NOT A LABEL. jobBillsItsActuals(billing_type) gates whether the hours and receipts are
 * OFFERED at invoicing, the job page's Unbilled card, the customer's portal — and step 4 of
 * completeJobWhenPaid, the guard that exists BECAUSE hours once went unbilled. A T&M job born
 * 'fixed' therefore completes silently when a customer taps Pay, with its unbilled work invisible on
 * every surface at once.
 *
 * Migration 0379 put the real rule where no door can route around it: the column stops defaulting
 * and a trigger fills it with the company's own usual kind. THIS TEST IS THE OTHER HALF — the doors
 * written in TypeScript should still say it out loud, because a reader of this code should not have
 * to know a trigger exists to know what a job is born as.
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

/** The text of the object literal an `.insert({ … })` is given, from its first brace to its match. */
function insertedObjects(src: string): string[] {
  const out: string[] = [];
  const re = /from\(\s*["']jobs["']\s*\)\s*\.insert\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

describe("every door that makes a job says how it bills", () => {
  it("names billing_type on every jobs insert in src/", () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('from("jobs")') && !src.includes("from('jobs')")) continue;
      for (const obj of insertedObjects(src)) {
        if (!/\bbilling_type\s*:/.test(obj)) {
          missing.push(file.replace(process.cwd() + "/", ""));
        }
      }
    }
    expect(missing, `these doors make a job without saying how it bills:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("finds the inserts it is meant to be watching — it cannot pass by scanning nothing", () => {
    const found = walk(SRC).flatMap((f) => insertedObjects(readFileSync(f, "utf8")));
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const obj of found) expect(obj).toMatch(/\bbilling_type\s*:/);
  });

  it("0379 is the rule underneath, and says so", () => {
    const mig = join(process.cwd(), "supabase/migrations/0379_a_job_is_born_billing_the_way_this_company_bills.sql");
    const sql = readFileSync(mig, "utf8");
    // The column must stop answering for itself, and something must answer instead.
    expect(sql).toMatch(/alter column billing_type drop default/i);
    expect(sql).toMatch(/create trigger zz_fill_billing_type_jobs/i);
    // A door that NAMED a kind always wins: the trigger only fills a null.
    expect(sql).toMatch(/if new\.billing_type is null then/i);
    // And the twin's arithmetic matches lib/schedule-options usualBillingKind: a tie is T&M.
    expect(sql).toMatch(/then 'fixed' else 'tm'/i);
  });
});
