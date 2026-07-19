/**
 * Where a task row links. One rule for every surface (calendar, My Day your-list, …):
 *
 *   - a job task → the job's Tasks tab;
 *   - a job-less task in one of the 3 LEGACY categories → that category's /tasks/<slug>
 *     page (the only per-category pages that exist — nav doctrine);
 *   - anything else (free-form org vocabulary or NULL, both legal since migration 0136)
 *     → the /tasks workbench grouped by category. Before this helper those links built
 *     /tasks/<free-form> or /tasks/null, which the [category] page 404s.
 */
export const LEGACY_TASK_CATEGORY_PAGES: ReadonlySet<string> = new Set(["office", "operations", "sales"]);

export function taskHref(t: { job_id?: string | null; category?: string | null }): string {
  if (t.job_id) return `/jobs/${t.job_id}?tab=tasks`;
  return t.category && LEGACY_TASK_CATEGORY_PAGES.has(t.category)
    ? `/tasks/${t.category}`
    : "/tasks?by=category";
}
