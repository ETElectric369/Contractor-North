import { toCsv, type Cell } from "@/lib/accountant-lists";
import { buildZip, type DeflateRaw, type ZipFile } from "@/lib/zip-write";
import { INTAKE_BUCKET, intakePaths } from "@/lib/playbook/uploads";
import { COMPANY_TABLE, EXPORT_TABLES, type ExportTable } from "@/lib/export/registry";
import { inspectionAnswerPaths } from "@/lib/export-files/collect";

/**
 * THE RECORDS ZIP (cn-v1138, "Your Data"): everything the company has, as files a person can open
 * anywhere. Pure: rows in, bytes out, no database, so the whole shape is tested without one.
 *
 *   README.txt                 who, when (on the company's clock), what each file is
 *   manifest.json              { company, exported_at, timezone, tables: { name: rows }, files }
 *   company.json               the company's own row (registry.companyJson: no stripe_, no secret key)
 *   records/<nn>-<table>.csv   one per registry table, in registry order; header = the registry's columns
 *   files.csv                  every file the records point at: bucket, path, table, row_id, job_id
 *
 * A CSV cell: null → empty, a number as a number, a string as it is (timestamps as stored), a
 * boolean as true/false, a list or an object as JSON text; every cell goes through toCsv's
 * formula guard (a cell starting with = + - @ gets a leading apostrophe) so nothing in a company's
 * notes can run on the owner's machine. The files themselves are not here: a company with photos
 * is bigger than one zip should be, and the files zips are their own door.
 */

export type ExportRows = { table: string; columns: readonly string[]; rows: Record<string, unknown>[] };

export type RecordsZipInput = {
  /** companyJson's output: the organizations row, settings inside. */
  company: Record<string, unknown>;
  tz: string;
  now: Date;
  tables: ExportRows[];
  deflate?: DeflateRaw;
  /** The company's wall clock (wallClockInTz) for the zip's own timestamps. */
  modified?: Date;
};

export type FilePointer = { bucket: string; path: string; table: string; row_id: string; job_id: string };

export const FILES_HEADER = ["bucket", "path", "table", "row_id", "job_id"] as const;
export const FILES_NOTE = "Files are not in this zip — files.csv lists every one; download them from Settings › Getting Paid › Your Data.";

/** The storage buckets a company's records point into. */
export const DOCUMENTS_BUCKET = "documents";
export const BRANDING_BUCKET = "branding";

/** What each CSV is, for the README (one line per file). */
export const TABLE_WORDS: Record<string, string> = {
  profiles: "the people on the roster: name, role, rates, home base",
  invitations: "seats offered by email and whether they were taken",
  employee_documents: "each person's filed papers (licenses, certificates) and when they expire",
  site_collaborators: "who was invited to edit the company's website",
  site_collaborator_revocations: "website editors whose access was taken back",
  inquiries: "every lead: who asked, what for, where it went",
  customers: "the customer list",
  job_contacts: "the other people on a job (a tenant, a property manager)",
  quotes: "every estimate and its revisions",
  quote_line_items: "the lines of each estimate",
  contracts: "contracts and who signed them",
  recurring_templates: "work or bills that repeat on a schedule",
  customer_credits: "credits and refunds owed to or given to customers",
  payment_milestones: "progress payments on a job",
  jobs: "every job",
  work_orders: "work orders on jobs",
  change_orders: "change orders on work orders",
  material_lists: "the materials list of each job",
  material_list_items: "the parts on each materials list",
  job_schedule_segments: "the days a job was scheduled on",
  job_stretches: "the named stretches of a long job",
  job_picks: "the fixtures and finishes picked for a job",
  job_panels: "electrical panels recorded on jobs",
  job_circuits: "the circuits of each recorded panel",
  job_shared_documents: "documents and photos shared to a customer's portal, as they were when shared",
  crew_day_assignments: "who was put on which job, day by day",
  schedule_proposals: "days offered to a customer to pick from",
  appointments: "site visits, inspections and appointments, with what was captured on each",
  daily_reports: "the crew's end-of-day reports",
  tasks: "the task list: on jobs, reminders, and the day's focus",
  permits: "permits pulled on jobs",
  permit_inspections: "each inspection on a permit, by authority",
  lien_records: "preliminary notice and lien dates on jobs",
  insurance_claims: "insurance claims on jobs",
  safety_records: "safety meetings and incidents",
  compliance_items: "the company's licenses, policies and bonds and when they expire",
  needs_you_waits: "Needs You items put off until a day",
  invoices: "every invoice",
  invoice_items: "the lines of each invoice",
  payments: "payments received against invoices",
  pending_bank_transfers: "bank transfers started by a customer and not yet settled",
  tax_rates: "the company's sales tax rates",
  doc_counters: "the next number for each document type",
  bills: "supplier bills and receipts",
  bill_line_items: "the lines of each bill",
  bill_supplier_invoices: "which supplier invoice each bill was matched to",
  supplier_accounts: "the company's accounts at suppliers",
  supplier_aliases: "the spellings each supplier appears under",
  supplier_invoices: "supplier invoices as imported",
  supplier_invoice_lines: "the lines of each supplier invoice",
  supplier_payments: "payments made to suppliers",
  supplier_payment_allocations: "which bills each supplier payment settled",
  purchase_orders: "purchase orders",
  purchase_order_items: "the lines of each purchase order",
  petty_cash: "cash in and out of the drawer",
  bank_lines: "imported bank statement lines and how each was sorted",
  bank_rules: "the rules the bank import learned",
  inventory_items: "stock items",
  stock_lots: "each lot of stock bought and what it cost",
  stock_moves: "every move of stock: to a job, back, adjusted",
  price_list_items: "the price list",
  price_list_item_options: "the vendor options under each price list item",
  price_list_vendors: "vendors on the price list",
  pricing_levels: "the markup levels customers are priced at",
  kits: "kits: a task's parts and minutes, remembered",
  kit_items: "the parts of each kit",
  job_codes: "the job codes hours are punched to",
  job_code_templates: "job code sets that start a job",
  time_entries: "every punch: in, out, lunch, miles, notes",
  payroll_runs: "each pay period's hours and pay per person",
  pay_payments: "money paid to people against what they earned",
  documents: "every uploaded file's name, kind and where it is filed",
  organized_items: "paperwork the office sorted: what it read and where it was filed",
  resources: "the company's contact book: inspectors, building departments, utilities",
  site_pages: "the pages of the company's website",
  site_posts: "the posts on the company's website",
  site_versions: "saved versions of the website",
  site_redirects: "old website addresses pointed at new ones",
  forms: "the company's forms and inspection sheets",
  form_submissions: "filled-in forms",
  customer_portal_access: "which customers have a portal door open",
  voice_invites: "invitations to record a voice, and consent",
  agent_audit_log: "the trail: who did what, when, and from where",
  reminder_log: "reminders that were sent",
  bug_reports: "bug reports filed from inside the app",
  nort_reviews: "Nort's weekly reviews",
  accountant_exports: "accountant downloads that were recorded (an older door)",
};

/**
 * A table named in a sentence, for a refusal: its README words up to the first colon or
 * parenthesis, capitalized ("Every punch", "The trail", "Every invoice"); a table with no words is
 * its name with spaces. Never the raw table name on the card.
 */
export function tableSaid(table: string): string {
  const words = (TABLE_WORDS[table] ?? table.replace(/_/g, " ")).split(/[:(]/)[0].trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : table.replace(/_/g, " ");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** records/<nn>-<table>.csv: nn from the registry's order, so the files sort parent before child. */
export function csvEntryName(table: string): string {
  const i = EXPORT_TABLES.findIndex((t) => t.table === table);
  return `records/${pad2(i + 1)}-${table}.csv`;
}

/** A cell: null → empty, numbers as numbers, strings as stored, booleans as words, the rest as JSON. */
export function csvCell(v: unknown): Cell {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  return JSON.stringify(v);
}

export function tableCsv(t: ExportRows): string {
  return toCsv({ header: [...t.columns], rows: t.rows.map((r) => t.columns.map((c) => csvCell(r[c]))) });
}

const str = (v: unknown): string => (v == null ? "" : String(v));

/**
 * A stored object's bucket and path from a value a record holds: a bare path (what most rows keep)
 * goes with the bucket its table writes to; a Supabase object URL (public, signed or authenticated —
 * logo_url and avatar_url are public URLs) names its own bucket and path. Anything else (an empty
 * value, a foreign URL, a bare file name where a path belongs) is no pointer.
 */
export function objectPointer(value: unknown, bucket: string): { bucket: string; path: string } | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    const m = /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/.exec(v);
    if (!m) return null;
    try {
      return { bucket: decodeURIComponent(m[1]), path: decodeURIComponent(m[2]) };
    } catch {
      return null;
    }
  }
  if (v.includes("..")) return null;
  return { bucket, path: v.replace(/^\/+/, "") };
}

/**
 * EVERY FILE THE RECORDS POINT AT, one row per pointer (a file shared to the portal is listed
 * under documents AND under job_shared_documents; the files door dedupes by path). The bucket is
 * the table's: documents for the company's own files and photos, branding for the logo, avatars,
 * portfolio and post covers (public URLs, read back to their path), intake-uploads for a lead's
 * plan set (every path inside inquiries.intake, the same reader the plan brief uses). A visit's
 * files are its capture photos AND every file a slot of its inspection sheet holds
 * (inspection_answers: a file slot's value is a list of keys under <org>/appointments/<id>/).
 */
export function filePointers(company: Record<string, unknown>, tables: ExportRows[]): FilePointer[] {
  const out: FilePointer[] = [];
  const orgId = str(company.id);
  const rowsOf = (table: string) => tables.find((t) => t.table === table)?.rows ?? [];
  const add = (bucket: string, value: unknown, table: string, row_id: unknown, job_id: unknown = "") => {
    const p = objectPointer(value, bucket);
    if (p) out.push({ bucket: p.bucket, path: p.path, table, row_id: str(row_id), job_id: str(job_id) });
  };

  // The company's own row.
  add(BRANDING_BUCKET, company.logo_url, COMPANY_TABLE.table, company.id);
  const settings = company.settings as { portfolio?: unknown } | undefined;
  for (const p of Array.isArray(settings?.portfolio) ? settings.portfolio : []) {
    const photo = p as { url?: unknown; path?: unknown } | null;
    if (typeof photo?.path === "string" && photo.path.trim()) add(BRANDING_BUCKET, photo.path, COMPANY_TABLE.table, company.id);
    else add(BRANDING_BUCKET, photo?.url, COMPANY_TABLE.table, company.id);
  }
  for (const r of rowsOf("profiles")) add(BRANDING_BUCKET, r.avatar_url, "profiles", r.id);
  for (const r of rowsOf("site_posts")) add(BRANDING_BUCKET, r.cover_url, "site_posts", r.id);

  // The documents bucket, table by table.
  for (const r of rowsOf("documents")) add(DOCUMENTS_BUCKET, r.file_url, "documents", r.id, r.job_id);
  for (const r of rowsOf("organized_items")) add(DOCUMENTS_BUCKET, r.file_url, "organized_items", r.id, r.job_id);
  for (const r of rowsOf("employee_documents")) add(DOCUMENTS_BUCKET, r.file_url, "employee_documents", r.id);
  for (const r of rowsOf("compliance_items")) add(DOCUMENTS_BUCKET, r.file_url, "compliance_items", r.id);
  for (const r of rowsOf("job_shared_documents")) add(DOCUMENTS_BUCKET, r.file_url_at_share, "job_shared_documents", r.document_id, r.job_id);
  for (const r of rowsOf("job_picks")) add(DOCUMENTS_BUCKET, r.file_path, "job_picks", r.id, r.job_id);
  for (const r of rowsOf("tasks")) {
    add(DOCUMENTS_BUCKET, r.photo_path, "tasks", r.id, r.job_id);
    add(DOCUMENTS_BUCKET, r.done_photo_path, "tasks", r.id, r.job_id);
  }
  for (const r of rowsOf("appointments")) {
    const photos = (r.capture as { photos?: unknown } | null)?.photos;
    for (const p of Array.isArray(photos) ? photos : []) add(DOCUMENTS_BUCKET, p, "appointments", r.id, r.job_id);
    for (const p of inspectionAnswerPaths(orgId, r.inspection_answers)) add(DOCUMENTS_BUCKET, p, "appointments", r.id, r.job_id);
  }
  for (const r of rowsOf("bug_reports")) add(DOCUMENTS_BUCKET, r.screenshot_path, "bug_reports", r.id);
  // A supplier invoice's source_file is a stored path only once it holds a folder; a bare file name
  // came in before the PDF was kept (ced-pdf-store) and points at nothing.
  for (const r of rowsOf("supplier_invoices")) if (typeof r.source_file === "string" && r.source_file.includes("/")) add(DOCUMENTS_BUCKET, r.source_file, "supplier_invoices", r.id, r.job_id);

  // A lead's plan set.
  for (const r of rowsOf("inquiries")) for (const p of intakePaths(r.intake)) add(INTAKE_BUCKET, p, "inquiries", r.id);

  return out;
}

/** "2026-10-28 14:05" on the company's clock. */
export function momentInTz(now: Date, tz: string): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return f.format(now).replace(",", "");
}

export function readmeText(input: { companyName: string; tz: string; now: Date; tables: ExportRows[]; files: number }): string {
  const { companyName, tz, now, tables, files } = input;
  const lines: string[] = [];
  lines.push(`${companyName} — every record the company has in Contractor North`);
  lines.push(`Made ${momentInTz(now, tz)} (${tz}).`);
  lines.push("");
  lines.push("WHAT IS IN THIS ZIP");
  lines.push("  README.txt — this note.");
  lines.push("  manifest.json — what was exported and when: every table and how many rows it has.");
  lines.push("  company.json — the company's own row: name, address, plan, and its settings.");
  for (const t of tables) lines.push(`  ${csvEntryName(t.table)} — ${TABLE_WORDS[t.table] ?? t.table} (${t.rows.length} ${t.rows.length === 1 ? "row" : "rows"}).`);
  lines.push(`  files.csv — every file the records point at (${files} ${files === 1 ? "pointer" : "pointers"}): bucket, path, the table and row it belongs to, and the job.`);
  lines.push("");
  lines.push(FILES_NOTE);
  lines.push("");
  lines.push("HOW TO READ A CSV");
  lines.push("  UTF-8, one row per record, the first line is the column names (the database's own).");
  lines.push("  A date or time is as it was stored (UTC, ISO 8601). An empty cell was empty.");
  lines.push("  A cell that holds a list or a structure is JSON text.");
  lines.push("  A cell that starts with = + - or @ carries a leading apostrophe, so a spreadsheet never runs it as a formula.");
  lines.push("  Every row belongs to this company; the company's id is in company.json.");
  return lines.join("\n") + "\n";
}

/**
 * THE ZIP. Tables go out in registry order whatever order they came in (a reader meets a job
 * before its work orders); a table that was read and has no rows still gets its CSV (the header
 * alone), so "no rows" is said by a file, never by a missing one.
 */
export function buildRecordsZip(input: RecordsZipInput): Uint8Array {
  const byName = new Map(input.tables.map((t) => [t.table, t]));
  const tables: ExportRows[] = [];
  for (const def of EXPORT_TABLES as readonly ExportTable[]) {
    const got = byName.get(def.table);
    if (got) tables.push({ table: def.table, columns: def.columns, rows: got.rows });
  }
  const pointers = filePointers(input.company, tables);
  const companyName = String(input.company.name ?? "").trim() || "The company";
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.table] = t.rows.length;

  const files: ZipFile[] = [
    { name: "README.txt", data: readmeText({ companyName, tz: input.tz, now: input.now, tables, files: pointers.length }) },
    {
      name: "manifest.json",
      data: JSON.stringify(
        {
          company: { id: input.company.id ?? null, name: companyName },
          exported_at: input.now.toISOString(),
          timezone: input.tz,
          tables: counts,
          files: pointers.length,
        },
        null,
        2,
      ) + "\n",
    },
    { name: "company.json", data: JSON.stringify(input.company, null, 2) + "\n" },
    ...tables.map((t) => ({ name: csvEntryName(t.table), data: tableCsv(t) })),
    {
      name: "files.csv",
      data: toCsv({ header: [...FILES_HEADER], rows: pointers.map((p) => FILES_HEADER.map((k) => p[k])) }),
    },
  ];
  return buildZip(files, { deflate: input.deflate, modified: input.modified });
}
