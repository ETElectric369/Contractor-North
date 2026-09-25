// Hand-written database row types mirroring supabase/migrations/0001_init.sql.
// (You can later replace these with `supabase gen types typescript`.)

export type UserRole = "owner" | "admin" | "office" | "tech";
export type CustomerType = "residential" | "commercial" | "industrial" | "subcontractor";
export type CustomerStatus = "lead" | "active" | "inactive";
// Status types are derived from their canonical as-const arrays (one spine each) so the
// DB enum, the type, the dropdowns, and the write-guards can't drift. Imported for local
// use in the interfaces below AND re-exported so `@/lib/types` stays the one import site.
import type { JobStatus } from "./job-status";
import type { QuoteStatus, WorkOrderStatus } from "./statuses";
import { INQUIRY_STATUSES } from "./statuses";
import type { LeadBucket } from "./lead-triage";
export type { JobStatus, QuoteStatus, WorkOrderStatus, LeadBucket };
export type ChangeOrderStatus = "pending" | "approved" | "rejected";
export type TimeEntryStatus = "open" | "closed";
export type TimeEntrySource = "app" | "auto_gps" | "text" | "manual";
export type DocumentKind = "plan" | "photo" | "lidar" | "sketch" | "import" | "other";

export interface Profile {
  id: string;
  org_id: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  role: UserRole;
  /** PAY SPINE — OPTIONAL ON PURPOSE (v800 audit, migrations 0215/0216). These columns are
   *  revoked from the `authenticated` role because RLS cannot restrict columns, so a plain
   *  `profiles` read does NOT carry them: they arrive only from the staff-scoped `profile_pay`
   *  view, merged in by the few surfaces entitled to them. If the compiler says one of these
   *  might be undefined, that is the boundary telling you where you are reading from. */
  hourly_rate?: number | null;
  avatar_url: string | null;
  active: boolean;
  language: string;
  home_address?: string | null;
  bill_rate?: number | null;
  commute_baseline_miles?: number | null;
  /** Crew lead (any role) — owes the Nort end-of-day debrief at clock-out (migration 0128). */
  crew_lead?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  name: string;
  logo_url: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  license: string | null;
  default_tax_rate: number;
  doc_template: string;
  doc_templates: Record<string, string>;
  settings: Record<string, unknown>;
  plan: string;
  subscription_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: string;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

export type InquiryStatus = (typeof INQUIRY_STATUSES)[number]; // from the statuses.ts spine

export interface Inquiry {
  id: string;
  name: string;
  company_name: string | null;
  type: CustomerType;
  email: string | null;
  phone: string | null;
  address: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  message: string | null;
  notes: string | null;
  // "deck_configurator" is what estimate/[handle]/actions.ts actually writes; it was missing
  // here, so every lead off Chris's own configurator rendered as if it had been typed by hand.
  source: "manual" | "public_form" | "tahoe_deck" | "deck_configurator";
  status: InquiryStatus;
  next_follow_up_at: string | null;
  last_contacted_at: string | null;
  customer_id: string | null;
  converted_to: "customer" | "quote" | "estimate" | "job" | null;
  converted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Lead triage (migration 0097) — set for qualified inbound leads (e.g. the Tahoe Deck
  // configurator via /api/inbound/lead); null/0/false for legacy + manually-added leads.
  project_type: string | null;
  lead_bucket: LeadBucket | null;
  estimate_total: number | null;
  site_inspection_required: boolean;
  priority: number;
  intake: { reason?: string; estimate?: { total?: number; lines?: unknown[] } | null; [k: string]: unknown } | null;
}

export interface Customer {
  id: string;
  name: string;
  company_name: string | null;
  type: CustomerType;
  status: CustomerStatus;
  email: string | null;
  phone: string | null;
  address: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
  last_contacted_at: string | null;
  next_follow_up_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  job_number: string;
  customer_id: string | null;
  name: string;
  description: string | null;
  status: JobStatus;
  address: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  assigned_to: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobCode {
  id: string;
  code: string;
  description: string;
  billable: boolean;
  active: boolean;
  created_at: string;
}

/** One row of a quote's optional circuit schedule (the panel layout behind the price). */
export interface QuoteCircuit {
  ckt?: string | null;
  description: string;
  wire?: string | null;
  breaker?: string | null;
  load?: string | null;
}

// ── The job's panel (0333) ────────────────────────────────────────────────────────────────────────
// The estimate's circuits above are the PROPOSAL the customer signs; these are the JOB's own list,
// which the crew works at the panel. No price, part number or supplier on either row, ever.
export type CircuitKind = "standard" | "afci" | "gfci" | "dual_function" | "spd";
/** new = a new breaker for new work; existing = in the panel already, untouched; reused = an
 *  existing breaker or circuit the new work uses; removed = coming out. */
export type CircuitWork = "new" | "existing" | "reused" | "removed";
export type CircuitProgress = "planned" | "roughed" | "done";
/** suggested = a machine (the estimate, the plans, the photo, Nort) put it there; nothing counts
 *  until a person keeps it. */
export type CircuitState = "suggested" | "kept";
export type CircuitSource = "estimate" | "plan" | "photo" | "hand" | "nort" | "inspector";
export type PanelNumbering = "top_down" | "bottom_up";
export type SpaceHalf = "A" | "B";

export interface JobPanel {
  id: string;
  org_id: string;
  job_id: string;
  name: string;
  brand: string | null;
  bus_amps: number | null;
  main_amps: number | null;
  spaces: number | null;
  numbering: PanelNumbering;
  /** A crimped bus with no stab: a kept circuit may not sit here (the database refuses). */
  dead_spaces: number[];
  /** Where the panel label allows tandems (twins / quads): a warning only. */
  twin_spaces: number[];
  photo_document_id: string | null;
  notes: string | null;
  shown_on_portal: boolean;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  removed_at: string | null;
  removed_by: string | null;
}

/** The raw row a circuit was brought in from ("From E-017"). `key` makes Bring In idempotent. */
export interface CircuitSourceRow {
  key: string;
  quote_number?: string | null;
  index?: number;
  ckt?: string | null;
  description?: string | null;
  wire?: string | null;
  breaker?: string | null;
  load?: string | null;
  /** A plain-words flag the reader raised ("The estimate says 15A, but Q120 is a 1P 20A"). */
  check?: string | null;
  // ── the readers and Nort (phase 4) ──
  /** What the photo, the plans or Nort said, word for word ("Mini Fridge"). */
  said?: string | null;
  /** The sheet a plan row came from ("E-1"), and the paper's name. */
  sheet?: string | null;
  document_name?: string | null;
  /**
   * A LABEL CHECK, NOT A CIRCUIT: the reader matched a circuit already on the list and something
   * differs ("Panel Says Mini Fridge, Your List Says Fridge"). It is never kept as a circuit of its
   * own; Use What It Says applies `use` to that circuit, but only while it still holds `was`.
   */
  flag_for?: string | null;
  use?: CircuitReadPatch | null;
  was?: CircuitReadPatch | null;
}

/** The only fields a label check can change on the circuit it names (never the size's poles or type). */
export interface CircuitReadPatch {
  panel_label?: string | null;
  /** What it feeds: the plans' and Nort's words (never the photo's, which are the door's). */
  description?: string | null;
  space?: number | null;
  half?: SpaceHalf | null;
  amps?: number | null;
}

export interface JobCircuit {
  id: string;
  org_id: string;
  job_id: string;
  panel_id: string | null;
  room: string | null;
  /** What it feeds ("Kitchen And Living"). */
  description: string | null;
  /** What the panel door says ("Entry Lights"). */
  panel_label: string | null;
  amps: number | null;
  poles: number;
  kind: CircuitKind | null;
  wire: string | null;
  wire_tag: string | null;
  space: number | null;
  half: SpaceHalf | null;
  work: CircuitWork;
  progress: CircuitProgress;
  state: CircuitState;
  source: CircuitSource;
  source_quote_id: string | null;
  source_document_id: string | null;
  source_row: CircuitSourceRow | null;
  verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  removed_at: string | null;
  removed_by: string | null;
}

export interface Quote {
  id: string;
  quote_number: string;
  customer_id: string | null;
  job_id: string | null;
  status: QuoteStatus;
  /** The customer-facing document word — 'estimate' (T&M, default) or 'quote'
   *  (fixed price). Display strings derive via docLabel() (src/lib/doc-label.ts). */
  doc_type: "estimate" | "quote";
  title: string | null;
  description: string | null;
  notes: string | null;
  tax_rate: number;
  subtotal: number;
  tax: number;
  total: number;
  valid_until: string | null;
  circuits: QuoteCircuit[] | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteLineItem {
  id: string;
  quote_id: string;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  line_total: number;
  sort_order: number;
}

export interface WorkOrder {
  id: string;
  wo_number: string;
  job_id: string | null;
  customer_id: string | null;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  sketch_url: string | null;
  scheduled_for: string | null;
  assigned_to: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TimeEntry {
  id: string;
  profile_id: string;
  job_id: string | null;
  job_code: string | null;
  clock_in: string;
  clock_out: string | null;
  lunch_minutes: number;
  gps_in: GeoPoint | null;
  gps_out: GeoPoint | null;
  notes: string | null;
  translated_notes: string | null;
  status: TimeEntryStatus;
  source: TimeEntrySource;
  /** 0288: the first entry of the shift this piece was cut from (null on an ordinary entry). */
  split_from?: string | null;
  /** 0288: how the piece was made: live (Switch Job), after (split on Timecards), converted (0289). */
  split_how?: "live" | "after" | "converted" | null;
  created_at: string;
  updated_at: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  accuracy?: number;
}

export interface ChangeOrder {
  id: string;
  co_number: string;
  job_id: string | null;
  work_order_id: string | null;
  description: string;
  amount: number;
  status: ChangeOrderStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

export type PoStatus = "draft" | "sent" | "partial" | "received" | "cancelled";

export interface InventoryItem {
  id: string;
  name: string;
  part_number: string | null;
  description: string | null;
  category: string | null;
  unit: string;
  quantity_on_hand: number;
  reorder_point: number;
  unit_cost: number | null;
  vendor: string | null;
  location: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor: string;
  status: PoStatus;
  job_id: string | null;
  notes: string | null;
  subtotal: number;
  total: number;
  ordered_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderItem {
  id: string;
  po_id: string;
  description: string;
  part_number: string | null;
  quantity: number;
  unit: string | null;
  unit_cost: number;
  line_total: number;
  received_qty: number;
  sort_order: number;
}

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "partial"
  | "paid"
  | "overdue"
  | "void";

export interface Invoice {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  job_id: string | null;
  quote_id: string | null;
  status: InvoiceStatus;
  title: string | null;
  notes: string | null;
  tax_rate: number;
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  due_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  line_total: number;
  sort_order: number;
  /** Which import wrote this row ("costs" | "labor" | "quote" | null = hand-entered) —
   *  drives the markup auto-reapply knowing a costs import exists across reloads. */
  import_source?: string | null;
  /** What the line was said to be (0342): labor / materials / other / credit, or null = read it
   *  from the import and the words (groupInvoiceLines). Absent before 0342 is applied. */
  line_kind?: string | null;
}

export interface Payment {
  id: string;
  invoice_id: string;
  amount: number;
  method: string;
  note: string | null;
  paid_at: string;
  recorded_by: string | null;
  created_at: string;
  /** Stripe pi_… for an online payment (0220); null for one recorded by hand. */
  stripe_payment_intent?: string | null;
  /** What Stripe took for it, in dollars (0284). NULL = not known yet; 0 is a real zero. Staff only. */
  processor_fee?: number | null;
}
