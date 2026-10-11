/**
 * HOW LONG THE CUSTOMER'S ACCEPT LINK MAY FINISH WHAT IT STARTED (W3, cn-v1075). Wide enough for the
 * birth of the job's tasks, work order and take-off on a slow phone; narrow enough that the link
 * cannot be used weeks later to re-make paperwork the office has since removed. Lives here, not in
 * the "use server" file that reads it: a server-action module may export only async functions.
 */
export const FINISH_WINDOW_MS = 10 * 60_000;
