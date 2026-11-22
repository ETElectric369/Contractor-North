/**
 * THE SITE FENCE ASKS FOR THE DAILY REPORT (cn-v1175). The owner, 2026-11-21: "ask which job the
 * report is being made for at the time of the report [...] on clock out". cn-v1174 opened the report
 * sheet after a clock-out on three doors; the fence's own clock-out prompt was the fourth.
 *
 * ONE window event. The fence's monitor fires it after a clock-out the PERSON answered has landed
 * (never an unattended close), and one host mounted at the app layout's root opens the sheet. The
 * sheet cannot live in the monitor: the monitor is mounted only while a shift is open, keyed by it,
 * and the page refreshes a moment after the close, which would unmount an open sheet (the Modal law).
 * With no host mounted (not a crew lead, or Daily Reports off) the event is heard by nobody.
 *
 * Its own file so the monitor imports a name and nothing else.
 */
export const FENCE_REPORT_EVENT = "cn:fence-report";
