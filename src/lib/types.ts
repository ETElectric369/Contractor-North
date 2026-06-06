// Hand-written database row types mirroring supabase/migrations/0001_init.sql.
// (You can later replace these with `supabase gen types typescript`.)

export type UserRole = "owner" | "admin" | "office" | "tech";
export type CustomerType = "residential" | "commercial" | "industrial";
export type CustomerStatus = "lead" | "active" | "inactive";
export type JobStatus =
  | "estimate"
  | "scheduled"
  | "in_progress"
  | "on_hold"
  | "complete"
  | "invoiced"
  | "cancelled";
export type QuoteStatus = "draft" | "sent" | "accepted" | "declined" | "expired";
export type WorkOrderStatus =
  | "draft"
  | "assigned"
  | "in_progress"
  | "complete"
  | "cancelled";
export type ChangeOrderStatus = "pending" | "approved" | "rejected";
export type TimeEntryStatus = "open" | "closed";
export type TimeEntrySource = "app" | "auto_gps" | "text" | "manual";
export type DocumentKind = "plan" | "photo" | "lidar" | "sketch" | "import" | "other";

export interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  role: UserRole;
  hourly_rate: number | null;
  avatar_url: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
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

export interface Quote {
  id: string;
  quote_number: string;
  customer_id: string | null;
  job_id: string | null;
  status: QuoteStatus;
  title: string | null;
  notes: string | null;
  tax_rate: number;
  subtotal: number;
  tax: number;
  total: number;
  valid_until: string | null;
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
