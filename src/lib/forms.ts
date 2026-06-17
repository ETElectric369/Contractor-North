/** Shared form-data helpers for server actions — one source of truth. */

/** A blank/whitespace FormData value -> null; otherwise the trimmed string. */
export function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

/** ISO timestamp from a yyyy-mm-dd date + HH:MM time (default 08:00); null if
 *  the date is malformed. */
export function toIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = /^\d{2}:\d{2}/.test(time) ? time : "08:00";
  const d = new Date(`${date}T${t}:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
