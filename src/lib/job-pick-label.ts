import { jobLabel } from "@/lib/schedule-options";

/**
 * A JOB IN A PICKER, AS ERIK READS IT: the place first, the number second ("13897 Herringbone ·
 * J-011"). jobLabel (the place alone) stays the screen's label; a picker that lists every job needs
 * the number too, because one street can hold several jobs. Pure, so a server page and the typed
 * cost sheet label a job the same way.
 */
export function jobPickLabel(j: { job_number?: string | null; name?: string | null }): string {
  const name = (j.name ?? "").trim();
  const num = (j.job_number ?? "").trim();
  return name && num ? `${name} · ${num}` : jobLabel(j);
}

/**
 * A JOB NAMED IN A SENTENCE A PERSON READS AWAY FROM IT (Erik: "i cant tell by job numbers alone").
 * The bell that says a paid job still has work to bill is read on a lock screen with no job page around
 * it, so it carries the place, the number and WHO: "41 Larkspur · J-054 — Marla Finch". Built on
 * jobPickLabel, so the place-then-number order is decided in exactly one place; the customer is left off
 * when the label already names them (a job with no street is named for the person).
 */
export function jobSaidLabel(j: { job_number?: string | null; name?: string | null; customer?: string | null }): string {
  const base = jobPickLabel(j);
  const who = (j.customer ?? "").trim();
  if (!who || base.toLowerCase().includes(who.toLowerCase())) return base;
  return `${base} — ${who}`;
}
