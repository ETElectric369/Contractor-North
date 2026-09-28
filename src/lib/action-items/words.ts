/**
 * HOW NEEDS YOU NAMES A JOB (Erik, 2026-09-27: "i cant tell by job numbers alone"). He reads jobs by
 * the place and what it is, so a row leads with the job's name and puts its number second:
 * "Tanager Panel · J-048", never "J-048" alone. A job with no name reads by its number; one with
 * neither is "A Job". Pure, so the build, the Waiting fold and the tests read one rule.
 */
export function jobWords(j: { job_number?: string | null; name?: string | null } | null | undefined): string {
  const name = String(j?.name ?? "").trim();
  const num = String(j?.job_number ?? "").trim();
  if (name && num && name !== num) return `${name} · ${num}`;
  return name || num || "A Job";
}

/** A person's first name, for "Put on hold by Erik" and "Receipt from Brian"; null when unknown. */
export function firstNameOf(full: string | null | undefined): string | null {
  const first = String(full ?? "").trim().split(/\s+/)[0];
  return first || null;
}
