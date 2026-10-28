/**
 * A NOTE UNDER A LINE (cn-v1137; Bug Watch: /quotes/new has no note per line item). A line is one
 * description column, and the paper ALREADY prints a multi-line description as a heading with the
 * rest as bullets (quote-document.tsx via lineItemParts) — the office just had no way to type a
 * second line into a one-line autocomplete box. So the note is the description's lines after the
 * first: no new column, nothing the paper does not already print. The first line is THE HEAD — the
 * words the book autocompletes against, the task's name, the kit's name, the name a count writes
 * " ×N" after; the note never joins them. An empty note (nothing, or only whitespace) puts the
 * description back on one line.
 *
 * Pure, and here rather than in the builder's screen file, because the server reads it too: the
 * birth of a job's tasks (born-with-tasks), the kit a task is remembered as (kit-from-task) and the
 * count on a line's name (task-lines) all take the head alone (skeptic #43, S6 — a note under a
 * task line had been landing in the task's title, the kit's name and after the " ×N").
 */
export function splitLineNote(description: string): { head: string; note: string } {
  const s = String(description ?? "");
  const nl = s.indexOf("\n");
  if (nl < 0) return { head: s, note: "" };
  return { head: s.slice(0, nl).replace(/\r$/, ""), note: s.slice(nl + 1) };
}

export function joinLineNote(head: string, note: string): string {
  const h = String(head ?? "").replace(/[\r\n]+/g, " ");
  return String(note ?? "").trim() ? `${h}\n${note}` : h;
}
