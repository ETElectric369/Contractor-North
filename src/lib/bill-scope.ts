/**
 * WHICH PART OF THE JOB A COST BELONGS TO — asked once, for every door (item C1; column 0105).
 *
 * `bills.scope_category` is how ACTUAL spend joins the estimate's BUDGET by scope, so Chris can see
 * that framing specifically is over while decking has not started (getJobBudgetVsActual). ONE door
 * in the whole app ever wrote it: the AI reading a snapped receipt on the job page. Type the cost
 * in, file it from the tray, record a supplier's invoice, or ask Nort, and the same $900 of decking
 * landed in Uncategorized - and no screen anywhere could set it afterwards. So Nort would report
 * "decking hasn't started" with the spend sitting right there on the Costs tab.
 *
 * THE RULE LIVES HERE AND NOWHERE ELSE. A door does not decide what to store; it ANSWERS, and this
 * module decides. The answer is a typed union, so a new kind of answer cannot be added without
 * every writer being made to handle it (the `never` check below), and `scopeForWrite` is the only
 * thing in the app that produces the stored value.
 *
 * TEETH: bills-write-guard.test.ts fails if any file but the two bill writers puts
 * `scope_category` in a write payload.
 */

/** The reserved word for a cost under no part of the job. Stored as NULL, not as this word: the
 *  readers (getJobActualByCategory) turn a null into this heading, and two spellings of "nothing"
 *  in one column is how a budget row splits in two. */
export const SCOPE_UNCATEGORIZED = "Uncategorized";

/** What a door answers when it writes a cost. */
export type BillScopeAnswer =
  /** There is no job: a business cost, or a shop-stock ticket. Nothing to be a part of. */
  | { kind: "noJob" }
  /** The door cannot ask here (one-tap filing from the tray, a bank download, an import). The cost
   *  lands under no part of the job AND the screen says so, with a door to set it. Never a guess. */
  | { kind: "notAsked" }
  /** Somebody (or the reader) was asked and said it is not one of the job's parts. */
  | { kind: "none" }
  /** A part of this job's estimate, by its own words. */
  | { kind: "scope"; scope: string };

export type ScopeDecision = {
  /** What goes in `bills.scope_category`. */
  value: string | null;
  /** Said to the person, and nothing is written. */
  refusal: string | null;
};

/** The one sentence for a part this job's estimate does not have. Names what it does have, because
 *  a refusal with no way forward is a dead end. */
export function scopeNotOnJob(scope: string, jobScopes: readonly string[]): string {
  const has = jobScopes.filter((s) => s && s !== SCOPE_UNCATEGORIZED);
  return has.length
    ? `This job's estimate has no part called "${scope}". Its parts are: ${has.join(", ")}. Nothing was saved.`
    : `This job's estimate isn't broken into parts yet, so a cost on it can't be put under "${scope}". Nothing was saved.`;
}

/**
 * THE ONLY PLACE A SCOPE BECOMES A STORED VALUE.
 *
 * `jobScopes` is the job's own estimate scopes (listJobScopes) — a cost may only be put under a part
 * the estimate really has, or the budget row it joins would be one nobody budgeted.
 */
export function scopeForWrite(input: {
  jobId: string | null;
  answer: BillScopeAnswer;
  jobScopes: readonly string[];
  /**
   * THE PART THIS COST IS ALREADY UNDER, on an edit. It is KEPT even when the estimate no longer has
   * a line by that name — somebody deleted the Framing lines after the receipt was filed — because
   * refusing it would mean the Edit Bill box could never save that cost again, for any reason: a
   * typo in the supplier, a corrected date, nothing. A dead end of the app's own making. Only a
   * change is held to the estimate's current parts.
   */
  stored?: string | null;
}): ScopeDecision {
  const { jobId, answer, jobScopes } = input;
  const stored = String(input.stored ?? "").trim();
  switch (answer.kind) {
    case "noJob":
      // A door that says "no job" over a job id is a door that has not been taught the question.
      // Said rather than quietly stored, because the silent version is exactly the bug C1 names.
      return jobId
        ? { value: null, refusal: "This cost is on a job, so it has to answer which part of the job it is. Nothing was saved." }
        : { value: null, refusal: null };
    case "notAsked":
    case "none":
      return { value: null, refusal: null };
    case "scope": {
      const want = String(answer.scope ?? "").trim();
      if (!want || want === SCOPE_UNCATEGORIZED) return { value: null, refusal: null };
      if (!jobId)
        return {
          value: null,
          refusal: `A business cost isn't part of a job, so it can't be put under "${want}". Put it on a job first, or leave it as a business cost. Nothing was saved.`,
        };
      if (want !== stored && !jobScopes.includes(want)) return { value: null, refusal: scopeNotOnJob(want, jobScopes) };
      return { value: want, refusal: null };
    }
    default: {
      // A new kind of answer will not compile until every writer above handles it.
      const never: never = answer;
      return never;
    }
  }
}

/** THE SCOPE A COST MOVING TO ANOTHER JOB KEEPS. A part called "Framing" on the job it leaves means
 *  nothing on the job it joins unless that job's estimate has a part by the same name — and a scope
 *  nobody budgeted is a budget-vs-actual row out of thin air. Kept when both jobs have it, dropped
 *  otherwise, and the drop is SAID (never silent). */
export function scopeAfterJobMove(stored: string | null, nextJobScopes: readonly string[]): { value: string | null; said: string | null } {
  const had = String(stored ?? "").trim();
  if (!had) return { value: null, said: null };
  if (nextJobScopes.includes(had)) return { value: had, said: null };
  return {
    value: null,
    said: `This cost was under "${had}" on the job it came off. The job it moved to has no part by that name, so it now sits under no part of the job. Set one from the Edit Bill box if it belongs to one.`,
  };
}

/** The words a screen shows for a stored value: the part's own name, or that nothing is set. */
export function scopeSaid(value: string | null | undefined): string {
  const s = String(value ?? "").trim();
  return s && s !== SCOPE_UNCATEGORIZED ? s : "No Part Of The Job Set";
}

/** What the picker offers for a job: its estimate's parts, plus the word for none of them. Empty
 *  when the estimate isn't broken into parts — then there is nothing to ask, and no door is drawn. */
export function scopeOptions(jobScopes: readonly string[]): string[] {
  const has = jobScopes.filter((s) => !!s && s !== SCOPE_UNCATEGORIZED);
  return has.length ? [...has] : [];
}
