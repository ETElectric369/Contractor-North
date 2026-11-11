/**
 * A JOB BORN FROM AN ESTIMATE TAKES THE ESTIMATE'S SCOPE (cn-v1160). The owner, 2026-11-10, on the page
 * of a job made from an accepted estimate: "i like how the new estimate tasks carry though to the items
 * to buy and created a task to be done but the scope remains empty when that can be filled from the
 * estimate description all the way through we already have the information right?"
 *
 * He was right. An estimate's description (the scope paragraph its paper prints) was never copied to
 * the job's Description: the office's door (createJobFromQuote) did not name it and neither did the
 * customer's own Accept (accept_public_quote, in SQL). The job's Description is the scope the crew
 * reads, and New Invoice copies it onto the customer's bill, so an empty one meant typing the same
 * paragraph a second time.
 *
 * THE RULE, the same in both doors and in the one-time backfill (migration 0409):
 *   · what is taken is the estimate's description with the blank space at its ends removed, and
 *     nothing when that leaves nothing;
 *   · it lands ONLY where the job's own Description is empty. Words a person typed on the job are
 *     never replaced, so a revision or a second estimate accepted onto the same job changes nothing
 *     once the job has a scope.
 *
 * WHAT COUNTS AS BLANK is spelled out, because the SQL twin must agree to the character: a space, a
 * tab, a line feed and a carriage return, and only those (SQL: btrim(x, E' \t\n\r')). JavaScript's own
 * trim() also strips other characters that Postgres's does not, so it is not used here.
 */
const ENDS = /^[ \t\n\r]+|[ \t\n\r]+$/g;

/** The text with the blank space at its ends removed ("" for anything that is not text). */
export function scopeText(v: unknown): string {
  return typeof v === "string" ? v.replace(ENDS, "") : "";
}

/** What a job takes from an estimate's description: the trimmed words, or null when there are none. */
export function scopeForJob(estimateDescription: unknown): string | null {
  const s = scopeText(estimateDescription);
  return s ? s : null;
}

/** May the job take a scope? Only while its own Description is empty. */
export function jobTakesScope(jobDescription: unknown): boolean {
  return scopeText(jobDescription) === "";
}
