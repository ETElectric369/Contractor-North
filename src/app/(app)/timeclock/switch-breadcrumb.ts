/**
 * The mid-shift-switch breadcrumb. switchJob appends "[switched to <job> at <ISO>]"
 * to the entry's notes on every switch — a human-readable record the office can read
 * in the edit modal, and the only timestamp anywhere that says WHEN the entry stopped
 * being about the previous job site.
 *
 * That timestamp matters beyond bookkeeping: a switch clears the geofence anchor when
 * no fix was available (leaving site A's centre armed is what auto-closed shifts at the
 * time the tech drove away), so the anchor-adoption window has to re-open from the
 * switch rather than from clock-in. Pure + separate from actions.ts because a
 * "use server" module may only export async functions.
 */

/** The format switchJob writes. Kept in one place so writer and reader can't drift. */
export function switchBreadcrumb(label: string, atIso: string): string {
  return `[switched to ${label} at ${atIso}]`;
}

/**
 * Timestamp (epoch ms) of the LAST switch breadcrumb in the notes, or null when the
 * shift has no recorded switch. Tolerates the tech's own free-text notes around it.
 */
export function lastSwitchMs(notes: string | null | undefined): number | null {
  if (!notes) return null;
  const re = /\[switched to [^\]]* at (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\]/g;
  let last: number | null = null;
  for (const m of notes.matchAll(re)) {
    const ms = Date.parse(m[1]);
    if (!isNaN(ms) && (last == null || ms > last)) last = ms;
  }
  return last;
}
