/**
 * THE BELL'S NUMBERS AND WORDS (Wave 1, the Bell records every push). Pure, so each is pinned.
 *
 *   the badge   counts only what is UNREAD (badges show open), as the database counts it (an exact
 *               head count, never the length of the 20 rows the list shows), "9+" above nine, and no
 *               badge at all at zero.
 *   the list    the newest 20; when there are more, one plain line says so.
 *   each row    when it came in, small and grey: "10:42 AM" today, "Yesterday", "Sep 24" (with the
 *               year when it isn't this year).
 */

/** How many lines the bell shows. */
export const BELL_LIST_SIZE = 20;

/** The line under a full list when older ones exist. */
export const BELL_MORE_LINE = `Showing the newest ${BELL_LIST_SIZE}`;

/** The badge: nothing at zero (or a count that couldn't be read), the count to nine, then "9+". */
export function bellBadge(unread: number | null | undefined): string | null {
  const n = Math.floor(Number(unread) || 0);
  if (n <= 0) return null;
  return n > 9 ? "9+" : String(n);
}

/** A day in `timeZone` (undefined: the viewer's own clock), as YYYY-MM-DD. */
function dayIn(d: Date, timeZone?: string): string {
  return d.toLocaleDateString("en-CA", { timeZone });
}

/**
 * When a line came in, on the viewer's clock (or `timeZone`): its time today, "Yesterday", or its
 * date. Unreadable: nothing, never "Invalid Date".
 */
export function bellWhen(createdAt: string | null | undefined, now: Date = new Date(), timeZone?: string): string {
  const d = new Date(String(createdAt ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  const day = dayIn(d, timeZone);
  const today = dayIn(now, timeZone);
  if (day === today) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const yesterday = dayIn(new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000), "UTC");
  if (day === yesterday) return "Yesterday";
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone });
}
