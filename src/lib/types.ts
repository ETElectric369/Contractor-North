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
  hourly_rate: number | null;
  avatar_url: string | null;
  active: boolean;
  language: string;
  home_address: string | null;
  home_lat: number | null;
  home_lng: number | null;
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

export type InquiryStatus = "new" | "contacted" | "quoted" | "won" | "lost";

export interface Inquiry {
  id: string;
  name: string;
  company_name: string | null;
  type: CustomerType;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  message: string | null;
  notes: string | null;
  source: "manual" | "public_form" | "tahoe_deck";
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

export interface Quote {
  id: string;
  quote_number: string;
  customer_id: string | null;
  job_id: string | null;
  status: QuoteStatus;
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
  created_at: string;
  updated_at: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  accuracy?: number;
}

export interface TimeAllocation {
  id: string;
  time_entry_id: string;
  org_id: string;
  job_id: string | null;
  job_code: string | null;
  hours: number;
  description: string | null;
  sort_order: number;
  created_at: string;
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
}
