/**
 * THE CALENDAR'S DATA WINDOW — one pair of numbers, shared by the fetch and every consumer.
 *
 * CalendarPanel preloads this span around "now" and paging never refetches, so anything allowed
 * to navigate past it renders real-looking days that are silently EMPTY — "nothing scheduled"
 * where the truth is "nothing loaded". The scroll stacks, the chevrons, and the ?date= anchor all
 * clamp against these same constants (hand-copied-list law: the caps used to be four literals in
 * two files held in sync by a comment).
 */
export const CAL_WINDOW_BACK_DAYS = 120;
export const CAL_WINDOW_FWD_DAYS = 400;

/**
 * THE JOBS A SEGMENT IN THE WINDOW NAMES THAT THE JOBS READ DIDN'T BRING. The calendar's jobs read
 * filters on jobs.scheduled_start (the listed span), but a job whose date was cleared (Clear The Date)
 * keeps its WORKED days as history segments with no listed span, so that read never returns it: the
 * day it was worked vanished from the calendar while the note said "Kept Sep 22 on the calendar".
 * CalendarPanel reads these ids in a second, by-id pass, so every segment in the window draws.
 */
export function segmentJobsNotLoaded(loadedJobIds: Iterable<string>, segments: { job_id: string }[]): string[] {
  const have = new Set(loadedJobIds);
  return [...new Set(segments.map((s) => s.job_id))].filter((id) => !!id && !have.has(id));
}
