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

export const PERMIT_INSPECTION_RESULTS: [string, string][] = [
  ["pending", "Pending"],
  ["passed", "Passed"],
  ["partial", "Partial"],
  ["failed", "Failed"],
];

export function permitStatusTone(s: string): PermitTone {
  if (["issued", "passed", "closed"].includes(s)) return "green";
  if (s === "failed") return "red";
  // "scheduled" is the legacy job-tab key for "inspection_scheduled" — tone both.
  if (["applied", "scheduled", "inspection_scheduled"].includes(s)) return "amber";
  return "slate";
}

export function permitResultTone(s: string): PermitTone {
  if (s === "passed") return "green";
  if (s === "failed") return "red";
  if (s === "partial") return "amber";
  return "slate";
}
