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
 * TEETH: bills-write-guard.test.ts fails if any file but the three bill writers
 * (organize/paperwork-core.ts, jobs/actions.ts, bills/supplier-actions.ts) puts `scope_category` in
 * a write payload.
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

/**
 * WHOSE WORD WINS when a door has both: a person's answer and a model's read of the paper.
 *
 * THE PERSON'S, ALWAYS — the same attestation-beats-inference rule the receipt reader already
 * applies to Already Paid, the Category and the date. It lives HERE because it was written at the
 * doors instead: the Add Cost sheet drew the question, then handed the reader paid, category and the
 * date and NOT the answer, so on the default Read the Receipt save the model's guess won and nothing
 * on screen said the person's "Decking" had been thrown away (items C1-1 and C1-4).
 *
 * A BLANK answer is not an answer. The control sits on "No Part Of The Job" until somebody picks,
 * exactly as Category sits on its first word, so an untouched control leaves the paper's own read to
 * stand rather than silently blanking it. A word the estimate has not got is still refused by
 * scopeForWrite below — whoever said it.
 */
export function scopeAnswered(said: string | null | undefined, read: string | null | undefined): BillScopeAnswer {
  const person = String(said ?? "").trim();
  if (person) return { kind: "scope", scope: person };
  const model = String(read ?? "").trim();
  return model ? { kind: "scope", scope: model } : { kind: "none" };
}

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

/** WHERE A COST IS MOVING TO. `jobId` null is a business cost — the company's own book, which is not
 *  part of any job. The caller has to SAY which it is: a destination with no job and a destination
 *  whose estimate has no part by that name are two different sentences, and handing an empty scopes
 *  list for both is how a move to Business Cost came to be told about "the job it moved to", and
 *  sent to a control that is not drawn there (item C1-2). Named and required, so no caller can
 *  leave it ambiguous again. */
export type ScopeMoveTo = { jobId: string | null; jobScopes: readonly string[] };

/** THE SCOPE A COST MOVING OFF ITS JOB KEEPS. A part called "Framing" on the job it leaves means
 *  nothing on the job it joins unless that job's estimate has a part by the same name — and a scope
 *  nobody budgeted is a budget-vs-actual row out of thin air. Kept when both jobs have it, dropped
 *  otherwise, and the drop is SAID (never silent).
 *
 *  OFF EVERY JOB IS ITS OWN ANSWER. A cost moved to Business Cost has not moved to a job that lacks
 *  the part, and there is no Part Of The Job control on a business cost to send anybody to —
 *  JobScopePicker draws nothing without a job. So that sentence says what happened and names no
 *  door, because a door that isn't drawn is a dead end. */
export function scopeAfterJobMove(stored: string | null, to: ScopeMoveTo): { value: string | null; said: string | null } {
  const had = String(stored ?? "").trim();
  if (!had) return { value: null, said: null };
  if (!to.jobId)
    return {
      value: null,
      said: `This cost was under "${had}" on the job it came off. A business cost isn't part of a job, so the part it was under came off with it.`,
    };
  if (to.jobScopes.includes(had)) return { value: had, said: null };
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

/** WHAT THE ONE CONTROL SHOWS AS CHOSEN for a stored value — the mirror of scopeSaid, which puts the
 *  same value into words for a row. The reserved word is NOT a part of the job, so it is shown as
 *  none of them: main's receipt reader could store the literal "Uncategorized", and offering it as an
 *  option of its own beside "No Part Of The Job" is the two spellings of nothing in one control this
 *  module exists to prevent — with the Costs tab row beside it already saying "No Part Of The Job
 *  Set" about the same cost, so the row and the box disagreed until he saved (item C1-3). */
export function scopeSelected(value: string | null | undefined): string {
  const s = String(value ?? "").trim();
  return s && s !== SCOPE_UNCATEGORIZED ? s : "";
}

/**
 * WHAT THE ONE CONTROL OFFERS for a job: its estimate's parts, under the word for none of them.
 * Empty when the estimate isn't broken into parts and the cost carries nothing — then there is
 * nothing to ask, and no door is drawn.
 *
 * `stored` IS THE PART THIS COST ALREADY CARRIES, and it rides in the list even when the estimate has
 * since lost that line, so the dropdown can never silently re-file a cost under nothing just by being
 * opened: saving what is shown saves what is already there (scopeForWrite keeps it for the same
 * reason). The control has no say in any of this — it draws what this function returns.
 */
export function scopeOptions(jobScopes: readonly string[], stored?: string | null): string[] {
  const has = jobScopes.filter((s) => !!s && s !== SCOPE_UNCATEGORIZED);
  const keep = scopeSelected(stored);
  return keep && !has.includes(keep) ? [keep, ...has] : has;
}
