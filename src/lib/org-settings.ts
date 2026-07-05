// Org-wide preferences stored in organizations.settings (JSONB). Centralized
// here with defaults so the app can read settings safely anywhere.

export interface OrgSettings {
  // Company
  currency: string; // ISO 4217, e.g. "USD"
  timezone: string; // IANA, e.g. "America/Los_Angeles"
  tax_number: string; // EIN / tax #
  /** The ONE org accent color (sea-glass tint). Drives the whole app AND documents —
   *  there is no separate company brand_color anymore. Pick it in Settings. */
  glass_tint: string; // hex, e.g. "#1b9488" (sea-glass teal)

  // Documents
  quote_expiry_days: number;
  invoice_due_days: number;
  quote_terms: string;
  invoice_terms: string;
  contract_terms: string;
  document_footer: string;
  deposit_percent: number;
  /** Per-org document number PREFIX, keyed by the trigger's doc_type ("job","quote",
   *  "invoice","wo","co","po","contract"). The counter/next-number lives server-side in
   *  doc_counters; next_doc_number() reads these prefixes (falling back to the built-in
   *  default). Missing = use the built-in default (J-, Q-, INV-, …). */
  doc_prefixes: Record<string, string>;

  // Financial
  default_labor_rate: number;
  mileage_rate: number; // $ per mile (e.g. IRS standard rate)
  material_markup_percent: number; // default markup applied when importing job costs to an invoice
  /** Safety buffer (%) the AI adds to RESEARCHED/ESTIMATED material prices so an estimate holds up. */
  material_buffer_percent: number;
  /** Free-text "how we quote" playbook injected into AI quote drafts + assistant. */
  quote_playbook: string;
  /** How this company prices work, which base estimating method Nort uses:
   *  "research" = live web-searched material prices + trade-calculated quantities (the
   *  electrical/trade default); "catalog" = bid from the company's OWN price list + saved
   *  kits at their own prices, quantities from the customer's measurements (deck/carpentry
   *  & any preset-price shop). The quote_playbook holds the company's specific scoping script. */
  estimating_mode: "research" | "catalog";
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
  /** Weather widget location: "device" = each user's GPS (the crew is mobile); "business" = the org's
   *  configured address, always. EXPLICIT choice — no silent fallback between them (that masking, where
   *  a GPS miss quietly showed the shop's city as if it were yours, was the root weather bug). */
  weather_source: "device" | "business";
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

  /** Public URL slug for this org's customer-facing estimate configurator at
   *  /estimate/<handle> (e.g. "tahoe-deck"). Empty = the configurator is off for this org.
   *  Lives in settings (not a column) so it resolves the same way lead_inbound_secret does. */
  public_handle: string;
  /** Job size (configurator/estimate total) at or above which a lead is routed to a human
   *  site inspection and never shown an instant firm price. Mirrors lead-triage's default. */
  site_inspection_threshold: number;
  /** Re-hosted project photos shown as the public portfolio/gallery (e.g. on the estimate
   *  configurator). `url` is a public storage URL owned by North — not a foreign CDN. */
  portfolio: { url: string; src?: string }[];
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
  doc_prefixes: { job: "J-", quote: "Q-", invoice: "INV-", wo: "WO-", co: "CO-", po: "PO-", contract: "C-" },
  default_labor_rate: 0,
  mileage_rate: 0.7,
  material_markup_percent: 25,
  material_buffer_percent: 10,
  quote_playbook: "",
  estimating_mode: "research",
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
  weather_source: "device", // default: each user's own location (the crew is mobile)
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
  public_handle: "",
  site_inspection_threshold: 20000,
  portfolio: [],
};

/** Merge stored settings over defaults so every key is always present. */
export function getOrgSettings(raw: unknown): OrgSettings {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<OrgSettings>;
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // doc_prefixes is a nested map — fill any missing per-type prefix from the defaults so a
  // partially-saved map still resolves every doc type.
  merged.doc_prefixes = { ...DEFAULT_SETTINGS.doc_prefixes, ...(merged.doc_prefixes ?? {}) };
  return merged;
}

/** The auto-numbered document types, in display order. `key` is the doc_counters/settings
 *  doc_type; `fallback` mirrors the built-in prefix the DB trigger passes. Single source of
 *  truth for the numbering settings panel. */
export const DOC_NUMBER_TYPES: { key: string; label: string; fallback: string }[] = [
  { key: "job", label: "Jobs", fallback: "J-" },
  { key: "quote", label: "Estimates", fallback: "Q-" },
  { key: "invoice", label: "Invoices", fallback: "INV-" },
  { key: "wo", label: "Work orders", fallback: "WO-" },
  { key: "co", label: "Change orders", fallback: "CO-" },
  { key: "po", label: "Purchase orders", fallback: "PO-" },
  { key: "contract", label: "Contracts", fallback: "C-" },
];

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

/**
 * The single accent color for DOCUMENTS + public pages (quotes, invoices, contracts,
 * portal, inquiry, business card), derived from the org's sea-glass tint — the same
 * darkened "ink" the app chrome uses (--glass-ink). There is no separate brand_color
 * anymore: the tint is the brand. Returns a hex string.
 */
export function accentHex(glassTintHex?: string | null): string {
  const h = (glassTintHex || DEFAULT_SETTINGS.glass_tint).replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const [r, g, b] =
    !Number.isFinite(n) || full.length !== 6 ? [27, 148, 136] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const d = (c: number) => Math.round(c * 0.62).toString(16).padStart(2, "0");
  return `#${d(r)}${d(g)}${d(b)}`;
}
