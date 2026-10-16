/**
 * THE permit option spine — one set of types/statuses/results + tone helpers, so the standalone
 * add/edit modals and the job-tab inline controls can't drift. They had: the job tab wrote status
 * "scheduled" while the editor only knew "inspection_scheduled", and the editor lacked "not_submitted"
 * the job tab could set — so a permit could land in a status its other editor couldn't represent.
 * permits.status is free text (no DB enum), so the tone/label helpers also accept the legacy "scheduled".
 */
export type PermitTone = "green" | "red" | "amber" | "slate";

export const PERMIT_TYPES = [
  "Electrical",
  "Plumbing",
  "Mechanical",
  "Building",
  "Solar",
  "Low Voltage",
  "Other",
] as const;

/** [value, label] — the union of every status any surface offered. */
export const PERMIT_STATUSES: [string, string][] = [
  ["not_submitted", "Not submitted"],
  ["applied", "Applied"],
  ["issued", "Issued"],
  ["inspection_scheduled", "Inspection scheduled"],
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["closed", "Closed"],
];

/**
 * THE INSPECTION RESULTS ARE NOT HERE ANY MORE (0378). They described permits.inspection_result — ONE
 * inspection, inline on the permit — and a permit needs several, from different authorities, in order.
 * The results a visit can have (passed / failed / cancelled) are 0378's own check constraint, named
 * once in lib/permit-inspections beside the rule that reads them. "pending" and "partial" are gone with
 * the column: a visit nobody has written up has no result at all, and "partial" was never a thing an
 * inspector says — the permit simply still has a visit outstanding.
 */
/**
 * THE STATUSES A PERSON PICKS ON A PERMIT — its own paperwork: not submitted, applied, issued, closed.
 * "Inspection scheduled", "passed" and "failed" are what its inspection ROWS say (0378), and the permit
 * follows them on its own (inspection-actions, closeThePermit). Offering them on the permit was a second
 * door for the same fact, and one that carried nothing forward: Erik, 2026-10-15, J-012 — "I marked the
 * permit inspection as passed, and it didn't save and didn't carry through to the second inspection".
 * He had set the permit's status; its Town of Truckee visit was not a row at all. PERMIT_STATUSES keeps
 * every word for reading a permit written before this.
 */
export const PERMIT_PICKABLE_STATUSES: [string, string][] = PERMIT_STATUSES.filter(([v]) => ["not_submitted", "applied", "issued", "closed"].includes(v));

export function permitStatusLabel(s: string | null | undefined): string {
  const v = (s ?? "").trim();
  if (!v) return "";
  if (v === "scheduled") return "Inspection scheduled"; // the legacy job-tab key
  return PERMIT_STATUSES.find(([k]) => k === v)?.[1] ?? v.replace(/_/g, " ");
}

/** The options a permit's status select shows: the pickable ones, plus the permit's current status when
 *  its rows wrote it — disabled, read-only — so the select reads what the permit says and never a blank. */
export function permitStatusOptions(current: string | null | undefined): { value: string; label: string; disabled?: boolean }[] {
  const picks = PERMIT_PICKABLE_STATUSES.map(([value, label]) => ({ value, label }));
  const cur = (current ?? "").trim();
  if (!cur || picks.some((p) => p.value === cur)) return picks;
  return [{ value: cur, label: `${permitStatusLabel(cur)} (from its inspections)`, disabled: true }, ...picks];
}

export function permitStatusTone(s: string): PermitTone {
  if (["issued", "passed", "closed"].includes(s)) return "green";
  if (s === "failed") return "red";
  // "scheduled" is the legacy job-tab key for "inspection_scheduled" — tone both.
  if (["applied", "scheduled", "inspection_scheduled"].includes(s)) return "amber";
  return "slate";
}
