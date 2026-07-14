/** Shared form-data helpers for server actions — one source of truth.
 *  (A `toIso(date, time)` helper used to live here — deleted: zero callers, and it
 *  was the exact server-local `new Date(`${date}T${time}`)` trap tzDateTimeUtc in
 *  lib/tz.ts exists to replace. Use tzDateTimeUtc with the org timezone instead.) */

/** A blank/whitespace FormData value -> null; otherwise the trimmed string. */
export function emptyToNull(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}
