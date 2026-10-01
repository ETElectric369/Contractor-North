/**
 * Where a task row links. One rule for every surface (calendar, My Day's Tasks & Reminders, …):
 *
 *   - a job task → the job's Tasks tab (the pinned chip right after Overview, 0358);
 *   - a task with no job is a Reminder → the Reminders page, /tasks. The /tasks/<category> pages
 *     are gone (0358): a Reminder of any category lands on the one page, which groups By Category.
 */
export function taskHref(t: { job_id?: string | null; category?: string | null }): string {
  if (t.job_id) return `/jobs/${t.job_id}?tab=tasks`;
  return "/tasks";
}
