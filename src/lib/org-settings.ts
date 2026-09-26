// Org-wide preferences stored in organizations.settings (JSONB). Centralized
// here with defaults so the app can read settings safely anywhere.

import type { Block } from "@/lib/site-blocks";
import { withPlace } from "@/lib/doc-place";

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
  /** Document LAYOUT knobs (column gap, density, logo size, margins, closing lines) — a nested
   *  object so ONE whitelisted key can ride the public_* RPCs (never to_jsonb). Raw here; every
   *  renderer normalizes via lib/doc-style (sanitize on read). */
  doc_style: Record<string, unknown>;
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
  /** What this company DOES, in the words a person would use: "deck builder",
   *  "electrical contractor", "plumber". Drives the estimator's opening line and the
   *  assistant's self-description. Before this existed, every org's estimator was told
   *  it worked for an electrical contractor — so a deck inspection came back priced by
   *  an electrician who'd been instructed to calculate conduit fill per NEC. Empty
   *  falls back to the neutral "contractor". */
  trade_label: string;
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
   *  turns this off. Settings → Scheduling owns the toggle. A stored ON is only a CHOICE: until
   *  the org can text (lib/sms-readiness) the crons skip it and count the skip, and Settings shows
   *  the option as not active. */
  remind_timeclock: boolean;
  /** Ask the crew for job CODES on the timeclock (the clock-in/switch code selects). false =
   *  codes off: entries carry just the JOB, and timeclock job labels lead with customer ·
   *  street address instead of the job number (the crew knows work by whose house they're at).
   *  Labeling behavior ONLY — never pay math (base pay stays clock_in/out/
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
  /** The org's Venmo username (no @). Pay now's Venmo chip shows its QR with the amount filled. */
  venmo_handle: string;
  /**
   * SURCHARGE ADDED TO A CARD PAYMENT, IN PERCENT. 0 = off, and 0 is the default, so an org that
   * never sets it behaves exactly as it did before this existed. It is a number, not a switch:
   * "2.5" means the card door charges the balance plus 2.5% of it, stated on the invoice page
   * before the customer taps, as a separate "Card processing fee" line inside Stripe Checkout.
   *
   * THERE IS NO SETTINGS SCREEN FOR THIS ON PURPOSE. Charging it is a business decision with real
   * rules attached, and the rules are the reason the number is documented here instead of behind
   * a tick box nobody reads:
   *
   *  - SURCHARGING IS LEGAL WHERE THE COMPANY WORKS. California and Nevada both allow a credit
   *    card surcharge. Some other states do not, so an org outside those two has to check its own
   *    before setting this.
   *  - NOT ON DEBIT, NOT ON PREPAID. Federal law (Durbin) forbids surcharging a debit or prepaid
   *    card, full stop, no matter what the state allows.
   *  - AND A HOSTED CHECKOUT PAGE CANNOT TELL THEM APART BEFORE IT CHARGES. Stripe returns the
   *    funding type on the charge, AFTER the money moves. So a flat surcharge on a hosted page
   *    will land on some debit cards. That is the single biggest reason this ships off: it is not
   *    a bug to fix in code, it is a decision about who you are willing to refund the fee to.
   *  - THE NETWORKS CAP IT AND WANT TO BE TOLD. Visa and Mastercard both require written notice
   *    (30 days) to the network AND to the processor before the first surcharged transaction, and
   *    both cap the amount. CARD_FEE_MAX_PCT below is the ceiling this app will honor.
   *  - AND IT MAY NEVER EXCEED THE ACTUAL COST OF ACCEPTANCE. Every rule above agrees on this one:
   *    a surcharge recovers what the card cost you, it is not margin. At 2.9% + 30c, a $1,875.98
   *    invoice costs about $54.70 to accept, which is 2.92% — so anything above roughly 3 is
   *    already charging the customer more than the card cost, and that is the line.
   *
   * The honest alternative, and the one that is actually switched ON in this build, is the bank
   * transfer door beside the card door on the invoice page: same money, no fee to the customer,
   * and about $10 instead of about $231 on a day like 2026-09-20.
   */
  card_fee_percent: number;

  /**
   * THE BANK TRANSFER DOOR ON PAY NOW, AND WHY IT IS OFF UNTIL HE SAYS OTHERWISE.
   *
   * A card settles inside Stripe Checkout and arrives as checkout.session.completed with
   * payment_status "paid", which the webhook books. ACH does not. It arrives as completed and
   * UNPAID - correctly booked as nothing, because the money is days away and can still be refused
   * - and then, when it clears, as `checkout.session.async_payment_succeeded`. That event is NOT
   * on a connected-accounts webhook destination by default.
   *
   * So a bank button on an account without those events is a door that takes a customer's money
   * and never closes the invoice: the customer pays, the office sees nothing, and the next
   * reminder chases a man who has already paid. Three reviewers called it the same way.
   *
   * Erik turns this on AFTER adding `checkout.session.async_payment_succeeded` and
   * `checkout.session.async_payment_failed` to the connected-accounts destination in Stripe, and
   * after confirming ACH is switched on for the account at all. Same shape as the Tap to Pay
   * entitlement: the capability lives somewhere this app cannot read, so a person confirms it.
   *
   * AND NOT BEFORE 0338 IS APPLIED (audit v994 BK1-BK3, Erik: stays OFF until they ship). Since
   * then this switch is enforced where the money starts (/api/pay refuses ?method=bank when it is
   * off, not only /i hiding the button), a debit on its way is marked pending
   * (pending_bank_transfers) so /i, /api/pay and the reminders do not invite a second payment,
   * and a cleared debit is booked as 'ach', not 'card'.
   */
  bank_transfer_enabled: boolean;

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
  /** Show document numbers (J-036…) in list rows and panels. Erik navigates by number,
   *  Chris by name — so it's a per-org display switch, not a data change: numbers keep
   *  minting either way and stay visible on detail pages/prints. */
  show_doc_numbers: boolean;
  /** Human service-area label for the public site (e.g. "Truckee & North Tahoe"). Falls back
   *  to the org's city/state. Keeps the homepage template org-agnostic. */
  service_area: string;
  /** PUBLIC address locality for the site's LocalBusiness schema — must match the Google
   *  Business Profile listing. Deliberately separate from the org record's city/state: the
   *  business-record address (invoices, payroll) is often a home base the owner does NOT want
   *  on the public web, and it must never leak there. Unset = no address in the schema at all
   *  (areaServed + geo still emit). Staff-only — not in the collaborator whitelist. */
  /** PUBLICATION IS THE BUSINESS'S CALL, not the platform's. Plenty of contractors have a shop
   *  or a yard and want a full address on the web and in their Google listing; plenty work out of
   *  a truck and must not publish where they sleep. So the rule is not "never publish an address"
   *  — it is "publish EXACTLY what the owner typed into these fields, and nothing else."
   *
   *  These are deliberately SEPARATE from organizations.address_line1/city/state/zip, which are
   *  the mailing/billing address used on invoices and internally. That record is never a source
   *  for anything public, at any level of detail — that separation is the actual guarantee, and
   *  it holds whether the owner publishes a full street address or nothing at all. */
  public_address: string;
  public_city: string;
  public_state: string;
  public_zip: string;
  /** Public-site layout theme. Same data, different presentation so two orgs on the platform
   *  don't look identical: "classic" = full-bleed photo hero w/ dark overlay (the original);
   *  "bold" = saturated brand color-block hero with the photo as a framed card (contractor punch);
   *  "minimal" = light, airy, editorial hero (upscale remodel/design feel). Default "classic". */
  site_theme: "classic" | "bold" | "minimal";
  /** The public SITE's accent color (#rrggbb) — the one hue every band and button leans on.
   *  Empty = derived from glass_tint (accentHex), the pre-studio behavior. A separate key so a
   *  site redesign can restyle the SITE without recoloring the office's app skin. */
  site_accent: string;
  /** Per-text color overrides from the on-page editor's palette; "" = the theme's color. */
  splash_headline_color: string;
  splash_tagline_color: string;
  service_area_color: string;
  /** The public site's HEADING typeface preset (site-fonts.tsx) — headings only, body stays the
   *  system stack. "default" = the app's Geist, i.e. render nothing extra. */
  site_font: "default" | "serif" | "grotesk" | "soft" | "condensed";
  /** The BUSINESS NAME's typeface everywhere it renders (top bar, hero, footer) — the wordmark
   *  lever, separate from the headings. "default" = inherit. */
  brand_font: "default" | "serif" | "grotesk" | "soft" | "condensed";
  /** WHERE the hero's text sits over the photo (classic framing only): left (the original),
   *  center, or right. The two-column framings ignore it. */
  hero_align: "left" | "center" | "right";
  /** HOW the hero's text sits on the photo (classic only): open (text straight on the image —
   *  the original), panel (a translucent dark card behind the text), band (a solid strip across
   *  the bottom with the photo breathing above it), spread (the text PIECES separate across the
   *  photo — name+area top-left, headline lower-left, tagline+buttons lower-right; Erik:
   *  "those text boxes overlaying the image ... separated horizontally"). */
  hero_style: "open" | "panel" | "band" | "spread";
  /** Free nudge of the hero text block over the photo, in percent of the block's own size —
   *  the drag/arrow lever ("move it with the mouse"). Clamped ±40; 0/0 = the framing's spot. */
  hero_dx: number;
  hero_dy: number;
  /** The hero text BOX's width as % of the hero (30-100); 0 = the framing's default width.
   *  The resize-handle lever. */
  hero_w: number;
  /** Per-piece nudges/widths for the Corners (spread) layout — each corner piece is its own
   *  movable unit (Erik: "still cant resize or any of that jazz" on spread). Same clamps as
   *  the hero box: dx/dy ±40 (% of the piece), w 30-100 (% of the row) with 0 = default. */
  /** Text zoom per movable unit, as % (50-200); 0 = default size. The corner-handle lever —
   *  Erik: "the resize works horizontally but not vertically". Rendered as transform scale. */
  hero_scale: number;
  spread_area_scale: number;
  spread_head_scale: number;
  spread_tag_scale: number;
  spread_area_dx: number;
  spread_area_dy: number;
  spread_head_dx: number;
  spread_head_dy: number;
  spread_head_w: number;
  spread_tag_dx: number;
  spread_tag_dy: number;
  spread_tag_w: number;
  /** Whole-page vertical rhythm: scoped rescale of the section paddings (site-fonts.tsx emits
   *  the overrides). "default" = untouched; per-section spacing is style.pad on section blocks. */
  site_density: "default" | "compact" | "airy";
  /** The estimate buttons' label, everywhere they render (header, hero, bands, footer).
   *  Empty = the built-in wording ("Get your free instant estimate" / "Request a free estimate"
   *  / "Get an estimate" for the compact spots). */
  estimate_cta_label: string;
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
  /** WHERE "Review us on Google" ACTUALLY SENDS PEOPLE. The Business Profile link above is a
   *  PLACE link — it opens the listing, and the customer still has to hunt for the review box.
   *  Google gives owners a direct review form link (Business Profile → Ask for reviews), which
   *  looks like https://g.page/r/<code>/review. Empty = fall back to the profile link, which is
   *  what shipped before this existed. */
  google_review_url: string;
  /** A SERVICE-AREA BUSINESS has no storefront: it serves a region and deliberately does not
   *  publish a pin. Google supports this directly (the listing hides the address), and when an
   *  owner has chosen it, asserting precise `geo` coordinates in our structured data contradicts
   *  their own listing — and usually publishes wherever the pin USED to be, which for a one-truck
   *  operator is their house. With this on we publish areaServed and no coordinates. */
  service_area_business: boolean;
  /** THE TOWNS GOOGLE READS, when they differ from the line on the hero. `service_area` is
   *  DESIGN — a tuned eyebrow with a length someone chose. Structured data wants the real list,
   *  and a service-area business's site should name the same places its Google listing does.
   *  Empty = use the display line, which is what shipped before this existed. */
  service_area_seo: string;
  /** Customer testimonials shown on the public site. Real quotes the org enters themselves —
   *  never seeded/fabricated. Empty hides the section. */
  reviews: { name: string; text: string; rating?: number }[];
  /** This org's own Twilio "from" number (E.164, e.g. "+15305551234") for its outbound texts,
   *  so each org sends under its OWN registered number/brand. Empty = fall back to the platform
   *  default (the messaging service, else TWILIO_FROM_NUMBER). Critical for multi-tenant A2P
   *  compliance. Typed on Settings, Customers, Texting; one of the pieces lib/sms-readiness checks. */
  sms_from_number: string;
  /** External scheduling link (Calendly or similar). When set, the PUBLIC
   *  "schedule your site visit" buttons (inquiry splash + estimate configurator)
   *  open it instead of North's built-in request flow (cn-v499: flag the lead +
   *  ping the office to text time options). Empty = built-in request flow. */
  calendly_url: string;
  /** Whether office staff (admin and office roles) see the owner's "Left For You" card on
   *  /analytics (0286). On by default (Erik 2026-09-24: "office staff should see mine (optional
   *  toggle)"). ONLY THE OWNER may change it: the dedicated setter checks the role, updateOrgSettings
   *  strips the key, and the guard_owner_money_visibility trigger refuses anyone else at the DB.
   *  Sanitized on read: anything but a real `false` reads as on. */
  office_sees_owner_money: boolean;
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
  doc_style: {},
  deposit_percent: 0,
  doc_prefixes: { job: "J-", quote: "Q-", invoice: "INV-", wo: "WO-", co: "CO-", po: "PO-", contract: "C-" },
  default_labor_rate: 0,
  mileage_rate: 0.7,
  material_markup_percent: 25,
  default_markup_pct: 0,
  material_buffer_percent: 10,
  quote_playbook: "",
  estimating_mode: "research",
  trade_label: "",
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
  venmo_handle: "",
  card_fee_percent: 0, // off — see the field's comment for what turning it on actually commits you to
  bank_transfer_enabled: false, // off until the two async Stripe events are subscribed — see the field's comment
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
  show_doc_numbers: true,
  public_address: "",
  public_city: "",
  public_state: "",
  public_zip: "",
  site_theme: "classic",
  site_accent: "",
  site_font: "default",
  brand_font: "default",
  site_density: "default",
  hero_align: "left",
  hero_style: "open",
  splash_headline_color: "",
  splash_tagline_color: "",
  service_area_color: "",
  hero_dx: 0,
  hero_dy: 0,
  hero_w: 0,
  hero_scale: 0,
  spread_area_scale: 0,
  spread_head_scale: 0,
  spread_tag_scale: 0,
  spread_area_dx: 0,
  spread_area_dy: 0,
  spread_head_dx: 0,
  spread_head_dy: 0,
  spread_head_w: 0,
  spread_tag_dx: 0,
  spread_tag_dy: 0,
  spread_tag_w: 0,
  estimate_cta_label: "",
  social_instagram: "",
  custom_domain: "",
  google_business_url: "",
  google_review_url: "",
  service_area_business: false,
  service_area_seo: "",
  reviews: [],
  sms_from_number: "",
  calendly_url: "",
  office_sees_owner_money: true,
};

/** Pull a { lat, lng } from a pasted Google Maps URL if one is present. Prefers the place
 *  marker (`!3d<lat>!4d<lng>`) over the viewport center (`@<lat>,<lng>`) — the marker is the
 *  actual business pin. Returns null when the URL carries no coordinates (e.g. a bare ?cid= link). */
/** areaServed for structured data: a real LIST of place names, not one display string.
 *  Prefers the SEO field, falls back to the hero line; splits on the separators people actually
 *  type (·, |, comma, semicolon, slash) and drops the empties. One name returns a plain string,
 *  which is what schema.org expects for a single area. */
export function areaServedValue(settings: {
  service_area?: string | null;
  service_area_seo?: string | null;
}): string | string[] | null {
  const raw = (settings.service_area_seo || "").trim() || (settings.service_area || "").trim();
  if (!raw) return null;
  const parts = raw
    .split(/[·|,;/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return raw;
  return parts;
}

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

/**
 * Grade a pasted Google Business Profile link — because the settings form used to show a green
 * "Linked to your Google Business Profile" check for ANY non-empty string, and ET Electric's field
 * held a personalized Google SEARCH url:
 *   https://www.google.com/search?q=ET+Electric&hl=en&mat=<session-token>&authuser=1&dlnr=1
 * That matches neither coordinate pattern, so parseGeoFromMapUrl returned null and the homepage
 * silently shipped no `geo` block at all — while Tahoe Deck, on the identical code, shipped one.
 * The site→listing binding the whole local-SEO story rests on was simply not being made, and the
 * green check said it was. A `search?` URL also can't resolve to a place entity for anyone, and it
 * is a live customer-facing link in the footer, carrying Erik's own session token.
 *
 * Returns the state so the form can say which of these it is instead of claiming success.
 */
export type MapUrlVerdict = "empty" | "ok" | "no-coords" | "personalized-search" | "not-google";

export function classifyMapUrl(url: string | null | undefined): MapUrlVerdict {
  const u = String(url ?? "").trim();
  if (!u) return "empty";
  let host: string;
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    return "not-google";
  }
  const isGoogle = /(^|\.)google\.[a-z.]+$/.test(host) || host === "maps.app.goo.gl" || host === "goo.gl";
  if (!isGoogle) return "not-google";
  // A /search? URL is never a place link, however many params it carries.
  if (/\/search\b/.test(u) || /[?&]q=/.test(u)) return "personalized-search";
  if (parseGeoFromMapUrl(u)) return "ok";
  // A share short-link (maps.app.goo.gl) or a bare ?cid= carries no coordinates in the string but
  // IS a real place link — it resolves server-side at Google. Valid, just without a geo block.
  return "no-coords";
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
  /* FROM DEFAULTS, NOT FROM LITERALS.
     These were hardcoded "08:00"/"16:00" while DEFAULT_SETTINGS says 08:00/17:00 — so an org that never
     touched the setting read 5pm on its own Settings screen and got 4pm from the scheduler. One
     question, two answers, and the screen was the one telling the truth about intent.
     Found while chasing Erik's "my company settings are 9-5 not 8-4": his org HAS the setting, and
     the mismatch was waiting for every org that doesn't. */
  return {
    start: hm(stored.work_day_start) ?? DEFAULT_SETTINGS.work_day_start,
    end: hm(stored.work_day_end) ?? DEFAULT_SETTINGS.work_day_end,
  };
}

/** Merge stored settings over defaults so every key is always present. */
/**
 * IS THIS A TIMEZONE POSTGRES AND Intl BOTH KNOW?
 *
 * Asked of the runtime rather than matched against a list, because a hand-kept list of IANA zone
 * names is wrong the moment one is renamed.
 */
function isValidTz(tz: unknown): boolean {
  const v = String(tz ?? "").trim();
  if (!v) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

export function getOrgSettings(raw: unknown): OrgSettings {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<OrgSettings>;
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // doc_prefixes is a nested map — fill any missing per-type prefix from the defaults so a
  // partially-saved map still resolves every doc type.
  merged.doc_prefixes = { ...DEFAULT_SETTINGS.doc_prefixes, ...(merged.doc_prefixes ?? {}) };
  // ── A BAD TIMEZONE IS A CROSS-TENANT KILL SWITCH (audit 6) ────────────────────────────────
  //
  // Every night-time engine — recurring invoice generation, customer reminders, the end-of-day
  // texts — loops ALL orgs in one request and formats each org's "today" in its own zone. One
  // unparseable value throws inside that loop, and the loop dies where it stands: every org after
  // the bad one silently gets no invoices and no reminders. One tenant, three tenants broken.
  //
  // SANITIZED ON READ, not on write, which is this project's own doctrine and the only version
  // that actually closes it: settings/actions.ts has TWO writers, and the second (updateOrgSettings)
  // merges a caller-supplied patch and strips only custom_domain / public_handle /
  // lead_inbound_secret — so a write-side whitelist on the first would have left the easier bypass
  // wide open. Fixing it here also heals any row already poisoned, and covers every writer added
  // later without anyone remembering to.
  if (!isValidTz(merged.timezone)) merged.timezone = DEFAULT_SETTINGS.timezone;
  // SANITIZE THE LEVER FIELDS ON READ (same doctrine as the timezone heal above): the studio
  // write path clamps via site-doc, but settings has other writers — a hostile or drifted
  // jsonb value must not reach the renderer's inline styles. Total functions, 0 = default.
  const lever = (v: unknown, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
    return n === 0 ? 0 : Math.min(hi, Math.max(lo, n));
  };
  for (const k of ["hero_dx", "hero_dy", "spread_area_dx", "spread_area_dy", "spread_head_dx", "spread_head_dy", "spread_tag_dx", "spread_tag_dy"] as const) {
    merged[k] = lever(merged[k], -400, 400);
  }
  for (const k of ["hero_w", "spread_head_w", "spread_tag_w"] as const) merged[k] = lever(merged[k], 30, 100);
  for (const k of ["hero_scale", "spread_area_scale", "spread_head_scale", "spread_tag_scale"] as const) {
    merged[k] = lever(merged[k], 50, 200);
  }
  {
    // Only a Google-owned URL belongs on a "Review us on Google" button — anything else is
    // either a mistake or a way to point a trust CTA somewhere else entirely.
    const rv = typeof merged.google_review_url === "string" ? merged.google_review_url.trim() : "";
    merged.google_review_url = /^https:\/\/([a-z0-9-]+\.)*(google\.com|g\.page|goo\.gl)\//i.test(rv) ? rv : "";
  }
  for (const k of ["site_accent", "splash_headline_color", "splash_tagline_color", "service_area_color"] as const) {
    const v = typeof merged[k] === "string" ? merged[k].trim() : "";
    merged[k] = /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "";
  }
  {
    // THE SURCHARGE IS MONEY, SO IT GETS THE SAME SANITIZE-ON-READ THE TIMEZONE GETS. There is no
    // settings screen for card_fee_percent, which means the only way a value gets in there is a
    // hand-edit of the jsonb — exactly the write path with no validation in front of it. A stored
    // "30", or a string, or a negative, must never reach a customer's card. Clamped to the network
    // ceiling here, once, so every reader (the pay route AND the invoice page) agrees by
    // construction instead of each remembering to clamp.
    // typeof, not Number(): coercion would read `true` as 1% and the string "3" as 3%, and a
    // surcharge is not a thing to infer from a value that was never a number.
    const n = merged.card_fee_percent;
    merged.card_fee_percent =
      typeof n === "number" && Number.isFinite(n) && n > 0
        ? Math.min(CARD_FEE_MAX_PCT, Math.round(n * 100) / 100)
        : 0;
    // Same treatment, same reason: there is no settings screen for this yet either, so a stored
    // "true" or 1 must not read as a door being open. A payment door opens on a boolean somebody
    // meant, or it stays shut.
    merged.bank_transfer_enabled = merged.bank_transfer_enabled === true;
  }
  // The owner's one visibility switch (0286). Normalized on read, the doc_style lesson: a stored
  // "false" string or a stray 0 must not quietly hide the card, so only a real boolean false turns
  // it off, and a missing key reads as the default, on.
  merged.office_sees_owner_money = merged.office_sees_owner_money !== false;
  return merged;
}

// ── PAY NOW: THE TWO DOORS, AND THE FEE THAT IS BUILT BUT SHUT ────────────────────────────────
//
// These live here, beside the setting they read, because BOTH ends of the payment need the same
// answer and they run in different places: /api/pay/[token] builds the Stripe session on the
// server, and /i/[token] prints the amount the customer is about to be charged. Two copies of
// "what does the card door cost" is how a page promises one number and a checkout charges
// another, which is the precise thing Andrew's note asked us not to do ("Transparency, clearly
// visible"). One function, both callers, no drift.

/**
 * The most this app will ever add to a card charge, whatever the stored setting says.
 *
 * 3 is not a taste call. Visa's surcharge cap is 3% and Mastercard's is 4%, so 3 is the number
 * that is inside both rails at once; and at Stripe's 2.9% + 30c a surcharge above ~3% is already
 * more than the card actually cost to accept, which every surcharge rule forbids. A stored 15 is
 * a typo or a hostile write, not a decision, and it gets clamped rather than honored.
 */
export const CARD_FEE_MAX_PCT = 3;

/**
 * THE MASTER SHUTOFF, AND THE TWO THINGS THAT HAVE TO BE TRUE BEFORE IT CAN FLIP (2026-09-20).
 *
 * The fee is fully built below and in both doors. It is held shut by this one constant because
 * charging it TODAY would break money in two places this build does not own:
 *
 *  1. THE WEBHOOK CREDITS THE STRIPE AMOUNT, NOT THE BALANCE. api/stripe/webhook/route.ts books
 *     `(session.amount_total ?? 0) / 100` as the payment. amount_total includes the fee line, so a
 *     $1,875.98 invoice paid with a 3% fee would be credited $1,932.26, recalc would read it as
 *     overpaid by $56.28, and the office would get an "Overpaid — action needed" push for money
 *     that was never on the invoice. The fee is the PROCESSOR'S money passing through; the invoice
 *     must be credited by its own balance. Both doors already stamp `invoice_amount` into session
 *     and payment-intent metadata so that fix is a one-line read.
 *  2. THE PUBLIC INVOICE PAGE CANNOT SEE THE SETTING. public_invoice()'s org projection (migration
 *     0247) does not carry card_fee_percent, so /i/[token] reads 0 and would print the bare
 *     balance on a button that charges more. A surcharge the customer is not shown before the tap
 *     is the opposite of what was asked for.
 *
 * Flip this to true in the SAME change that clears both, and the setting starts working with no
 * other edit. Until then a non-zero card_fee_percent is REFUSED OUT LOUD (see cardFeeDecision) —
 * never silently ignored, and never silently charged.
 */
export const CARD_FEE_READY = false;

export type PayMethod = "card" | "bank";

/**
 * Which door the customer picked, from `?method=`.
 *
 * ANYTHING THAT IS NOT EXACTLY "bank" IS A CARD. Every invoice email ever sent carries a bare
 * /api/pay/<token> with no method on it, and those links live in inboxes forever — so the absent,
 * the empty, the misspelled and the hostile all have to land on the behavior that link already
 * had. Card is not a preference here, it is backward compatibility.
 */
export function parsePayMethod(raw: string | null | undefined): PayMethod {
  return String(raw ?? "").trim().toLowerCase() === "bank" ? "bank" : "card";
}

/** THE one place a Pay link is spelled. Card keeps the exact URL it has always had (no query at
 *  all) so nothing about an existing emailed link changes; bank is the same route plus a method. */
export function payUrl(token: string, method: PayMethod): string {
  const t = encodeURIComponent(token);
  return method === "bank" ? `/api/pay/${t}?method=bank` : `/api/pay/${t}`;
}

/** "2.5" not "2.50", "3" not "3.00" — a percent a person would say out loud. */
export function feePctLabel(pct: number): string {
  const n = Number.isFinite(pct) ? Math.round(pct * 100) / 100 : 0;
  return String(n);
}

/**
 * The surcharge in dollars, rounded to the cent Stripe will actually charge.
 *
 * Done in cents on purpose: balance * pct is already the fee in cents (a percent of dollars), so
 * one Math.round lands on the integer Stripe wants and nothing downstream has to re-round a float
 * and disagree by a penny with the number printed on the page.
 */
export function cardFeeAmount(balance: number, pct: number): number {
  const b = Number(balance);
  const p = Number(pct);
  if (!Number.isFinite(b) || !Number.isFinite(p) || b <= 0 || p <= 0) return 0;
  return Math.round(b * Math.min(CARD_FEE_MAX_PCT, p)) / 100;
}

export type CardFeeDecision = {
  /** the percent actually being charged (0 when off, clamped, or refused) */
  pct: number;
  /** dollars added on top of the balance, already rounded to the cent */
  fee: number;
  /** what the CARD door charges: balance + fee. Equals the balance when the fee is 0. */
  cardTotal: number;
  /** the invoice's own balance — what the invoice gets credited, fee or no fee */
  invoiceAmount: number;
  /** set only when a fee WAS configured and we would not charge it, in words for the ops log */
  refused: string | null;
};

/**
 * THE WHOLE CARD-DOOR PRICE, DECIDED ONCE.
 *
 * `ready` is a parameter rather than a straight read of CARD_FEE_READY so the arithmetic that
 * runs the day the flag flips is provable today — the tests drive both sides of the gate. No
 * caller passes it; the default IS the flag.
 */
export function cardFeeDecision(
  balance: number,
  pct: number,
  ready: boolean = CARD_FEE_READY,
): CardFeeDecision {
  const b = Number.isFinite(Number(balance)) ? Math.max(0, Math.round(Number(balance) * 100) / 100) : 0;
  const wanted = Number.isFinite(Number(pct)) ? Math.min(CARD_FEE_MAX_PCT, Math.max(0, Number(pct))) : 0;
  const off = { pct: 0, fee: 0, cardTotal: b, invoiceAmount: b, refused: null as string | null };
  if (wanted <= 0) return off;
  if (!ready) {
    return {
      ...off,
      refused:
        `card_fee_percent is set to ${feePctLabel(wanted)} but the card fee is held shut ` +
        `(CARD_FEE_READY is false): the payment webhook still credits the invoice by Stripe's ` +
        `charge amount, and public_invoice() does not carry card_fee_percent, so the fee would ` +
        `over-credit the invoice and would not be shown before the tap. Charged the balance only.`,
    };
  }
  const fee = cardFeeAmount(b, wanted);
  return {
    pct: wanted,
    fee,
    cardTotal: Math.round((b + fee) * 100) / 100,
    invoiceAmount: b,
    refused: null,
  };
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
/** The public SITE's one accent: the studio's validated pick when set, else the app-tint
 *  derivation. Total over hostile jsonb — a stored non-string must not 500 the public site. */
export function siteAccentHex(s: OrgSettings): string {
  const a = typeof s.site_accent === "string" ? s.site_accent.trim() : "";
  return /^#[0-9a-f]{6}$/i.test(a) ? a : accentHex(s.glass_tint);
}

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
/**
 * A customer-facing document URL on the org's OWN domain — "https://etelectricity.com/i/<token>".
 *
 * THE RULE: every URL that lands in a customer's hand comes from here. It was written four
 * separate times and three were wrong — invoice EMAIL used orgPublicBaseUrl while the invoice
 * TEXT, quotes, contracts and the portal used NEXT_PUBLIC_SITE_URL, so the same document sent two
 * ways pointed at two different domains and only one of them was the business the customer hired.
 * Four more client files used `window.location.origin`, which is worse than wrong because it is
 * non-deterministic: the customer's link became whatever host the STAFF MEMBER was signed in on.
 *
 * Pure on purpose — it takes settings the caller already has, so it costs no query and can be
 * tested without a database.
 */
export type DocPrefix = "i" | "q" | "c" | "portal" | "pick" | "inquire" | "estimate";

export function orgDocUrl(settings: OrgSettings, prefix: DocPrefix, token: string, place?: string | null): string {
  // `place` (docPlace in lib/doc-place) rides on the end as a slug the page ignores: /i/<token>/235-timbercreek.
  return withPlace(`${orgPublicBaseUrl(settings)}/${prefix}/${token}`, place);
}

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
