// Single source of truth for the categories that split the one compliance_items tracker across
// three Liabilities views: /insurance, /audits, and /compliance (the catch-all for everything else
// — licenses, certs, permits). Keeping these here (not in a "use client" manager) lets the server
// pages filter by them without an RSC boundary import.

export const INSURANCE_TYPES = [
  "General Liability",
  "Workers' Comp",
  "Commercial Auto",
  "Umbrella",
  "Professional Liability",
  "Bond",
];

// Legacy rows defaulted to "Insurance"; "Liability" was used loosely — route them to /insurance too.
export const INSURANCE_FILTER = [...INSURANCE_TYPES, "Insurance", "Liability"];

export const AUDIT_TYPES = [
  "Safety Audit",
  "OSHA Audit",
  "Insurance Audit",
  "Financial Audit",
  "Quality Audit",
  "Permit Audit",
  "Other Audit",
];

export const COMPLIANCE_TYPES = [
  "Contractor License",
  "Business License",
  "Certification",
  "Vehicle Registration",
  "Permit",
  "Other",
];

// /compliance is the catch-all: every item that ISN'T clearly insurance or an audit shows there
// (so nothing can orphan onto no page). These are the types it EXCLUDES.
export const EXCLUDED_FROM_COMPLIANCE = new Set<string>([...INSURANCE_FILTER, ...AUDIT_TYPES]);
