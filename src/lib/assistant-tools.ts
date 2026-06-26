import "server-only";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Read-only data tools for the in-app assistant.
 *
 * Every tool runs against the *caller's* RLS-scoped Supabase client (their own
 * signed-in session), so the database itself guarantees the assistant can only
 * ever see the current user's organization. There is no service-role access and
 * no write path here — these tools only SELECT.
 */

export const DATA_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_jobs",
    description:
      "List this company's jobs. Use for questions like 'what jobs are in progress', 'show me my jobs', 'find the job at the Smith house'. Filter by status and/or a text search on job name/number/description.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: [
            "estimate",
            "scheduled",
            "in_progress",
            "on_hold",
            "complete",
            "invoiced",
            "cancelled",
          ],
          description: "Optional job-status filter.",
        },
        search: {
          type: "string",
          description: "Optional text to match against job name, number, or description.",
        },
        limit: { type: "integer", description: "Max rows (default 15, max 40)." },
      },
    },
  },
  {
    name: "list_quotes",
    description:
      "List this company's quotes/estimates with their status, total, and customer. Use for 'show me all quotes', 'which quotes are still open', 'what did I quote the Jones job'. Common statuses: draft, sent, accepted, declined, expired.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter (e.g. draft, sent, accepted)." },
        search: { type: "string", description: "Optional text to match against quote number or title." },
        limit: { type: "integer", description: "Max rows (default 15, max 40)." },
      },
    },
  },
  {
    name: "list_invoices",
    description:
      "List invoices with status, total, amount paid, and remaining balance. Use for 'who owes me money', 'show unpaid invoices', 'what's outstanding'.",
    input_schema: {
      type: "object",
      properties: {
        unpaid_only: {
          type: "boolean",
          description: "When true, only return invoices with a remaining balance (default false).",
        },
        limit: { type: "integer", description: "Max rows (default 15, max 40)." },
      },
    },
  },
  {
    name: "get_invoice",
    description:
      "Read ONE invoice in full — status, customer, subtotal/tax/total, balance, and every line item WITH its item_id (you need those ids to edit or remove a line). Pass an invoice_id, OR a job_id to get that job's most recent invoice. Use this to read an invoice back to the user before they send it, and before invoice.updateItem / invoice.deleteItem.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string", description: "The invoice's id." },
        job_id: { type: "string", description: "A job's id — returns that job's most recent invoice instead." },
      },
    },
  },
  {
    name: "list_job_codes",
    description:
      "List the company's active job/cost codes (code + description). Use to map a spoken name like 'rough-in' or 'service call' to its code when allocating hours on a clock-out (time.clockOut allocations).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_customers",
    description:
      "List or search customers (name, company, phone, email, city). Use for 'find a customer', 'what's Jane's phone number', 'how many customers do I have'.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional text to match against name, company, phone, or email." },
        limit: { type: "integer", description: "Max rows (default 20, max 40)." },
      },
    },
  },
  {
    name: "schedule_overview",
    description:
      "What's scheduled in a time window — jobs and appointments. Use for 'what's on the schedule this week', 'what do I have today', 'anything next week'.",
    input_schema: {
      type: "object",
      properties: {
        range: {
          type: "string",
          enum: ["today", "this_week", "next_week", "this_month"],
          description: "Which window to look at (default this_week).",
        },
      },
    },
  },
  {
    name: "who_is_clocked_in",
    description:
      "Who is currently clocked in (open time entries with no clock-out yet), and on which job. Use for 'who's working right now', 'is anyone clocked in'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "business_summary",
    description:
      "A quick snapshot of the business right now: count of active jobs, open quotes, total unpaid invoice balance, and how many people are clocked in. Use for 'how's business', 'give me a status update', 'what's going on'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_price_list",
    description:
      "Search the company's PRICE LIST — their real priced catalog of materials and services (their own buy price + markup → sell price). When drafting or pricing a quote line, ALWAYS search here first and use the catalog's sell_price when there's a match; only fall back to an estimate when there's no catalog match, and say which lines are estimates. Search by description, part code, or category.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Text to match against item description, part code, or category." },
        limit: { type: "integer", description: "Max rows (default 15, max 40)." },
      },
    },
  },
  {
    name: "list_tasks",
    description:
      "List this company's tasks (with their id, title, status, due date, and who they're assigned to). Use BEFORE completing, rescheduling, or reassigning a task so you have its id — e.g. 'mark the inspection task done', 'push the permit task to Friday'. Filter by status (open | done) and/or a text search on the title.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "done"], description: "Optional status filter." },
        search: { type: "string", description: "Optional text to match against the task title." },
        limit: { type: "integer", description: "Max rows (default 20, max 40)." },
      },
    },
  },
  {
    name: "list_bug_reports",
    description:
      "List the bug reports / feature requests this company has filed (note, page, status, date, who filed it). Use when the user asks you to review, summarize, cluster, or prioritize their reported bugs — 'what are we complaining about most', 'what's still open'. Read-only and limited to this company by the database.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter (e.g. open, fixed)." },
        limit: { type: "integer", description: "Max rows (default 30, max 40)." },
      },
    },
  },
  {
    name: "list_inquiries",
    description:
      "List incoming LEADS (inquiries) — the top of the sales funnel. Returns each lead's id, name, phone, status, and when it was last contacted. Use for 'who are my open leads', 'any new leads', 'who needs a follow-up'. Pass the id to contact or convert a lead.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter (e.g. new, contacted)." },
        limit: { type: "integer", description: "Max rows (default 20, max 40)." },
      },
    },
  },
  {
    name: "list_payments",
    description:
      "List payments RECEIVED (money in), newest first, with the invoice number + customer. Use for 'what payments came in', 'did the Jones invoice get paid'.",
    input_schema: { type: "object", properties: { limit: { type: "integer", description: "Max rows (default 20, max 40)." } } },
  },
  {
    name: "list_bills",
    description:
      "List supplier BILLS (money owed to suppliers) with supplier, amount, status, and the linked job. Use for 'what bills are unpaid', 'how much do I owe suppliers'.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter (e.g. unpaid, paid)." },
        limit: { type: "integer", description: "Max rows (default 20, max 40)." },
      },
    },
  },
  {
    name: "list_purchase_orders",
    description:
      "List PURCHASE ORDERS (materials ordered from vendors) with vendor, total, status, and the linked job. Use for 'what's on order', 'open POs'.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter." },
        limit: { type: "integer", description: "Max rows (default 20, max 40)." },
      },
    },
  },
  {
    name: "list_permits",
    description:
      "List PERMITS with status, authority, and inspection date. Use for 'what permits are open', 'any inspections coming up', 'permit status on the Miller job'. Pass a job_id to filter to one job.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter." },
        job_id: { type: "string", description: "Filter to one job's permits." },
        limit: { type: "integer", description: "Max rows (default 30, max 40)." },
      },
    },
  },
  {
    name: "list_work_orders",
    description:
      "List WORK ORDERS across jobs (number, title, status, job). Use for 'what work orders are open', 'work orders on the Miller job'. Pass job_id to filter to one job.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string" },
        job_id: { type: "string" },
        limit: { type: "integer", description: "Max rows (default 20, max 40)." },
      },
    },
  },
  {
    name: "list_material_lists",
    description:
      "List MATERIAL LISTS across jobs (name, item count, job). Use for 'what material lists are there', 'materials for the Miller job'. Pass job_id to filter.",
    input_schema: {
      type: "object",
      properties: { job_id: { type: "string" }, limit: { type: "integer", description: "Max rows (default 20, max 40)." } },
    },
  },
  {
    name: "list_change_orders",
    description:
      "List CHANGE ORDERS across jobs (number, amount, status, job). Use for 'what change orders are pending', 'change orders on the Miller job'. Pass job_id to filter.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string" },
        job_id: { type: "string" },
        limit: { type: "integer", description: "Max rows (default 20, max 40)." },
      },
    },
  },
];

const VALID_TOOL_NAMES = new Set(DATA_TOOLS.map((t) => t.name));

/** Strip characters that would break a PostgREST `.or()` filter expression. */
function sanitize(s: unknown): string {
  return String(s ?? "")
    .replace(/[,()%*]/g, " ")
    .trim()
    .slice(0, 80);
}

function clampLimit(n: unknown, def: number, max = 40): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(v, max);
}

/** Normalize a Supabase to-one embed that may arrive as an object or array. */
function embedName(rel: any): string | null {
  if (!rel) return null;
  const r = Array.isArray(rel) ? rel[0] : rel;
  return r?.name ?? r?.full_name ?? null;
}

const money = (n: any) => Math.round(Number(n ?? 0) * 100) / 100;

/** Compute [startISO, endISO) for a named window, in UTC (matches the calendar). */
function windowFor(range: string): { start: string; end: string; label: string } {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

  if (range === "today") {
    const end = new Date(startOfDay);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start: startOfDay.toISOString(), end: end.toISOString(), label: "today" };
  }
  if (range === "this_month") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { start: start.toISOString(), end: end.toISOString(), label: "this month" };
  }
  // week-based (Monday start), this_week or next_week
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = new Date(startOfDay);
  weekStart.setUTCDate(startOfDay.getUTCDate() - day + (range === "next_week" ? 7 : 0));
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);
  return {
    start: weekStart.toISOString(),
    end: weekEnd.toISOString(),
    label: range === "next_week" ? "next week" : "this week",
  };
}

/**
 * Execute a read-only data tool. `supabase` must be the request-scoped client
 * (RLS-bound to the signed-in user). Returns a compact JSON string for the model.
 */
export async function runDataTool(
  name: string,
  rawInput: unknown,
  supabase: any,
): Promise<string> {
  if (!VALID_TOOL_NAMES.has(name)) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  const input = (rawInput ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "list_jobs": {
        const lim = clampLimit(input.limit, 15);
        let q = supabase
          .from("jobs")
          .select("job_number, name, status, scheduled_start, scheduled_end, customers(name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        if (input.status) q = q.eq("status", String(input.status));
        if (input.search) {
          const s = sanitize(input.search);
          if (s) q = q.or(`name.ilike.%${s}%,job_number.ilike.%${s}%,description.ilike.%${s}%`);
        }
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          jobs: (data ?? []).map((j: any) => ({
            job: j.job_number,
            name: j.name,
            status: j.status,
            customer: embedName(j.customers),
            scheduled_start: j.scheduled_start,
            scheduled_end: j.scheduled_end,
          })),
        });
      }

      case "list_quotes": {
        const lim = clampLimit(input.limit, 15);
        let q = supabase
          .from("quotes")
          .select("quote_number, title, status, total, created_at, valid_until, customers(name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        if (input.status) q = q.eq("status", String(input.status));
        if (input.search) {
          const s = sanitize(input.search);
          if (s) q = q.or(`quote_number.ilike.%${s}%,title.ilike.%${s}%`);
        }
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          quotes: (data ?? []).map((r: any) => ({
            quote: r.quote_number,
            title: r.title,
            status: r.status,
            total: money(r.total),
            customer: embedName(r.customers),
            valid_until: r.valid_until,
            created_at: r.created_at,
          })),
        });
      }

      case "list_invoices": {
        const lim = clampLimit(input.limit, 15);
        const { data, error } = await supabase
          .from("invoices")
          .select("invoice_number, status, total, amount_paid, due_date, created_at, customers(name)")
          .order("created_at", { ascending: false })
          .limit(40);
        if (error) throw error;
        let rows = (data ?? []).map((r: any) => {
          const total = money(r.total);
          const paid = money(r.amount_paid);
          return {
            invoice: r.invoice_number,
            status: r.status,
            total,
            paid,
            balance: money(total - paid),
            due_date: r.due_date,
            customer: embedName(r.customers),
          };
        });
        if (input.unpaid_only) rows = rows.filter((r: any) => r.balance > 0.005);
        const outstanding = rows.reduce((s: number, r: any) => s + (r.balance > 0 ? r.balance : 0), 0);
        return JSON.stringify({
          count: rows.length,
          total_outstanding: money(outstanding),
          invoices: rows.slice(0, lim),
        });
      }

      case "list_customers": {
        const lim = clampLimit(input.limit, 20);
        const s = sanitize(input.search ?? "");
        let q = supabase
          .from("customers")
          .select("id, name, company_name, phone, email, city, state")
          .order("name")
          .limit(lim);
        if (s) q = q.or(`name.ilike.%${s}%,company_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
        const { data, error } = await q;
        if (error) throw error;
        // Data minimization (framework §7): phone/email reach the model ONLY on a SPECIFIC
        // lookup (>=3 chars) that resolves to a SMALL set — so a broad/short term like "a"
        // can't walk the whole customer book with contact attached. A broad list returns
        // name + locality only. The `id` is an opaque UUID (not PII) and is ALWAYS returned —
        // without it the assistant can find a customer but can never edit them or pin them to
        // a quote (the exact "it won't let me fix my customers" gap).
        const showPII = s.length >= 3 && (data?.length ?? 0) <= 5;
        return JSON.stringify({
          count: data?.length ?? 0,
          customers: (data ?? []).map((c: any) =>
            showPII
              ? { id: c.id, name: c.name, company: c.company_name, phone: c.phone, email: c.email, city: c.city, state: c.state }
              : { id: c.id, name: c.name, company: c.company_name, city: c.city, state: c.state },
          ),
        });
      }

      case "list_work_orders": {
        const lim = clampLimit(input.limit, 20);
        let q = supabase
          .from("work_orders")
          .select("id, wo_number, title, status, jobs(job_number, name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        const st = sanitize(input.status);
        if (st) q = q.eq("status", st);
        const jid = sanitize(input.job_id);
        if (jid) q = q.eq("job_id", jid);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          work_orders: (data ?? []).map((w: any) => ({
            id: w.id,
            wo_number: w.wo_number,
            title: w.title,
            status: w.status,
            job: w.jobs ? `${w.jobs.job_number} ${w.jobs.name}` : null,
          })),
        });
      }

      case "list_material_lists": {
        const lim = clampLimit(input.limit, 20);
        let q = supabase
          .from("material_lists")
          .select("id, name, jobs(job_number, name), material_list_items(id)")
          .order("created_at", { ascending: false })
          .limit(lim);
        const jid = sanitize(input.job_id);
        if (jid) q = q.eq("job_id", jid);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          material_lists: (data ?? []).map((l: any) => ({
            id: l.id,
            name: l.name,
            items: l.material_list_items?.length ?? 0,
            job: l.jobs ? `${l.jobs.job_number} ${l.jobs.name}` : null,
          })),
        });
      }

      case "list_change_orders": {
        const lim = clampLimit(input.limit, 20);
        let q = supabase
          .from("change_orders")
          .select("id, co_number, amount, status, jobs(job_number, name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        const st = sanitize(input.status);
        if (st) q = q.eq("status", st);
        const jid = sanitize(input.job_id);
        if (jid) q = q.eq("job_id", jid);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          change_orders: (data ?? []).map((c: any) => ({
            id: c.id,
            co_number: c.co_number,
            amount: money(c.amount),
            status: c.status,
            job: c.jobs ? `${c.jobs.job_number} ${c.jobs.name}` : null,
          })),
        });
      }

      case "list_inquiries": {
        const lim = clampLimit(input.limit, 20);
        let q = supabase
          .from("inquiries")
          .select("id, name, company_name, phone, status, last_contacted_at, created_at")
          .order("created_at", { ascending: false })
          .limit(lim);
        const st = sanitize(input.status);
        if (st) q = q.eq("status", st);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          inquiries: (data ?? []).map((i: any) => ({
            id: i.id, // pass to convert/contact a lead
            name: i.name,
            company: i.company_name,
            phone: i.phone,
            status: i.status,
            last_contacted: i.last_contacted_at,
          })),
        });
      }

      case "list_payments": {
        const lim = clampLimit(input.limit, 20);
        const { data, error } = await supabase
          .from("payments")
          .select("amount, method, paid_at, created_at, invoices(invoice_number, customers(name))")
          .order("created_at", { ascending: false })
          .limit(lim);
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          total: money((data ?? []).reduce((s: number, p: any) => s + money(p.amount), 0)),
          payments: (data ?? []).map((p: any) => ({
            amount: money(p.amount),
            method: p.method,
            paid_at: p.paid_at ?? p.created_at,
            invoice: p.invoices?.invoice_number ?? null,
            customer: embedName(p.invoices?.customers),
          })),
        });
      }

      case "list_bills": {
        const lim = clampLimit(input.limit, 20);
        let q = supabase
          .from("bills")
          .select("id, supplier, bill_number, amount, status, jobs(name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        const st = sanitize(input.status);
        if (st) q = q.eq("status", st);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          bills: (data ?? []).map((b: any) => ({
            id: b.id,
            supplier: b.supplier,
            bill_number: b.bill_number,
            amount: money(b.amount),
            status: b.status,
            job: embedName(b.jobs),
          })),
        });
      }

      case "list_purchase_orders": {
        const lim = clampLimit(input.limit, 20);
        let q = supabase
          .from("purchase_orders")
          .select("id, po_number, vendor, total, status, jobs(name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        const st = sanitize(input.status);
        if (st) q = q.eq("status", st);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          purchase_orders: (data ?? []).map((p: any) => ({
            id: p.id,
            po_number: p.po_number,
            vendor: p.vendor,
            total: money(p.total),
            status: p.status,
            job: embedName(p.jobs),
          })),
        });
      }

      case "list_permits": {
        const lim = clampLimit(input.limit, 30);
        let q = supabase
          .from("permits")
          .select("id, permit_number, type, authority, status, inspection_date, jobs(job_number, name)")
          .order("inspection_date", { ascending: true, nullsFirst: false })
          .limit(lim);
        const st = sanitize(input.status);
        if (st) q = q.eq("status", st);
        const jid = sanitize(input.job_id);
        if (jid) q = q.eq("job_id", jid);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          permits: (data ?? []).map((p: any) => ({
            id: p.id,
            permit_number: p.permit_number,
            type: p.type,
            authority: p.authority,
            status: p.status,
            inspection_date: p.inspection_date,
            job: p.jobs ? `${p.jobs.job_number} ${p.jobs.name}` : null,
          })),
        });
      }

      case "list_job_codes": {
        const { data, error } = await supabase
          .from("job_codes")
          .select("code, description")
          .eq("active", true)
          .order("code");
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          codes: (data ?? []).map((c: any) => ({ code: c.code, description: c.description })),
        });
      }

      case "get_invoice": {
        let invId = sanitize(input.invoice_id);
        if (!invId) {
          const jid = sanitize(input.job_id);
          if (!jid) return JSON.stringify({ error: "Provide an invoice_id or a job_id." });
          const { data: latest } = await supabase
            .from("invoices")
            .select("id")
            .eq("job_id", jid)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!latest) return JSON.stringify({ found: false, message: "No invoice on that job yet." });
          invId = latest.id;
        }
        const { data: inv, error } = await supabase
          .from("invoices")
          .select(
            "id, invoice_number, status, subtotal, tax, total, amount_paid, due_date, customers(name), invoice_items(id, description, quantity, unit, unit_price)",
          )
          .eq("id", invId)
          .maybeSingle();
        if (error) throw error;
        if (!inv) return JSON.stringify({ found: false, message: "Invoice not found." });
        const total = money(inv.total);
        const paid = money(inv.amount_paid);
        return JSON.stringify({
          found: true,
          invoice_id: inv.id, // pass to invoice.addItem / payment.record
          invoice: inv.invoice_number,
          status: inv.status,
          customer: embedName(inv.customers),
          subtotal: money(inv.subtotal),
          tax: money(inv.tax),
          total,
          paid,
          balance: money(total - paid),
          items: ((inv as any).invoice_items ?? []).map((it: any) => ({
            item_id: it.id, // needed for invoice.updateItem / invoice.deleteItem
            description: it.description,
            quantity: it.quantity,
            unit: it.unit,
            unit_price: money(it.unit_price),
            amount: money((it.quantity || 1) * (it.unit_price || 0)),
          })),
        });
      }

      case "list_tasks": {
        const lim = clampLimit(input.limit, 20);
        const s = sanitize(input.search);
        let q = supabase
          .from("tasks")
          .select("id, title, status, due_date, assignee:assigned_to(full_name), jobs(job_number, name)")
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(lim);
        const st = String(input.status ?? "");
        if (st === "open" || st === "done") q = q.eq("status", st);
        if (s) q = q.ilike("title", `%${s}%`);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          tasks: (data ?? []).map((t: any) => ({
            id: t.id, // needed to complete / reschedule / reassign the task
            title: t.title,
            status: t.status,
            due: t.due_date,
            assigned_to: t.assignee?.full_name ?? null,
            job: t.jobs ? `${t.jobs.job_number} ${t.jobs.name}` : null,
          })),
        });
      }

      case "list_bug_reports": {
        const lim = clampLimit(input.limit, 30);
        let q = supabase
          .from("bug_reports")
          .select("note, page, status, created_at, profiles:reported_by(full_name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        const st = sanitize(input.status);
        if (st) q = q.eq("status", st);
        // RLS already restricts bug_reports to this org AND to staff — a non-staff caller
        // simply gets zero rows, so no extra guard is needed here.
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          bug_reports: (data ?? []).map((b: any) => ({
            note: b.note,
            page: b.page,
            status: b.status ?? "open",
            filed: b.created_at,
            reporter: b.profiles?.full_name ?? null,
          })),
        });
      }

      case "schedule_overview": {
        const { start, end, label } = windowFor(String(input.range ?? "this_week"));
        const [jobsRes, apptRes] = await Promise.all([
          supabase
            .from("jobs")
            .select("job_number, name, status, scheduled_start, scheduled_end, customers(name)")
            .gte("scheduled_start", start)
            .lt("scheduled_start", end)
            .order("scheduled_start"),
          supabase
            .from("appointments")
            .select("title, type, starts_at, ends_at, location, status, customers(name), jobs(name)")
            .gte("starts_at", start)
            .lt("starts_at", end)
            .order("starts_at"),
        ]);
        if (jobsRes.error) throw jobsRes.error;
        if (apptRes.error) throw apptRes.error;
        return JSON.stringify({
          window: label,
          jobs: (jobsRes.data ?? []).map((j: any) => ({
            job: j.job_number,
            name: j.name,
            status: j.status,
            customer: embedName(j.customers),
            scheduled_start: j.scheduled_start,
            scheduled_end: j.scheduled_end,
          })),
          appointments: (apptRes.data ?? []).map((a: any) => ({
            title: a.title,
            type: a.type,
            starts_at: a.starts_at,
            ends_at: a.ends_at,
            location: a.location,
            status: a.status,
            customer: embedName(a.customers),
            job: embedName(a.jobs),
          })),
        });
      }

      case "who_is_clocked_in": {
        const { data, error } = await supabase
          .from("time_entries")
          .select("clock_in, status, profiles(full_name), jobs(name, job_number)")
          .is("clock_out", null)
          .order("clock_in");
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          clocked_in: (data ?? []).map((t: any) => ({
            person: embedName(t.profiles),
            job: embedName(t.jobs),
            since: t.clock_in,
            status: t.status,
          })),
        });
      }

      case "business_summary": {
        const head = { count: "exact" as const, head: true };
        const [activeJobs, openQuotes, clockedIn, invoices] = await Promise.all([
          supabase
            .from("jobs")
            .select("id", head)
            .in("status", ["scheduled", "in_progress", "on_hold"]),
          supabase.from("quotes").select("id", head).in("status", ["draft", "sent"]),
          supabase.from("time_entries").select("id", head).is("clock_out", null),
          supabase.from("invoices").select("total, amount_paid, status").limit(1000),
        ]);
        const outstanding = (invoices.data ?? [])
          .filter((r: any) => !["paid", "void", "cancelled"].includes(r.status))
          .reduce((s: number, r: any) => s + Math.max(0, money(r.total) - money(r.amount_paid)), 0);
        return JSON.stringify({
          active_jobs: activeJobs.count ?? 0,
          open_quotes: openQuotes.count ?? 0,
          people_clocked_in: clockedIn.count ?? 0,
          unpaid_invoice_balance: money(outstanding),
        });
      }

      case "search_price_list": {
        const lim = clampLimit(input.limit, 15);
        const s = sanitize(input.search ?? "");
        let q = supabase
          .from("price_list_items")
          .select("code, description, category, unit, buy_price, markup_pct, supplier")
          .eq("archived", false)
          .order("description")
          .limit(lim);
        if (s) q = q.or(`description.ilike.%${s}%,code.ilike.%${s}%,category.ilike.%${s}%`);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          items: (data ?? []).map((r: any) => ({
            code: r.code,
            description: r.description,
            category: r.category,
            unit: r.unit,
            // sell = buy × (1 + markup%) — the same math the quote builder uses.
            sell_price: money(Number(r.buy_price) * (1 + Number(r.markup_pct) / 100)),
            supplier: r.supplier,
          })),
        });
      }

      default:
        return JSON.stringify({ error: `Unhandled tool: ${name}` });
    }
  } catch (e: any) {
    return JSON.stringify({ error: e?.message ?? "Query failed." });
  }
}
