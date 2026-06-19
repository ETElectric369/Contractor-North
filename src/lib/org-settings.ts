// Org-wide preferences stored in organizations.settings (JSONB). Centralized
// here with defaults so the app can read settings safely anywhere.

export interface OrgSettings {
  // Company
  currency: string; // ISO 4217, e.g. "USD"
  timezone: string; // IANA, e.g. "America/Los_Angeles"
  tax_number: string; // EIN / tax #
  /** App "glass" accent (the dock/bloom tint) — chrome only; documents keep brand_color. */
  glass_tint: string; // hex, e.g. "#1b9488" (sea-glass teal)

  // Documents
  quote_expiry_days: number;
  invoice_due_days: number;
  quote_terms: string;
  invoice_terms: string;
  document_footer: string;
  deposit_percent: number;

  // Financial
  default_labor_rate: number;
  mileage_rate: number; // $ per mile (e.g. IRS standard rate)
  /** Free-text "how we quote" playbook injected into AI quote drafts + assistant. */
  quote_playbook: string;
  /** Employee handbook text (simple #/## headings + paragraphs). */
  employee_handbook: string;

  // Scheduling
  work_day_start: string; // "08:00"
  work_day_end: string; // "17:00"
  week_start: "sunday" | "monday";
  time_tracking_method: "start_end" | "duration";
  labor_law_breaks: boolean; // require break confirmation at clock-out (CA)
  auto_lunch_30: boolean; // auto-apply 30-min unpaid lunch on shifts > 5h
  timecard_supervisor_id: string; // who approves timecards ("" = org owner)
  /** Payroll cadence + the anchor date a biweekly/weekly cycle counts from. */
  pay_schedule: "weekly" | "biweekly" | "semimonthly" | "monthly";
  pay_anchor: string; // "YYYY-MM-DD" — start of a reference pay period

  // Payments
  payment_methods: string[];

  // Notifications (reminder engine — toggles stored now, engine wires later)
  remind_quote_followup: boolean;
  remind_invoice_due: boolean;
  remind_appointments: boolean;

  // Public inquiry splash page
  splash_headline: string;
  splash_tagline: string;
  splash_bg_url: string;
  splash_bullets: string; // one bullet per line
  splash_credentials: string; // e.g. "Licensed · Bonded · Insured · CA C-10 #…"
}

export const DEFAULT_SETTINGS: OrgSettings = {
  currency: "USD",
  timezone: "America/Los_Angeles",
  tax_number: "",
  glass_tint: "#1b9488",
  quote_expiry_days: 30,
  invoice_due_days: 14,
  quote_terms: "",
  invoice_terms: "",
  document_footer: "",
  deposit_percent: 0,
  default_labor_rate: 0,
  mileage_rate: 0.7,
  quote_playbook: "",
  employee_handbook: "",
  work_day_start: "08:00",
  work_day_end: "17:00",
  week_start: "monday",
  time_tracking_method: "start_end",
  labor_law_breaks: false,
  auto_lunch_30: false,
  timecard_supervisor_id: "",
  pay_schedule: "biweekly",
  pay_anchor: "2026-01-05", // a Monday; biweekly cycles cascade from here

  payment_methods: ["Cash", "Check", "Card", "Zelle", "Venmo", "Transfer"],
  remind_quote_followup: false,
  remind_invoice_due: false,
  remind_appointments: false,
  splash_headline: "",
  splash_tagline: "",
  splash_bg_url: "",
  splash_bullets: "",
  splash_credentials: "",
};

/** Merge stored settings over defaults so every key is always present. */
export function getOrgSettings(raw: unknown): OrgSettings {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<OrgSettings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export const CURRENCIES = [
  { code: "USD", label: "US Dollar ($)" },
  { code: "CAD", label: "Canadian Dollar ($)" },
  { code: "AUD", label: "Australian Dollar ($)" },
  { code: "GBP", label: "British Pound (£)" },
  { code: "EUR", label: "Euro (€)" },
  { code: "NZD", label: "New Zealand Dollar ($)" },
];

export const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
];
