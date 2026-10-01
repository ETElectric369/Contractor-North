/**
 * A CHANGE ORDER ALWAYS HAS ITS JOB (W2-12). change_orders.job_id is nullable in the database, and
 * the job tab's New Change Order used to open on "— None —": one made without touching that box
 * saved with no job, never showed on the job it was made from, and once /change-orders became a
 * redirect nothing at all could open it. So the form posts its one job, the edit can't unlink it, and
 * the server refuses both in these words. Its own module: a "use server" file exports only actions.
 */
export const CO_NEEDS_JOB = "Pick the job this change order belongs to.";
export const CO_STAYS_ON_JOB = "A change order stays on its job.";
export const CO_NOT_AVAILABLE = "That change order isn't available, so nothing changed.";
/** New Change Order handed anything but exactly one job: a line, never a form that saves a stray. */
export const CO_OPEN_A_JOB = "Open a job to add a change order.";
