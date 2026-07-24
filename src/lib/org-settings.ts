// Org-wide preferences stored in organizations.settings (JSONB). Centralized
// here with defaults so the app can read settings safely anywhere.

import type { Block } from "@/lib/site-blocks";

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
  /** Org-wide DEFAULT markup % for pricing price-book items — the last fallback in THE one
   *  markup rule (src/lib/pricing/markup.ts effectiveMarkupPct): customer pricing-level markup
   *  → else the item's own markup_pct when > 0 → else THIS → else 0. Exists so a net-cost
   *  catalog import (every item markup_pct = 0, e.g. CED) can't quote the company's real cost.
   *  0 = disabled — byte-identical behavior for orgs that never set it. */
  default_markup_pct: number;
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
  // (auto_lunch_30 RETIRED cn-v537: the 30-min >5h lunch is now UNCONDITIONAL — see lib/lunch-rule.ts.
  //  Old orgs may still carry the key in stored JSON; it's ignored.)
  timecard_supervisor_id: string; // who approves timecards ("" = org owner)
  /** Geofence auto clock-out: when a clocked-in employee leaves the spot they clocked
   *  in at by more than the radius (for a grace period), clock them out — AT the time
   *  they left, so a forgotten clock-out can't over-bill. Default on. */
  geofence_logout: boolean;
  geofence_radius_m: number; // meters from the clock-in point before auto clock-out
  /** Timeclock SMS reminders (the two crons: morning "no clock-in yet" nudge + the
   *  end-of-day clock-out/EOD-form reminder). Default ON; the crons skip an org that
   *  turns this off. Settings → Scheduling owns the toggle. */
  remind_timeclock: boolean;
  /** Ask the crew for job-CODE allocations on the timeclock (the clock-out breakdown's
   *  code pickers + the clock-in/switch code selects). false = codes off: entries and
   *  splits carry just the JOB, and timeclock job labels lead with customer · street
   *  address instead of the job number (the crew knows work by whose house they're at).
   *  Allocation/labeling behavior ONLY — never pay math (base pay stays clock_in/out/
   *  lunch; mileage stays its own bucket). Default true = today's behavior everywhere. */
  timeclock_job_codes: boolean;
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
  /** Show the business NAME as text (header wordmark + hero eyebrow + footer), alongside the logo.
   *  On for orgs whose logo is an emblem/mark without the name in it (so the name is actually stated
   *  on the page). Off by default — an org whose logo already contains the name isn't doubled up. */
  show_name_with_logo: boolean;
  /** Hero headline size. "l" = the original big headline; "m"/"s" dial it down. Empty headline hides
   *  the H1 entirely (no auto-fallback), so clearing the field really leaves it blank. */
  splash_headline_size: "s" | "m" | "l";
  /** Custom homepage sections — the SAME styled blocks as the page builder, rendered on the homepage
   *  (below the hero). Lets the owner build freeform content/banners on the front page. Empty = the
   *  designed template only. Sanitized on write (saveHomeBlocks) AND on read (renderReadyBlocks). */
  home_blocks: Block[];

  /** Public URL slug for this org's customer-facing estimate configurator at
   *  /estimate/<handle> (e.g. "tahoe-deck"). Empty = the configurator is off for this org.
   *  Lives in settings (not a column) so it resolves the same way lead_inbound_secret does. */
  public_handle: string;
  /** Job size (configurator/estimate total) at or above which a lead is routed to a human
   *  site inspection and never shown an instant firm price. Mirrors lead-triage's default. */
  site_inspection_threshold: number;
  /** Re-hosted project photos shown as the public portfolio/gallery (e.g. on the estimate
   *  configurator). `url` is a public storage URL owned by North — not a foreign CDN. `caption`
   *  is an optional short line shown on hover + in the lightbox (and used in the specialty
   *  showcase); it also becomes the image alt text for SEO/accessibility. */
  portfolio: { url: string; src?: string; caption?: string }[];
  /** Optional SIGNATURE-SPECIALTY showcase — an elegant, dark editorial band on the public
   *  homepage that spotlights the one thing this org most wants to sell (e.g. "Custom Lighting
   *  Design & Fabrication"). It features the first several captioned portfolio photos. Empty
   *  headline = the section is hidden, so orgs that don't set it are unaffected. */
  specialty_headline: string;
  specialty_blurb: string;
  /** Human service-area label for the public site (e.g. "Truckee & North Tahoe"). Falls back
   *  to the org's city/state. Keeps the homepage template org-agnostic. */
  service_area: string;
  /** PUBLIC address locality for the site's LocalBusiness schema — must match the Google
   *  Business Profile listing. Deliberately separate from the org record's city/state: the
   *  business-record address (invoices, payroll) is often a home base the owner does NOT want
   *  on the public web, and it must never leak there. Unset = no address in the schema at all
   *  (areaServed + geo still emit). Staff-only — not in the collaborator whitelist. */
  public_city: string;
  public_state: string;
  /** Public-site layout theme. Same data, different presentation so two orgs on the platform
   *  don't look identical: "classic" = full-bleed photo hero w/ dark overlay (the original);
   *  "bold" = saturated brand color-block hero with the photo as a framed card (contractor punch);
   *  "minimal" = light, airy, editorial hero (upscale remodel/design feel). Default "classic". */
  site_theme: "classic" | "bold" | "minimal";
  /** Instagram handle (no @) for the public site footer. Empty = no Instagram link. */
  social_instagram: string;
  /** A custom domain the org has pointed at North for its public site (e.g. "tahoedeck.com",
   *  no scheme/www). Resolved by the by-domain route so the domain serves /site content without
   *  a code change. Empty = the org uses its free <handle>.contractornorth.com subdomain. */
  custom_domain: string;
  /** The org's Google Business Profile / Google Maps place URL (paste the link straight from
   *  Google Maps). THE local-SEO anchor: it's emitted as schema.org `sameAs` + `hasMap` on the
   *  public site — the signal that binds this website to that map listing so Google treats them
   *  as one business — and any lat/lng in the URL becomes the site's `geo`. Empty = no binding. */
  google_business_url: string;
  /** Customer testimonials shown on the public site. Real quotes the org enters themselves —
   *  never seeded/fabricated. Empty hides the section. */
  reviews: { name: string; text: string; rating?: number }[];
  /** This org's own Twilio "from" number (E.164, e.g. "+15305551234") for its outbound texts,
   *  so each org sends under its OWN registered number/brand. Empty = fall back to the platform
   *  default (TWILIO_FROM_NUMBER). Critical for multi-tenant A2P compliance. */
  sms_from_number: string;
  /** External scheduling link (Calendly or similar). When set, the PUBLIC
   *  "schedule your site visit" buttons (inquiry splash + estimate configurator)
   *  open it instead of North's built-in request flow (cn-v499: flag the lead +
   *  ping the office to text time options). Empty = built-in request flow. */
  calendly_url: string;
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
  default_markup_pct: 0,
  material_buffer_percent: 10,
  quote_playbook: "",
  estimating_mode: "research",
  employee_handbook: "",
  work_day_start: "08:00",
  work_day_end: "17:00",
  week_start: "monday",
  time_tracking_method: "start_end",
  timecard_supervisor_id: "",
  geofence_logout: true,
  geofence_radius_m: 300,
  remind_timeclock: true, // matches the crons' historical "absent = on" behavior
  timeclock_job_codes: true, // codes-on = the pre-setting behavior, byte-identical
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
  show_name_with_logo: false,
  splash_headline_size: "l",
  home_blocks: [],
  public_handle: "",
  site_inspection_threshold: 20000,
  portfolio: [],
  specialty_headline: "",
  specialty_blurb: "",
  service_area: "",
  public_city: "",
  public_state: "",
  site_theme: "classic",
  social_instagram: "",
  custom_domain: "",
  google_business_url: "",
  reviews: [],
  sms_from_number: "",
  calendly_url: "",
};

/** Pull a { lat, lng } from a pasted Google Maps URL if one is present. Prefers the place
 *  marker (`!3d<lat>!4d<lng>`) over the viewport center (`@<lat>,<lng>`) — the marker is the
 *  actual business pin. Returns null when the URL carries no coordinates (e.g. a bare ?cid= link). */
export function parseGeoFromMapUrl(url: string | null | undefined): { lat: number; lng: number } | null {
  const u = String(url || "");
  const m = u.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || u.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** The scheduler's all-day work window as "HH:MM" strings, read from the RAW
 *  stored settings (not the merged defaults): the Settings form displays
 *  08:00–17:00 as its defaults, but an org that never SAVED a window keeps the
 *  scheduler's original 8 AM–4 PM block — so wiring the setting changed nothing
 *  for orgs that never touched it. One resolver, shared by the schedule writers
 *  (all-day scheduled_start/end mirror) and the calendar's "hide the time on an
 *  all-day job" sentinel, so the two can't drift. */
export function workDayWindowHm(raw: unknown): { start: string; end: string } {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<OrgSettings>;
  const hm = (v: unknown): string | null => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null);
  return { start: hm(stored.work_day_start) ?? "08:00", end: hm(stored.work_day_end) ?? "16:00" };
}

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

/**
 * An org's OWN canonical public base URL for customer-facing links (invoice/quote emails, portal).
 * Per-tenant + resolved at send time, so links follow the domain the org has configured with ZERO
 * build-time env to update — the moment their custom domain goes live, their emails point at it:
 *   1. their custom domain (etelectric369.com) if set, else
 *   2. their free {handle}.{SITES_DOMAIN} subdomain, else
 *   3. a platform fallback (NEXT_PUBLIC_SITE_URL, then the Vercel URL) for an org with neither.
 * No trailing slash. (App routes like /i/<token> resolve on the org's custom domain too.)
 */
export function orgPublicBaseUrl(settings: OrgSettings): string {
  const domain = (settings.custom_domain || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (domain) return `https://${domain}`;
  const handle = (settings.public_handle || "").trim();
  if (handle) {
    const sitesDomain = (process.env.SITES_DOMAIN || "contractornorth.com").trim();
    return `https://${handle}.${sitesDomain}`;
  }
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://contractor-north.vercel.app").replace(/\/+$/, "");
}
