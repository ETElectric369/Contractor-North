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
