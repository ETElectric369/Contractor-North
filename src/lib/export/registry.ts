/**
 * WHAT A COMPANY OWNS, TABLE BY TABLE (cn-v1138, "Your Data"). The records zip an owner downloads
 * from Settings › Getting Paid › Your Data is built from THIS list and nothing else: one CSV per
 * table here, with exactly these columns, in this order (parent before child, so a reader meets a
 * job before its work orders). Every table carries org_id and is read `.eq("org_id", …)`; the CSVs
 * do not repeat it (it is the same on every row; the company is company.json).
 *
 * THE LIST IS THE PROOF. tests/export-registry.test.ts parses every migration (create table, add /
 * drop / rename column, rename table, drop table) and refuses a table that is in neither list, a
 * column that is in neither the export list nor OMITTED_COLUMNS, and an exported column whose name
 * looks like a secret. registry.integration.test.ts runs each column list against the test database.
 *
 * WHAT NEVER LEAVES, even from an exported table: a link token (invoices.public_token,
 * customers.portal_token, …), North's Stripe wiring (every organizations.stripe_ column), a
 * password flag, and the lead-inbound secret inside organizations.settings. Tables that are secrets
 * through and through (OAuth tokens, passkeys, portal sessions, push endpoints), North's own
 * bookkeeping (the error sink, metering, rate limits) and each person's own rows (their Nort
 * chats, their bell) are SKIPPED, each with its why.
 *
 * This module is pure (no server import): the route reads, this names.
 */

export type ExportTable = {
  table: string;
  columns: readonly string[];
  /** The column readAllPages orders by: unique within a company (the primary key, or the key's
   *  other half when the key is (org_id, x)). "id" everywhere it exists. */
  order: string;
  /** How many pages of 1,000 the read may run to before it is refused as too big (readAllPages'
   *  default is 50). The two trails that grow by the day (agent_audit_log, reminder_log) get more. */
  maxPages?: number;
};

/** The page cap for a long trail: 200 pages of 1,000 rows. */
export const TRAIL_MAX_PAGES = 200;

/** readAllPages' own default, named here so the route and its words can say the number. */
export const DEFAULT_MAX_PAGES = 50;

/** The rows a table's read may run to before the door refuses it. */
export const rowCapOf = (t: ExportTable): number => (t.maxPages ?? DEFAULT_MAX_PAGES) * 1000;

/** A column that is in the database and NOT in the file, named with its why. */
export type OmittedColumn = { table: string; column: string; why: string };

/** A column name that looks like a secret. An exported column matching this must be named in
 *  SECRET_LOOKALIKES with its why, or the registry test refuses it. */
export const SECRET_COLUMN_PATTERN = /token|secret|hash|password|credential|_key$/i;

/** Keys stripped from organizations.settings before company.json is written. */
export const COMPANY_SECRET_KEYS: readonly string[] = ["lead_inbound_secret"];

/**
 * THE COMPANY'S OWN ROW: company.json, not a CSV (organizations has no org_id; it IS the company).
 * Every stripe_ column is left out (North's wiring to Stripe, not the company's record); settings
 * goes out whole minus COMPANY_SECRET_KEYS.
 */
export const COMPANY_TABLE: ExportTable = {
  table: "organizations",
  order: "id",
  columns: [
    "id", "name", "logo_url", "address_line1", "address_line2", "city", "state", "zip", "phone", "email", "license",
    "default_tax_rate", "brand_color", "plan", "subscription_status", "trial_ends_at", "current_period_end", "comped_until",
    "billing_notices", "tap_to_pay_announced_at", "doc_template", "doc_templates", "settings", "created_at", "updated_at",
  ],
};

/** Parent → child. Each entry's columns are the CSV's header, in this order. */
export const EXPORT_TABLES: readonly ExportTable[] = [
  // ── People ──────────────────────────────────────────────────────────────────
  {
    table: "profiles",
    order: "id",
    columns: [
      "id", "full_name", "email", "phone", "role", "active", "crew_lead", "language", "hourly_rate", "bill_rate", "cost_rate",
      "commute_baseline_miles", "avatar_url", "home_address", "home_lat", "home_lng", "push_prefs", "nort_name", "nort_humor",
      "nort_register", "nort_greets", "nort_notes", "lessons_seen", "tap_to_pay_intro_seen_at", "onboarded_at", "deactivated_at",
      "deactivated_by", "created_at", "updated_at",
    ],
  },
  { table: "invitations", order: "id", columns: ["id", "email", "role", "invited_by", "accepted_at", "expires_at", "created_at"] },
  { table: "employee_documents", order: "id", columns: ["id", "profile_id", "type", "name", "file_url", "expires_date", "notes", "uploaded_by", "created_at"] },
  { table: "site_collaborators", order: "id", columns: ["id", "user_id", "invited_email", "created_by", "created_at", "claimed_at"] },
  { table: "site_collaborator_revocations", order: "id", columns: ["id", "email", "user_id", "granted_at", "revoked_at", "revoked_by"] },
  // ── Leads and customers ─────────────────────────────────────────────────────
  {
    table: "inquiries",
    order: "id",
    columns: [
      "id", "name", "company_name", "email", "phone", "address", "unit", "city", "state", "zip", "contact_address", "contact_unit",
      "contact_city", "contact_state", "contact_zip", "type", "work_kind", "project_type", "message", "notes", "source", "referred_by",
      "status", "lead_bucket", "priority", "estimate_total", "site_inspection_required", "planned_minutes", "intake",
      "next_follow_up_at", "last_contacted_at", "customer_id", "converted_to", "converted_at", "created_by", "created_at", "updated_at",
    ],
  },
  {
    table: "customers",
    order: "id",
    columns: [
      "id", "name", "company_name", "type", "status", "email", "phone", "address", "unit", "city", "state", "zip", "notes",
      "pricing_level_id", "qbo_id", "qbo_realm_id", "last_contacted_at", "next_follow_up_at", "created_by", "created_at", "updated_at",
    ],
  },
  { table: "job_contacts", order: "id", columns: ["id", "job_id", "customer_id", "role", "notes", "created_by", "created_at"] },
  // ── Estimates, contracts, recurring work ────────────────────────────────────
  {
    table: "quotes",
    order: "id",
    columns: [
      "id", "quote_number", "doc_type", "estimate_format", "customer_id", "job_id", "inquiry_id", "revises_quote_id", "status", "title",
      "description", "notes", "address", "unit", "city", "state", "zip", "circuits", "tax_rate", "subtotal", "tax", "total", "valid_until",
      "follow_up_at", "accepted_at", "declined_at", "created_by", "created_at", "updated_at",
    ],
  },
  { table: "quote_line_items", order: "id", columns: ["id", "quote_id", "description", "detail", "category", "quantity", "unit", "unit_price", "line_total", "sort_order"] },
  {
    table: "contracts",
    order: "id",
    columns: [
      "id", "contract_number", "customer_id", "job_id", "status", "title", "body", "signed_at", "signed_name", "signed_ip",
      "signed_user_agent", "signed_body", "created_by", "created_at", "updated_at",
    ],
  },
  {
    table: "recurring_templates",
    order: "id",
    columns: [
      "id", "kind", "title", "frequency", "next_date", "active", "customer_id", "description", "amount", "tax_rate", "category", "vendor",
      "line_items", "auto_send", "last_generated_at", "created_by", "created_at", "updated_at",
    ],
  },
  { table: "customer_credits", order: "id", columns: ["id", "customer_id", "invoice_id", "amount", "disposition", "status", "note", "stripe_refund_id", "created_by", "created_at"] },
  { table: "payment_milestones", order: "id", columns: ["id", "job_id", "sort_order", "label", "percent", "amount", "status", "invoice_id", "billed_amount", "created_at"] },
  // ── Jobs and everything on them ─────────────────────────────────────────────
  {
    table: "jobs",
    order: "id",
    columns: [
      "id", "job_number", "customer_id", "inquiry_id", "name", "description", "notes", "status", "billing_type", "address", "unit", "city",
      "state", "zip", "scheduled_start", "scheduled_end", "planned_minutes", "assigned_to", "code_template_id", "google_event_id",
      "blocked_on", "blocked_since", "hold_reason", "hold_until", "hold_by", "report_back_at", "dismissed_task_keys", "created_by",
      "created_at", "updated_at",
    ],
  },
  {
    table: "work_orders",
    order: "id",
    columns: ["id", "wo_number", "job_id", "customer_id", "quote_id", "title", "description", "status", "sketch_url", "scheduled_for", "assigned_to", "created_by", "created_at", "updated_at"],
  },
  { table: "change_orders", order: "id", columns: ["id", "co_number", "job_id", "work_order_id", "description", "amount", "status", "created_by", "created_at", "updated_at"] },
  { table: "material_lists", order: "id", columns: ["id", "name", "job_id", "work_order_id", "quote_id", "dismissed_keys", "created_by", "created_at"] },
  {
    table: "material_list_items",
    order: "id",
    columns: ["id", "list_id", "description", "part_number", "quantity", "unit", "vendor", "est_cost", "is_tool", "purchased", "purchased_at", "source_key", "sort_order"],
  },
  { table: "job_schedule_segments", order: "id", columns: ["id", "job_id", "start_date", "end_date", "start_time", "end_time", "created_at"] },
  { table: "job_stretches", order: "id", columns: ["id", "job_id", "label", "starts_on", "ends_on", "sort", "removed_at", "created_by", "updated_by", "created_at", "updated_at"] },
  {
    table: "job_picks",
    order: "id",
    columns: [
      "id", "job_id", "category", "brand", "option_id", "name", "code", "location", "note", "color_hex", "link_url", "file_path", "file_kind",
      "sort", "removed_at", "created_by", "updated_by", "created_at", "updated_at",
    ],
  },
  {
    table: "job_panels",
    order: "id",
    columns: [
      "id", "job_id", "name", "brand", "bus_amps", "main_amps", "spaces", "numbering", "dead_spaces", "twin_spaces", "photo_document_id",
      "notes", "shown_on_portal", "created_by", "created_at", "updated_by", "updated_at", "removed_at", "removed_by",
    ],
  },
  {
    table: "job_circuits",
    order: "id",
    columns: [
      "id", "job_id", "panel_id", "room", "description", "panel_label", "amps", "poles", "kind", "wire", "wire_tag", "space", "half", "work",
      "progress", "state", "source", "source_quote_id", "source_document_id", "source_row", "verified", "verified_by", "verified_at",
      "sort_order", "created_by", "created_at", "updated_by", "updated_at", "removed_at", "removed_by",
    ],
  },
  {
    table: "job_shared_documents",
    order: "document_id",
    columns: [
      "document_id", "job_id", "kind", "title", "file_url_at_share", "object_version_at_share", "shared_by", "shared_at",
      "replaces_document_id", "replaces_marked_by", "replaces_marked_at", "removed_at", "removed_by",
    ],
  },
  { table: "crew_day_assignments", order: "id", columns: ["id", "profile_id", "work_date", "job_id", "kind", "off_reason", "is_crew_lead", "created_by", "created_at", "updated_at"] },
  {
    table: "schedule_proposals",
    order: "id",
    columns: ["id", "job_id", "appointment_id", "dates", "time_note", "status", "chosen_date", "chosen_at", "expires_at", "boss_notified_at", "created_by", "created_at"],
  },
  {
    table: "appointments",
    order: "id",
    columns: [
      "id", "job_id", "customer_id", "inquiry_id", "type", "title", "status", "starts_at", "ends_at", "planned_minutes", "location", "unit",
      "city", "state", "zip", "notes", "assigned_to", "inspection_template_id", "inspection_answers", "capture", "outcome", "outcome_at",
      "absorbed", "blocked_on", "blocked_since", "google_event_id", "created_by", "created_at", "updated_at",
    ],
  },
  { table: "daily_reports", order: "id", columns: ["id", "profile_id", "report_date", "did_today", "materials_tomorrow", "gps_summary", "status", "created_at"] },
  {
    table: "tasks",
    order: "id",
    columns: [
      "id", "job_id", "parent_id", "title", "notes", "category", "tags", "status", "priority", "due_date", "focus_date", "planned_minutes",
      "assigned_to", "completed_at", "done_by", "photo_path", "done_photo_path", "source_key", "sort_order", "created_by", "created_at",
      "updated_at",
    ],
  },
  // permits: the three inline inspection columns 0378 superseded are left out (permit_inspections
  // carries them now; tests/no-superseded-permit-columns keeps them unread).
  {
    table: "permits",
    order: "id",
    columns: ["id", "job_id", "permit_number", "type", "authority", "status", "applied_date", "issued_date", "expires_date", "fee", "portal_url", "notes", "created_by", "created_at", "updated_at"],
  },
  {
    table: "permit_inspections",
    order: "id",
    columns: ["id", "permit_id", "authority", "position", "scheduled_for", "scheduled_window", "inspector", "result", "result_on", "notes", "created_by", "created_at", "updated_at"],
  },
  {
    table: "lien_records",
    order: "id",
    columns: [
      "id", "job_id", "first_furnished_date", "completion_date", "owner_name", "owner_address", "hired_by_name", "gc_name", "gc_address",
      "noc_recorded", "lender_name", "lender_address", "estimated_amount", "prelim_sent_at", "lien_recorded_at", "notes", "created_by",
      "created_at", "updated_at",
    ],
  },
  {
    table: "insurance_claims",
    order: "id",
    columns: ["id", "job_id", "carrier", "claim_number", "policy_number", "adjuster_name", "adjuster_phone", "date_of_loss", "notes", "created_by", "created_at", "updated_at"],
  },
  {
    table: "safety_records",
    order: "id",
    columns: ["id", "kind", "record_date", "title", "profile_id", "job_id", "severity", "recordable", "description", "attendees", "created_by", "created_at"],
  },
  {
    table: "compliance_items",
    order: "id",
    columns: ["id", "type", "name", "policy_number", "amount", "issued_date", "expires_date", "file_url", "notes", "created_by", "created_at", "updated_at"],
  },
  { table: "needs_you_waits", order: "id", columns: ["id", "item_key", "until", "reason", "created_by", "created_at"] },
  // ── Money in ────────────────────────────────────────────────────────────────
  {
    table: "invoices",
    order: "id",
    columns: [
      "id", "invoice_number", "invoice_kind", "customer_id", "job_id", "quote_id", "appointment_id", "status", "title", "description", "notes",
      "tax_rate", "subtotal", "tax", "total", "amount_paid", "due_date", "due_date_by_hand", "sent_at", "revised_at", "hold_until", "hold_reason",
      "dismissed_import_keys", "qbo_id", "qbo_realm_id", "created_by", "created_at", "updated_at",
    ],
  },
  {
    table: "invoice_items",
    order: "id",
    columns: [
      "id", "invoice_id", "line_kind", "description", "quantity", "unit", "unit_price", "line_total", "sort_order", "import_source", "import_key",
      "source_ids", "hand_claims", "edited",
    ],
  },
  {
    table: "payments",
    order: "id",
    columns: ["id", "invoice_id", "amount", "method", "note", "paid_at", "processor_fee", "stripe_event_id", "stripe_payment_intent", "bank_line_id", "recorded_by", "created_at"],
  },
  {
    table: "pending_bank_transfers",
    order: "id",
    columns: ["id", "invoice_id", "payment_intent", "checkout_session", "amount", "status", "started_at", "resolved_at", "stale_alerted_at"],
  },
  { table: "tax_rates", order: "id", columns: ["id", "name", "rate", "is_default", "created_at", "updated_at"] },
  { table: "doc_counters", order: "doc_type", columns: ["doc_type", "current"] },
  // ── Money out ───────────────────────────────────────────────────────────────
  {
    table: "bills",
    order: "id",
    columns: [
      "id", "job_id", "supplier", "supplier_account_id", "supplier_invoice_number", "bill_number", "bill_date", "amount", "amount_paid", "status",
      "category", "scope_category", "is_statement", "pricing_provisional", "on_shelf", "po_id", "bank_line_id", "superseded_by_bill_id",
      "corrects_bill_id", "both_real_at", "notes", "created_by", "created_at", "updated_at",
    ],
  },
  {
    table: "bill_line_items",
    order: "id",
    columns: ["id", "bill_id", "description", "quantity", "unit_price", "amount", "category", "billable", "billed_amount", "is_stock", "sort_order"],
  },
  { table: "bill_supplier_invoices", order: "id", columns: ["id", "bill_id", "supplier_invoice_id", "created_at"] },
  { table: "supplier_accounts", order: "id", columns: ["id", "name", "account_number", "branch_code", "on_account", "open_list_columns", "note", "created_by", "created_at"] },
  { table: "supplier_aliases", order: "id", columns: ["id", "supplier_account_id", "alias", "branch_label", "created_at"] },
  {
    table: "supplier_invoices",
    order: "id",
    columns: [
      "id", "supplier_account_id", "invoice_number", "kind", "invoice_date", "due_date", "job_name_raw", "job_id", "merchandise", "tax", "shipping",
      "total", "discount_amount", "discount_by", "open_balance", "closed", "waiting_credit_since", "waiting_credit_by", "source_file",
      "created_by", "created_at",
    ],
  },
  {
    table: "supplier_invoice_lines",
    order: "id",
    columns: ["id", "supplier_invoice_id", "product_code", "part_number", "description", "quantity", "unit_price", "per_unit", "extension", "sort_order"],
  },
  {
    table: "supplier_payments",
    order: "id",
    columns: ["id", "supplier_account_id", "amount", "paid_on", "method", "reference", "note", "bank_line_id", "voided_at", "created_by", "created_at"],
  },
  { table: "supplier_payment_allocations", order: "id", columns: ["id", "supplier_payment_id", "bill_id", "amount", "discount", "created_by", "created_at"] },
  {
    table: "purchase_orders",
    order: "id",
    columns: ["id", "po_number", "vendor", "status", "job_id", "source_list_id", "description", "notes", "subtotal", "total", "ordered_at", "created_by", "created_at", "updated_at"],
  },
  {
    table: "purchase_order_items",
    order: "id",
    columns: ["id", "po_id", "description", "part_number", "quantity", "unit", "unit_cost", "line_total", "received_qty", "sort_order"],
  },
  { table: "petty_cash", order: "id", columns: ["id", "tx_date", "kind", "amount", "category", "description", "job_id", "bank_line_id", "created_by", "created_at"] },
  {
    table: "bank_lines",
    order: "id",
    columns: [
      "id", "import_id", "line_key", "account_last4", "posted_on", "amount", "description", "check_number", "merchant_key", "choice", "bucket",
      "supplier_account_id", "profile_id", "invoice_id", "job_id", "sorted_by", "created_by", "created_at",
    ],
  },
  {
    table: "bank_rules",
    order: "id",
    columns: [
      "id", "direction", "merchant_key", "min_cents", "max_cents", "choice", "bucket", "answer", "supplier_account_id", "profile_id",
      "learned_import_id", "uses", "created_by", "created_at", "updated_at",
    ],
  },
  // ── Stock and prices ────────────────────────────────────────────────────────
  {
    table: "inventory_items",
    order: "id",
    columns: [
      "id", "name", "part_number", "key_part", "description", "category", "unit", "quantity_on_hand", "reorder_point", "unit_cost", "vendor",
      "location", "price_item_id", "active", "created_at", "updated_at",
    ],
  },
  {
    table: "stock_lots",
    order: "id",
    columns: ["id", "item_id", "kind", "bill_line_id", "pieces", "unit", "cost", "cost_stale", "bought_on", "note", "unshelved_at", "unshelved_by", "created_by", "created_at"],
  },
  {
    table: "stock_moves",
    order: "id",
    columns: [
      "id", "item_id", "lot_id", "job_id", "draw_group", "kind", "qty", "cost", "source", "note", "returns_move_id", "settled_by", "credit_bill_id",
      "credit_filed_by_return", "undone_at", "undone_by", "created_by", "created_at",
    ],
  },
  {
    table: "price_list_items",
    order: "id",
    columns: [
      "id", "code", "description", "category", "supplier", "unit", "buy_price", "markup_pct", "sized_by", "qty_per", "qty_per_sqft", "qty_per_lf",
      "qty_min", "qty_round", "archived", "created_at", "updated_at",
    ],
  },
  {
    table: "price_list_item_options",
    order: "id",
    columns: ["id", "item_id", "vendor", "label", "part_number", "unit", "buy_price", "markup_pct", "is_default", "archived", "sort_order", "created_by", "created_at", "updated_at"],
  },
  {
    table: "price_list_vendors",
    order: "id",
    columns: [
      "id", "name", "kind", "trade", "is_person", "contact_name", "phone", "email", "website", "address", "maps_url", "source_url", "notes",
      "import_batch", "looked_up_at", "archived", "created_by", "created_at", "updated_at",
    ],
  },
  { table: "pricing_levels", order: "id", columns: ["id", "name", "markup_pct", "labor_rate", "is_default", "created_at", "updated_at"] },
  { table: "kits", order: "id", columns: ["id", "name", "category", "unit", "labor_minutes", "created_at", "updated_at"] },
  {
    table: "kit_items",
    order: "id",
    columns: ["id", "kit_id", "description", "price_list_item_id", "quantity", "unit", "unit_price", "qty_per_sqft", "qty_per_lf", "qty_min", "qty_round", "sort_order", "created_at"],
  },
  { table: "job_codes", order: "id", columns: ["id", "code", "description", "billable", "active", "created_at"] },
  { table: "job_code_templates", order: "id", columns: ["id", "name", "codes", "created_by", "created_at"] },
  // ── Time and pay ────────────────────────────────────────────────────────────
  {
    table: "time_entries",
    order: "id",
    columns: [
      "id", "profile_id", "job_id", "job_code", "clock_in", "clock_out", "lunch_minutes", "miles", "rate_override", "status", "source", "notes",
      "translated_notes", "gps_in", "gps_out", "paid_at", "mileage_paid_at", "auto_closed_reason", "split_from", "split_how",
      "last_geofence_push_at", "long_shift_warned_at", "long_shift_nudged_at", "created_at", "updated_at",
    ],
  },
  {
    table: "payroll_runs",
    order: "id",
    columns: ["id", "profile_id", "kind", "period_start", "period_end", "hours", "miles", "rate", "gross", "mileage_amount", "note", "created_by", "created_at"],
  },
  {
    table: "pay_payments",
    order: "id",
    columns: ["id", "profile_id", "amount", "paid_on", "method", "reference", "note", "needs_check", "imported_from_run", "bank_line_id", "voided_at", "voided_by", "created_by", "created_at"],
  },
  // ── Files and paperwork ─────────────────────────────────────────────────────
  { table: "documents", order: "id", columns: ["id", "name", "kind", "category", "file_url", "size_bytes", "job_id", "customer_id", "uploaded_by", "created_at"] },
  {
    table: "organized_items",
    order: "id",
    columns: [
      "id", "kind", "doc_type", "doc_number", "title", "summary", "vendor", "amount", "item_date", "category", "confidence", "status", "source",
      "job_id", "document_id", "file_url", "content_sha256", "bill_id", "tied_bill_id", "tied_supplier_invoice_id", "petty_cash_id",
      "line_items", "payment", "proposal", "pricing_provisional", "created_by", "created_at",
    ],
  },
  { table: "resources", order: "id", columns: ["id", "name", "category", "contact_name", "phone", "email", "website", "address", "notes", "created_at", "updated_at"] },
  // ── The company's website ───────────────────────────────────────────────────
  {
    table: "site_pages",
    order: "id",
    columns: ["id", "slug", "title", "seo_title", "description", "blocks", "published", "nav_label", "nav_order", "created_by", "created_at", "updated_at"],
  },
  {
    table: "site_posts",
    order: "id",
    columns: ["id", "path", "title", "seo_title", "description", "cover_url", "body_html", "published", "published_at", "created_by", "created_at", "updated_at"],
  },
  { table: "site_versions", order: "id", columns: ["id", "v", "doc", "doc_rev", "status", "note", "published_at", "created_by", "created_at"] },
  { table: "site_redirects", order: "id", columns: ["id", "from_path", "to_path", "created_at"] },
  { table: "forms", order: "id", columns: ["id", "name", "description", "schema", "active", "is_inspection", "is_public_intake", "playbook", "created_by", "created_at"] },
  { table: "form_submissions", order: "id", columns: ["id", "form_id", "job_id", "data", "submitted_by", "created_at"] },
  // ── Doors the company opened ────────────────────────────────────────────────
  {
    table: "customer_portal_access",
    order: "customer_id",
    columns: ["customer_id", "enabled", "created_at", "rotated_at", "rotated_by", "disabled_at", "disabled_by", "last_opened_at"],
  },
  {
    table: "voice_invites",
    order: "id",
    columns: ["id", "invitee_name", "purpose", "consent_name", "consent_version", "consented_at", "completed_at", "clip_count", "expires_at", "revoked_at", "created_at"],
  },
  // ── The trail ───────────────────────────────────────────────────────────────
  { table: "agent_audit_log", order: "id", maxPages: TRAIL_MAX_PAGES, columns: ["id", "user_id", "action", "risk", "effect", "ok", "error", "input_summary", "source", "created_at"] },
  { table: "reminder_log", order: "id", maxPages: TRAIL_MAX_PAGES, columns: ["id", "kind", "entity_id", "channel", "sent_at"] },
  {
    table: "bug_reports",
    order: "id",
    columns: ["id", "reported_by", "page", "note", "console", "user_agent", "viewport", "screenshot_path", "status", "filer_notified_at", "created_at"],
  },
  { table: "nort_reviews", order: "id", columns: ["id", "period_start", "period_end", "summary", "findings", "counts", "created_at"] },
  { table: "accountant_exports", order: "id", columns: ["id", "list", "from_at", "to_at", "row_count", "created_by", "created_at"] },
];

/**
 * COLUMNS THAT STAY IN THE DATABASE, each with its why. The registry test lists every column a
 * migration gave an exported table and refuses one that is in neither place. Two rule-shaped
 * omissions are applied by the test itself, since the names must not be spelled in code: every
 * organizations.stripe_ column (North's Stripe wiring) and permits' three superseded inline
 * inspection columns (0378; tests/no-superseded-permit-columns).
 */
export const OMITTED_COLUMNS: readonly OmittedColumn[] = [
  { table: "profiles", column: "must_reset_password", why: "a sign-in flag, not a record of the person" },
  { table: "invitations", column: "token", why: "the live invite link; whoever holds it can take the seat" },
  { table: "customers", column: "portal_token", why: "the customer's portal link; it opens their page without a sign-in" },
  { table: "quotes", column: "public_token", why: "the estimate's public link; it opens the estimate to anyone holding it" },
  { table: "contracts", column: "public_token", why: "the contract's signing link" },
  { table: "schedule_proposals", column: "token", why: "the customer's pick-a-day link" },
  { table: "invoices", column: "public_token", why: "the invoice's pay link; it opens the invoice to anyone holding it" },
  { table: "customer_portal_access", column: "token", why: "the portal link itself; the row's flags say whether the door is open" },
  { table: "voice_invites", column: "token", why: "the recording door's link" },
];

/**
 * EXPORTED COLUMNS THAT LOOK LIKE A SECRET AND ARE NOT. Each one is a matching key or a join key,
 * never something that opens a door.
 */
export const SECRET_LOOKALIKES: readonly OmittedColumn[] = [
  { table: "bank_lines", column: "line_key", why: "the statement line's own dedupe key (date, amount, text), so an import lands once" },
  { table: "bank_lines", column: "merchant_key", why: "the normalized merchant name a rule matches on" },
  { table: "bank_rules", column: "merchant_key", why: "the normalized merchant name the rule matches on" },
  { table: "tasks", column: "source_key", why: "which estimate row the task came from (task:<id>)" },
  { table: "material_list_items", column: "source_key", why: "which estimate line or capture the part came from" },
  { table: "invoice_items", column: "import_key", why: "which receipt, hour or part the invoice line claims" },
  { table: "needs_you_waits", column: "item_key", why: "which Needs You item was put off, and until when" },
];

/**
 * TABLES THAT ARE NOT IN THE ZIP, each with its why. A table a migration renamed or dropped is
 * listed too, so the census stays whole (the registry test derives the two names a law keeps out
 * of src/ on its own: the old time-split table 0290 dropped and its archive copy).
 */
export const SKIPPED_TABLES: readonly { table: string; why: string }[] = [
  // Secrets through and through
  { table: "accounting_connections", why: "Intuit's OAuth tokens for the company's QuickBooks link; a credential, not a record" },
  { table: "calendar_connections", why: "Google's OAuth tokens and sync cursors; a credential, not a record" },
  { table: "external_events", why: "Google Calendar's own events, copied for the planner; Google holds the originals" },
  { table: "webauthn_credentials", why: "each person's passkey public keys and counters; sign-in material" },
  { table: "webauthn_challenges", why: "in-flight passkey challenges; sign-in material that expires in minutes" },
  { table: "customer_portal_codes", why: "one-time sign-in codes for the customer portal (salted hashes)" },
  { table: "customer_portal_sessions", why: "live customer portal sessions (hashed); a session, not a record" },
  { table: "customer_portal_preview_tickets", why: "one-time preview tickets for the portal (hashed)" },
  { table: "customer_portal_retired_links", why: "the old portal tokens that were turned off; nothing in it but the tokens" },
  { table: "push_subscriptions", why: "each phone's push endpoint and keys; a device credential" },
  // North's own bookkeeping
  { table: "error_events", why: "North's error sink: stack traces and payloads North's team triages, not the company's records" },
  { table: "ai_usage", why: "North's metering of model spend by day; a platform meter, not the company's books" },
  { table: "usage_topups", why: "North's record of extra usage bought for a month (0401): a Stripe session and an internal amount; the receipt is Stripe's, the meter is North's" },
  { table: "page_opens", why: "North's page-open counts; a platform meter" },
  { table: "rate_limits", why: "North's request counters; no company in them" },
  { table: "platform_admins", why: "who is on North's own team; no company in it" },
  { table: "signup_allowlist", why: "North's invite-only list for sign-up; no company in it" },
  { table: "client_operations", why: "idempotency keys for in-flight writes; nothing to keep once the write landed" },
  { table: "doc_pdf_cache", why: "rendered PDFs' cache pointers; every PDF is made again from the record" },
  // Each person's own rows, not the company's
  { table: "conversations", why: "each person's own Nort chats (keyed by the person, no company column)" },
  { table: "messages", why: "the turns of each person's own Nort chats" },
  { table: "assistant_state", why: "each person's open Nort draft and thread" },
  { table: "user_memory", why: "what Nort remembers about each person, for that person" },
  { table: "notifications", why: "each person's own bell; the record it rings about is in the zip" },
  // History: renamed or dropped by a migration
  { table: "sentry_events", why: "renamed to error_events in 0146" },
  { table: "job_shared_photos", why: "renamed to job_shared_documents in 0326 (exported under that name)" },
  { table: "carddav_accounts", why: "made in 0235 and dropped in 0236 (the Apple Contacts link never shipped)" },
  { table: "phone_contacts", why: "made in 0235 and dropped in 0236 (the Apple Contacts link never shipped)" },
];

/**
 * THE COMPANY, AS JSON: the organizations row with every stripe_ column already absent (the read
 * names COMPANY_TABLE.columns) and settings minus COMPANY_SECRET_KEYS. Pure; the raw settings jsonb
 * goes in, never the normalized OrgSettings (that object fills defaults the company never wrote).
 */
export function companyJson(org: Record<string, unknown>, settings: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of COMPANY_TABLE.columns) {
    if (col === "settings") continue;
    if (col.startsWith("stripe_")) continue;
    out[col] = org[col] ?? null;
  }
  const s: Record<string, unknown> = settings && typeof settings === "object" && !Array.isArray(settings) ? { ...(settings as Record<string, unknown>) } : {};
  for (const key of COMPANY_SECRET_KEYS) delete s[key];
  out.settings = s;
  return out;
}
