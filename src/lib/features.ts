/**
 * THE SWITCH BOARD (0352). One on/off key per feature at organizations.settings.features, written
 * only by set_org_feature (the owner), by create_organization at sign-up, and by a migration (the
 * one-time backfill, 0355). Every other settings writer carries the stored map through unchanged
 * (the pin_org_features trigger), and updateOrgSettings refuses the key in plain words.
 *
 * A switch HIDES DOORS ONLY. It never deletes a row, never changes a number, and a record opened by
 * a link or a search still opens, with the Off line on top (components/feature-off-line.tsx). Every
 * feature is on every plan: there is deliberately no plan or tier anywhere here.
 *
 * READ RULE: a missing or non-boolean key is ON (what every company has today), so this code is
 * byte-identical for a company with no stored map. One exception: a missing job_codes falls back to
 * the old Scheduling checkbox (settings.timeclock_job_codes). Trade presets apply only when a map is
 * WRITTEN (sign-up, the backfill), so changing a preset later never flips an existing company.
 */
import { TRADE_ORDER } from "@/lib/trade-codes";

/** MUST equal public.feature_keys() (0352). features.test.ts and the DB suite both check it. */
export const FEATURE_KEYS = [
  "leads", "referrals",
  "estimates", "kits",
  "contracts",
  "purchase_orders",
  "shop_stock",
  "crew_payroll", "daily_reports", "crew_board",
  "job_codes",
  "permits",
  "panel_map",
  "customer_portal",
  "recurring_billing",
  "sales_tax",
  "licenses", "safety_log",
  "website", "site_chat",
  "nort",
  "calculators",
  "todo_extras",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureMap = Record<FeatureKey, boolean>;
export type FeatureDef = { key: FeatureKey; label: string; line: string; parent?: FeatureKey };

// Labels are Title Case (they sit on clickable rows). Every line is traced to what the app does
// today (the onboarding truth law): Licenses promises no renewal alerts, because none exist yet.
export const FEATURES: readonly FeatureDef[] = [
  { key: "leads", label: "Leads & Walk-Throughs", line: "Leads, walk-throughs, your lead link and QR. Requests from your website still reach you when this is off." },
  { key: "referrals", parent: "leads", label: "Track Referrals", line: "Ask who sent each lead and keep a tally." },
  { key: "estimates", label: "Estimates", line: "Estimates, change orders and work orders." },
  { key: "kits", parent: "estimates", label: "Kits & Sizing By Sq Ft", line: "Price whole assemblies and size jobs by the square or linear foot." },
  { key: "contracts", label: "Contracts & Lien Rights", line: "E-sign contracts, payment schedules and lien deadlines." },
  { key: "purchase_orders", label: "Purchase Orders", line: "Write POs to suppliers before you buy. Open POs always count in job cost." },
  { key: "shop_stock", label: "Shop Stock", line: "Keep leftover rolls and boxes on a shelf and bill them to jobs." },
  { key: "crew_payroll", label: "Crew & Payroll", line: "Payroll, what you owe each person, mileage and the handbook." },
  { key: "daily_reports", parent: "crew_payroll", label: "Daily Reports", line: "Your crew lead sends an end-of-day report." },
  { key: "crew_board", parent: "crew_payroll", label: "Crew Board", line: "Everyone's day on one board." },
  { key: "job_codes", label: "Job Codes", line: "Ask for a work code at every clock-in." },
  { key: "permits", label: "Permits & Inspections", line: "Permits and city inspections on each job." },
  { key: "panel_map", label: "Panel Map", line: "Circuits, breaker checks and panel setup on each job." },
  { key: "customer_portal", label: "Customer Portal", line: "A page where your customer sees their job and photos. Pay links always work." },
  { key: "recurring_billing", label: "Recurring Billing", line: "Invoices that repeat on a schedule." },
  { key: "sales_tax", label: "Sales Tax", line: "Add sales tax to estimates and invoices." },
  { key: "licenses", label: "Licenses & Insurance", line: "Your licenses, bonds and policies in one place." },
  { key: "safety_log", parent: "licenses", label: "Safety Log", line: "OSHA incidents, toolbox talks and crew checklists." },
  { key: "website", label: "Website", line: "Your public website, reviews and search listing." },
  { key: "site_chat", parent: "website", label: "Site Chat", line: "Visitors can chat on your website." },
  { key: "nort", label: "Nort", line: "Ask Nort by voice or text." },
  { key: "calculators", label: "Calculators", line: "Trade calculators, with your trade's open first." },
  // Reminders only (0358): a job's task list has no priority, steps or tags to hide.
  { key: "todo_extras", label: "To-Do Extras", line: "Steps, priority and tags on Reminders." },
];
export const FEATURE_BY_KEY = Object.fromEntries(FEATURES.map((f) => [f.key, f])) as Record<FeatureKey, FeatureDef>;
export const isFeatureKey = (k: unknown): k is FeatureKey => typeof k === "string" && (FEATURE_KEYS as readonly string[]).includes(k);
/** The sub-switches under one switch, in board order. */
export const featureChildren = (k: FeatureKey): FeatureDef[] => FEATURES.filter((f) => f.parent === k);

export const ALL_ON: FeatureMap = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as FeatureMap;

// ── TRADE PRESETS: used ONLY when a map is written (sign-up, the backfill) ──────────────────────
export type TradeKey = (typeof TRADE_ORDER)[number];
/** A stored or picked trade, as one of TRADE_ORDER's keys; anything else ("other", blank) is "". */
export function normalizeTradeKey(v: unknown): TradeKey | "" {
  return typeof v === "string" && (TRADE_ORDER as readonly string[]).includes(v) ? (v as TradeKey) : "";
}

/** A blank trade ("Other / Not Listed", or none): the lightest app. 0355 carries the same map. */
export const BLANK_PRESET: FeatureMap = {
  leads: true, referrals: false, estimates: true, kits: false, contracts: false, purchase_orders: false,
  shop_stock: false, crew_payroll: true, daily_reports: false, crew_board: false, job_codes: false,
  permits: true, panel_map: false, customer_portal: false, recurring_billing: false, sales_tax: false,
  licenses: true, safety_log: false, website: true, site_chat: false, nort: true, calculators: true,
  todo_extras: false,
};
const BUILDER: Partial<FeatureMap> = { kits: true, contracts: true };
/** One entry per TRADE_ORDER key (features.test.ts enforces it, so a new trade can't silently get blank). */
export const TRADE_FEATURES: Record<TradeKey, Partial<FeatureMap>> = {
  general: BUILDER,
  deck: BUILDER,
  roofing: BUILDER,
  concrete: BUILDER,
  electrical: { shop_stock: true, panel_map: true },
  plumbing: { shop_stock: true },
  hvac: { shop_stock: true },
  tile: { kits: true },
  landscaping: { permits: false },
  painting: { permits: false },
};
export function featurePreset(trade: unknown): FeatureMap {
  const t = normalizeTradeKey(trade);
  return { ...BLANK_PRESET, ...(t ? TRADE_FEATURES[t] : {}) };
}

// ── READ ─────────────────────────────────────────────────────────────────────────────────────────
/** Total and idempotent. Missing/non-boolean = ON; job_codes falls back to the old Scheduling checkbox. */
export function normalizeFeatures(raw: unknown, legacyJobCodes?: unknown): FeatureMap {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as FeatureMap;
  for (const k of FEATURE_KEYS) {
    const v = src[k];
    out[k] = typeof v === "boolean" ? v : k === "job_codes" ? legacyJobCodes !== false : true;
  }
  return out;
}

/** Is this feature on? A sub-switch is on only while its parent is on. No map = everything on. */
export function featureOn(f: FeatureMap | null | undefined, key: FeatureKey): boolean {
  const m = f ?? ALL_ON;
  if (m[key] !== true) return false;
  const p = FEATURE_BY_KEY[key].parent;
  return p ? m[p] === true : true;
}

/**
 * The switches that are off (parents counted), as ONE plain string: sorted keys joined by ",".
 * For cached readers (Needs You's getActionItems / getActionItemsCount run inside React cache(),
 * which keys on argument identity): a string compares by value, so the cache still hits. "" = all on.
 */
export function offFeatureKey(f: FeatureMap | null | undefined): string {
  return FEATURE_KEYS.filter((k) => !featureOn(f, k)).sort().join(",");
}
/** The other half of offFeatureKey: a map from the string (unknown keys ignored). */
export function featuresFromOffKey(s: string | null | undefined): FeatureMap {
  const off = new Set((s ?? "").split(",").filter(isFeatureKey));
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, !off.has(k)])) as FeatureMap;
}
