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
  contract_terms: string;
  document_footer: string;
  deposit_percent: number;

  // Financial
  default_labor_rate: number;
  mileage_rate: number; // $ per mile (e.g. IRS standard rate)
  material_markup_percent: number; // default markup applied when importing job costs to an invoice
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
  /** Geofence auto clock-out: when a clocked-in employee leaves the spot they clocked
   *  in at by more than the radius (for a grace period), clock them out — AT the time
   *  they left, so a forgotten clock-out can't over-bill. Default on. */
  geofence_logout: boolean;
  geofence_radius_m: number; // meters from the clock-in point before auto clock-out
  /** Payroll cadence + the anchor date a biweekly/weekly cycle counts from. */
  pay_schedule: "weekly" | "biweekly" | "semimonthly" | "monthly";
  pay_anchor: string; // "YYYY-MM-DD" — start of a reference pay period

  // Payments
  payment_methods: string[];

  // Notifications (reminder engine — toggles stored now, engine wires later)
  remind_quote_followup: boolean;
  remind_invoice_due: boolean;
  remind_appointments: boolean;
  // BCC the owner (org email) on every customer-facing email — invoices, quotes,
  // contracts, portal links — so you always have a copy and can confirm it sent.
  copy_owner_on_emails: boolean;

  // Billing automation
  // When a job is finished, auto-email the draft invoice to the customer.
  // false = hold for review in the "To be invoiced" queue (the safe default);
  // true = send automatically. Always overridable per-job at the finish step.
  auto_send_invoice_on_complete: boolean;

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
  contract_terms:
    "1. Payment is due per the schedule above. 2. Any change to the scope of work will be handled by a written change order. 3. Contractor warrants workmanship for one (1) year from completion. 4. Either party may cancel in writing before work begins; deposits cover materials and scheduling already committed. 5. This agreement is governed by the laws of the state where the work is performed.",
  document_footer: "",
  deposit_percent: 0,
  default_labor_rate: 0,
  mileage_rate: 0.7,
  material_markup_percent: 25,
  quote_playbook: "",
  employee_handbook: "",
  work_day_start: "08:00",
  work_day_end: "17:00",
  week_start: "monday",
  time_tracking_method: "start_end",
  labor_law_breaks: false,
  auto_lunch_30: false,
  timecard_supervisor_id: "",
  geofence_logout: true,
  geofence_radius_m: 300,
  pay_schedule: "biweekly",
  pay_anchor: "2026-01-05", // a Monday; biweekly cycles cascade from here

  payment_methods: ["Cash", "Check", "Card", "Zelle", "Venmo", "Transfer"],
  remind_quote_followup: false,
  remind_invoice_due: false,
  remind_appointments: false,
  copy_owner_on_emails: false,
  auto_send_invoice_on_complete: false,
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
