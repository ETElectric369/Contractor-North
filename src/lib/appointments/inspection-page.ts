/**
 * WHAT AN INSPECTION'S VISIT PAGE LEADS WITH (cn-v1173): three decisions the page reads from here,
 * so the page draws and this file decides. No words (the page holds the catalog), no JSX.
 *
 * The owner, 2026-11-19, on an inspection's page: "lets get rid of this big box illuminating this
 * visit is done start job from visit, makes no sense because there is another button above it to
 * mark inspection done and start job is still going to be a result of an inspection which will have
 * estimated result of some sort"; and "on this page it says INSPECTION OR ESTIMATE which seems out of
 * place because this is an inspection not an estimate". Bounded by his founding rule, "fragment first
 * so we dont piss anyone off forcing them to do something in order to do something else": nothing
 * here removes a door. The start box is moved behind the dots menu, never locked.
 *
 *   1. THE BOX (startCardShown / startRowShown): the start card is drawn as it always was, EXCEPT
 *      for the office on an inspection with no job. There it waits behind the dots menu's Start a Job
 *      from This Visit, which puts `start=1` on the address (startAskedHref) and the card is back in
 *      its old place. Kept on purpose: every other visit; an inspection with a job (the card is its
 *      clock door); a tech's view (his Ask the Office card, so he is never stranded).
 *   2. THE HEADER'S ONE BOXED STEP (inspectionHeaderStep), the office's, on an inspection.
 *   3. THE HEADING above the sheet (visitHeading).
 */

/** The query string as the page receives it (Next's awaited searchParams). */
export type PageQuery = Record<string, string | string[] | undefined>;

/** Whether the address asks for the start card: `start=1`, and nothing else counts. */
export function startAsked(sp: PageQuery): boolean {
  return sp.start === "1";
}

/**
 * The same address with `start=1` on it: every other param kept as it came, in its order (a
 * `task=` that opened a sheet stays open). A param given twice stays given twice.
 */
export function startAskedHref(path: string, sp: PageQuery): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "start" || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  q.set("start", "1");
  return `${path}?${q.toString()}`;
}

export type StartFacts = {
  /** The office (isStaffRole), not a tech or a crew lead. */
  isStaff: boolean;
  /** isInspectionType(appointments.type). */
  isInspection: boolean;
  /** appointments.status. */
  status: string | null;
  /** appointments.job_id is set. */
  hasJob: boolean;
  /** startAsked(searchParams). */
  startAsked: boolean;
};

/** The one case the box is moved behind the dots: the office, an inspection, no job yet. */
function boxMovedAway(f: StartFacts): boolean {
  return f.isStaff && f.isInspection && !f.hasJob;
}

/** 1. Is VisitStartCard drawn? Never on a cancelled visit (as before); otherwise always, unless the
 *  box was moved away and the address has not asked for it back. */
export function startCardShown(f: StartFacts): boolean {
  if (f.status === "cancelled") return false;
  return !boxMovedAway(f) || f.startAsked;
}

/** 1. Is the dots menu's Start a Job from This Visit drawn? Exactly where the box was taken away and
 *  is still away: so the start is always one door away, and never two doors at once. */
export function startRowShown(f: StartFacts): boolean {
  return f.status !== "cancelled" && boxMovedAway(f) && !f.startAsked;
}

export type HeaderStep = "mark_done" | "start_estimate" | "open_estimate" | null;

/**
 * 2. THE HEADER'S ONE BOXED STEP on an inspection, for the office (the row's law: at most one main
 * button, then the dots). Every other visit, and every tech, gets null here (a work visit's Get Paid
 * is its own rule on the page).
 *
 *   booked (scheduled or proposed)                     mark_done       Mark Inspection Done
 *   completed, no outcome, Estimates on, a live estimate open_estimate  the estimate it became
 *   completed, no outcome, Estimates on, none live, no job start_estimate the Inspector's own door
 *   anything else                                       null
 *
 * A COMPLETED INSPECTION WITH A JOB and no live estimate gets no boxed step. The Inspections list
 * (lib/inspections bucketInspections) files such a visit as settled: "a visit whose work went straight
 * to a JOB was answered better than any estimate could", and the owner's report was that list
 * "still demanding Create estimate" with the job on the calendar. The Inspector's own Start the
 * Estimate below is still there.
 *
 * A LEAD THAT ALREADY HAS AN ESTIMATE (leadHasEstimate: any estimate, any status, that names the
 * visit's lead, as the list reads it) gets none either: the list files every visit of that lead as
 * written up, and a boxed Start the Estimate on a second inspection would invite a second price.
 *
 * WHERE THE PAGE AND THE LIST DIFFER, on purpose, and only here (the agreement test pins both):
 *   - A DEAD estimate linked in the visit's capture (declined, expired; a superseded one is read
 *     through its revision), with no outcome recorded: the list files the visit (an estimate exists),
 *     but the step hands Start the Estimate back, as the Inspector's door does (cn-v1069), because a
 *     dead price is one to write again.
 *   - A BOOKED visit already inspected by its sheet (past, with something captured): the list moves it
 *     to Create Estimate on capture alone, while the page still says Mark Inspection Done, one tap
 *     behind; the page asks for the tap that makes it so.
 */
export function inspectionHeaderStep(f: {
  isStaff: boolean;
  isInspection: boolean;
  status: string | null;
  outcome: string | null;
  estimatesOn: boolean;
  estimate: { live: boolean } | null;
  hasJob: boolean;
  /** The visit's lead has any estimate at all (the list's own test of "written up"). */
  leadHasEstimate: boolean;
}): HeaderStep {
  if (!f.isStaff || !f.isInspection) return null;
  if (f.status === "scheduled" || f.status === "proposed") return "mark_done";
  if (f.status !== "completed" || f.outcome || !f.estimatesOn) return null;
  if (f.estimate?.live) return "open_estimate";
  return f.hasJob || f.leadHasEstimate ? null : "start_estimate";
}

/**
 * 3. THE HEADING above the sheet. An inspection says Inspection whatever the Estimates switch says
 * ("this is an inspection not an estimate"); every other visit keeps today's words: Inspection or
 * Estimate for the office with Estimates on, Inspection otherwise.
 */
export function visitHeading(f: { isInspection: boolean; isStaff: boolean; estimatesOn: boolean }): "inspection" | "inspection_or_estimate" {
  if (f.isInspection) return "inspection";
  return f.isStaff && f.estimatesOn ? "inspection_or_estimate" : "inspection";
}
