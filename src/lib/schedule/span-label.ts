/**
 * WHAT YEAR IS THIS.
 *
 * Erik: "we have to put the year on there no way around it."
 *
 * He is right, and the reason is something the calendar only recently became. A fixed two-week view
 * never needed a year — you had just arrived at today, so today's year was the only year on offer.
 * Continuous scroll took that away: the stack runs 26 weeks back and 52 forward, so "Dec 28 – Jan 3"
 * is a real thing to be looking at with nothing on screen saying which side of the line you are on,
 * and "Feb 9–15" a year out looks exactly like the one three weeks from now.
 *
 * The old header hid the year whenever it matched today's, on the theory that the common case
 * doesn't need saying. That is the same mistake as the overdue badge: it optimises the glance and
 * loses the answer. A year that appears only when it is surprising is a year you cannot trust the
 * absence of — you have to remember the rule to read the screen. Always showing it costs four
 * characters and means the question is never asked.
 *
 * ── CROSSING THINGS ────────────────────────────────────────────────────────────────────────
 *
 * A week straddles a month a quarter of the time and a year once a year, and both cases are exactly
 * when somebody most needs to know. So the label widens rather than picking one end:
 *
 *     within a month   August 25–31, 2026
 *     across months    Aug 31 – Sep 6, 2026
 *     across years     Dec 28, 2026 – Jan 3, 2027      ← both years, because both are true
 */

/**
 * Name a span of days the way a person would say it.
 *
 * Month names come from the locale, not a hard-coded list. Take care with the inputs: these must be
 * real local Dates. `new Date("2026-08-27")` is UTC midnight and reads as the 26th west of
 * Greenwich — the bug that once flagged every lead due today as overdue.
 */
export function spanLabel(a: Date, z: Date, opts: { month?: "long" | "short"; lang?: string | null } = {}): string {
  const month = opts.month ?? "short";
  // Spanish reads es-US; English keeps the browser's own locale, exactly as before the agenda wave
  // (calendar-view's localeFor says the same).
  const locale = opts.lang === "es" ? "es-US" : undefined;
  const name = (d: Date) => d.toLocaleDateString(locale, { month });
  const sameYear = a.getFullYear() === z.getFullYear();
  const sameMonth = sameYear && a.getMonth() === z.getMonth();

  if (opts.lang === "es") {
    // Spanish says the day before the month: "25–31 de agosto de 2026", "23 ago – 19 sep 2026".
    const de = month === "long" ? "de " : "";
    const one = (d: Date) => `${d.getDate()} ${de}${name(d)}`;
    if (sameMonth) return `${a.getDate()}–${z.getDate()} ${de}${name(a)} de ${a.getFullYear()}`;
    if (sameYear) return `${one(a)} – ${one(z)} de ${a.getFullYear()}`;
    return `${one(a)} de ${a.getFullYear()} – ${one(z)} de ${z.getFullYear()}`;
  }
  if (sameMonth) return `${name(a)} ${a.getDate()}–${z.getDate()}, ${a.getFullYear()}`;
  if (sameYear) return `${name(a)} ${a.getDate()} – ${name(z)} ${z.getDate()}, ${a.getFullYear()}`;
  return `${name(a)} ${a.getDate()}, ${a.getFullYear()} – ${name(z)} ${z.getDate()}, ${z.getFullYear()}`;
}

/** One day, named in full. Same rule: the year is always there. `lang` "es": "lunes, 31 ago 2026". */
export function dayLabel(d: Date, lang?: string | null): string {
  return d.toLocaleDateString(lang === "es" ? "es-US" : undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
