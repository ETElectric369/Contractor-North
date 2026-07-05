import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { tzDayStartUtc, todayStrInTz, payPeriodForOffset } from "@/lib/tz";
import { escapeLike, hoursBetween, formatFullAddress } from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { getMoneyPipeline } from "@/lib/billing-pipeline";
import { invoiceBalance } from "@/lib/invoice-math";
import { aggregatePayrollEntries, payRateForEntry } from "@/lib/payroll-math";
import { summarizeMileage } from "@/lib/mileage-math";
import { searchPaidPrices } from "@/lib/pricing/learned-prices";
import { getJobFinancials, listJobProfitability } from "@/lib/analytics/job-profitability";

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
        customer_id: { type: "string", description: "Optional — only this customer's jobs. Resolve a name to an id with list_customers first." },
        limit: { type: "integer", description: "Max rows (default 15, max 40)." },
      },
    },
  },
  {
    name: "list_quotes",
    description:
      "List this company's quotes/estimates with their status, total, and customer. Use for 'show me all quotes', 'which quotes are still open', 'what did I quote the Jones job'. To pull up a SPECIFIC customer's estimate (e.g. 'the estimate we started for Jackie Burks'), FIRST call list_customers to get their customer_id, then pass it here (optionally with status='draft') — don't rely on a text search of the title. Common statuses: draft, sent, accepted, declined, expired.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter (e.g. draft, sent, accepted)." },
        search: { type: "string", description: "Optional text to match against quote number or title." },
        customer_id: { type: "string", description: "Optional — only this customer's quotes/estimates (resolve the name with list_customers first). The reliable way to find a named customer's estimate." },
        limit: { type: "integer", description: "Max rows (default 15, max 40)." },
      },
    },
  },
  {
    name: "list_invoices",
    description:
      "List invoices with status, total, amount paid, remaining balance, and an OVERDUE flag (past its due date with a balance). Use for 'who owes me money', 'show unpaid invoices', 'what's outstanding', 'what's overdue' (pass overdue_only), 'what does Jackie owe' (pass customer_id). Overdue invoices sort first; the result carries total_overdue.",
    input_schema: {
      type: "object",
      properties: {
        unpaid_only: {
          type: "boolean",
          description: "When true, only return invoices with a remaining balance (default false).",
        },
        overdue_only: {
          type: "boolean",
          description: "When true, only return invoices that are past their due date AND still owe a balance (default false).",
        },
        customer_id: { type: "string", description: "Optional — only this customer's invoices (resolve the name with list_customers first)." },
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
    name: "get_quote",
    description:
      "Read ONE quote / estimate in full — status, customer, subtotal/tax/total, and every line item WITH its item_id (you need those to edit or remove a line). Pass a quote_id, OR a job_id for that job's most recent quote. Read it back before editing or telling the user it's ready, and before quote.updateItem / quote.deleteItem.",
    input_schema: {
      type: "object",
      properties: {
        quote_id: { type: "string" },
        job_id: { type: "string", description: "A job's id — returns that job's most recent quote instead." },
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
      "List or search contacts (name, company, phone, email, city, type). Each result includes its type — residential / commercial / industrial client or 'subcontractor' (a sub / supplier / inspector). Use for 'find a customer', 'what's Jane's phone number', 'how many customers do I have', or 'show my subcontractors' (pass type='subcontractor').",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional text to match against name, company, phone, or email." },
        type: { type: "string", enum: ["residential", "commercial", "industrial", "subcontractor"], description: "Optional — only contacts of this type. Use 'subcontractor' to list subs/suppliers/inspectors." },
        limit: { type: "integer", description: "Max rows (default 20, max 40)." },
      },
    },
  },
  {
    name: "get_customer",
    description:
      "Read ONE contact's full record by id — name, company, type, phone, email, full address, status, and notes. Use after list_customers resolves a name to an id: e.g. 'what's Jackie Burks's address', or to confirm you have the right person before pinning them to an estimate / job / invoice.",
    input_schema: { type: "object", properties: { customer_id: { type: "string", description: "The customer's id (from list_customers)." } }, required: ["customer_id"] },
  },
  {
    name: "schedule_overview",
    description:
      "What's scheduled in a time window — jobs, appointments, and tasks due. Use for 'what's on the schedule this week', 'what do I have today', 'anything next week'. PAST windows work too: for 'when was the Waldow oven visit', pass around (or date) with a past date instead of a named range.",
    input_schema: {
      type: "object",
      properties: {
        range: {
          type: "string",
          enum: ["today", "this_week", "next_week", "this_month"],
          description: "Which named window to look at (default this_week).",
        },
        date: {
          type: "string",
          description: "A specific day, YYYY-MM-DD (past or future) — overrides range.",
        },
        around: {
          type: "string",
          description:
            "Look ±2 weeks around this YYYY-MM-DD (past or future) — for finding a visit whose exact day you don't know. Overridden by date.",
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
    name: "lookup_my_price",
    description:
      "Look up what THIS company has ACTUALLY PAID for a material or part — learned live from the line items on the bills they've entered (their real net cost from their own suppliers). Returns the most recent price, the average, the low/high range, how many times they've bought it, and the last date/supplier. Use this FIRST when you need a material's cost: it's the company's true cost basis. Only fall back to the price list catalog or web_search when there's no purchase history for the item. Search by part description (e.g. '200a panel', 'romex 12-2', 'EV charger').",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Text to match against the bill line-item description." },
        limit: { type: "integer", description: "Max items (default 15, max 40)." },
      },
      required: ["search"],
    },
  },
  {
    name: "get_job_financials",
    description:
      "Is a specific job making money? Returns that job's PROFIT — revenue collected (cash paid, net of refunds) minus cost (labor at pay rate + materials) — PLUS budget burn: the quoted estimate, cost to date, remaining vs estimate, % of the estimate spent, and whether it's over budget. Reconciles to the penny with the job page and /analytics. Get the job's id first (list_jobs). CAVEAT to disclose: a cost entered as BOTH a purchase order AND a bill is counted twice (there's no link between them yet), so mention that if the cost looks inflated.",
    input_schema: {
      type: "object",
      properties: { job_id: { type: "string", description: "The job's id (from list_jobs)." } },
      required: ["job_id"],
    },
  },
  {
    name: "list_job_profitability",
    description:
      "Which jobs made or lost money, ranked. Returns each job's revenue collected (net refunds), cost (labor + materials), and profit. sort 'profit' = most profitable first (default); sort 'loss' = biggest loss first (use for 'which jobs am I losing money on'). Optional status filter: a specific job status, or 'active' for all in-progress work. Same cost/revenue math as the job page + /analytics. Disclose the PO+bill double-count caveat if a cost looks inflated.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max jobs (default 15, max 40)." },
        status: { type: "string", description: "Optional: a single job status (e.g. 'in_progress', 'complete') or 'active' for all in-progress work." },
        sort: { type: "string", enum: ["profit", "loss"], description: "profit = best first (default); loss = worst first." },
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
  {
    name: "list_inventory",
    description:
      "List INVENTORY items (part, category, quantity on hand vs reorder point, location). Use for 'what's running low', 'how many breakers do I have', 'inventory for X'.",
    input_schema: { type: "object", properties: { search: { type: "string" }, low_only: { type: "boolean", description: "Only items at/below reorder point." }, limit: { type: "integer" } } },
  },
  {
    name: "list_petty_cash",
    description:
      "List PETTY CASH transactions (date, expense/replenish, amount, category). Use for 'where did the petty cash go', 'cash spent this month', 'petty cash balance'.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
  },
  {
    name: "list_recurring",
    description:
      "List RECURRING templates (recurring invoices/expenses — kind, frequency, amount, customer). Use for 'what's set to recur', 'recurring invoices'.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
  },
  {
    name: "list_safety",
    description:
      "List SAFETY records — incidents + toolbox talks (date, kind, title, severity). Use for 'any safety incidents', 'recent toolbox talks', 'safety on the Miller job'. Pass job_id to filter.",
    input_schema: { type: "object", properties: { kind: { type: "string", description: "incident or toolbox" }, job_id: { type: "string" }, limit: { type: "integer" } } },
  },
  {
    name: "list_team",
    description:
      "List this company's team members (id, name, role). Use to find a person to ASSIGN a job/task to or LOG TIME for — resolve a spoken name to their id ('assign the Smith job to Mike' → list_team → job.assign with Mike's id).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_compliance",
    description:
      "List COMPLIANCE items — insurance policies, licenses, bonds, audits — with their numbers, amounts, and EXPIRY dates (soonest first). Each row carries its type. Use for 'what's expiring soon', 'is our GL insurance current', 'license status', 'when's our next audit'. Pass type to narrow (a forgiving contains match — e.g. 'insurance', 'audit', 'license'). A lapsing policy is expensive to miss.",
    input_schema: { type: "object", properties: { type: { type: "string", description: "Optional — only items whose type contains this (e.g. 'insurance', 'audit', 'license')." }, limit: { type: "integer" } } },
  },
  {
    name: "list_liens",
    description:
      "List LIEN records (mechanic's-lien tracking) with the legally time-sensitive dates — prelim sent, lien recorded, completion, first furnished — and the job. Use for 'is the prelim filed on Hill Street', 'which jobs need a prelim notice'. Pass job_id to filter.",
    input_schema: { type: "object", properties: { job_id: { type: "string" }, limit: { type: "integer" } } },
  },
  {
    name: "get_job",
    description:
      "Read ONE job in full — number, name, status, customer, address, billing type, description, schedule. Use for 'tell me about the Jones job', or before acting on a job. Pass a job_id.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } } },
  },
  {
    name: "list_contracts",
    description:
      "List CONTRACTS with status, number, title, and who signed. Use for 'which contracts are unsigned', 'is the Jones contract signed'. Pass job_id to filter.",
    input_schema: { type: "object", properties: { status: { type: "string" }, job_id: { type: "string" }, limit: { type: "integer" } } },
  },
  {
    name: "hours_summary",
    description:
      "Total LABOR HOURS per employee over a date range — 'how many hours did Mike work this week', 'payroll hours this pay period'. Pass from and to (YYYY-MM-DD); defaults to the last 14 days. Sums clock-out minus clock-in minus lunch for completed entries.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } } },
  },
  {
    name: "list_forms",
    description:
      "List the company's FORM templates (id, name, and the fields each asks for). Use to find a checklist/form to fill, then form.submit with the answers keyed by field label.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_resources",
    description:
      "List the company's saved RESOURCES / contacts — inspectors, suppliers, permit offices, subs — with category, contact name, phone, email, website, address. Use for 'what's the building inspector's number', 'who's our copper supplier'. Optional category or search filter.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string" },
        search: { type: "string", description: "Match against name / contact / category." },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "get_payment_schedule",
    description:
      "Read a job's PROGRESS-BILLING / draw schedule — each milestone's label, percent or amount, and whether it's been billed yet (pending vs billed). Use for 'what's the draw schedule on the Miller job', 'what's the next draw'. Pass a job_id.",
    input_schema: { type: "object", properties: { job_id: { type: "string" } } },
  },
  {
    name: "list_job_contacts",
    description:
      "List the SUBCONTRACTORS / suppliers / inspectors linked to a job (the job's Subs & contacts) — each with their role and the link id (pass that link id + job_id to job.unlinkContact to remove one). Use for 'who's on the Miller job', 'which sub is on this job'. Pass a job_id (from list_jobs).",
    input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
  },
  {
    name: "list_contact_jobs",
    description:
      "The reverse of list_job_contacts: every job a given contact is linked to as a sub / supplier / inspector, with their role. Use for 'what jobs is Joe's plumbing on', 'which jobs does this sub work'. Pass a customer_id (from list_customers).",
    input_schema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] },
  },
  {
    name: "money_pipeline",
    description:
      "THE owner's money board (single source of truth, matches /billing + My Day). Returns the three money-action stages — jobs DONE but NOT INVOICED (need an invoice), DRAFT invoices (review & send), and UNPAID sent/partial invoices (with an overdue flag) — plus the four headline totals: to_invoice, drafts, outstanding, and overdue. Use for 'what do I need to invoice', 'what's overdue', 'how much is outstanding', 'show me the money pipeline'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "payroll_summary",
    description:
      "Payroll for the CURRENT pay period (the same numbers as the Payroll page), in TWO SEPARATE BUCKETS per employee that are NEVER summed together: BASE pay — hours × pay rate → gross, with paid/unpaid/partly-paid status — and MILEAGE — business miles held vs settled. Held miles have NO dollar amount: mileage dollars exist ONLY after a human types a settlement amount on the Payroll page (settled_amount); never compute, estimate, or quote a mileage dollar figure from any rate. Use for 'what's payroll this period', 'how much do I owe the crew' — answer as base gross plus 'N business miles held (no amount set)'. Gross pay only — tax/withholding is the accountant's job.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_bill",
    description:
      "Read ONE supplier BILL in full — supplier, amount, status, category, the linked job, and every line item (qty, unit price, amount). Pass a bill_id (from list_bills). Use to read a bill's breakdown back before paying or categorizing it.",
    input_schema: { type: "object", properties: { bill_id: { type: "string", description: "The bill's id (from list_bills)." } }, required: ["bill_id"] },
  },
  {
    name: "get_purchase_order",
    description:
      "Read ONE PURCHASE ORDER in full — vendor, status, total, the linked job, and every line item WITH its ordered qty, received_qty, and remaining (still to be delivered). Pass a po_id (from list_purchase_orders). Use for 'what's still outstanding on that PO', 'has the CED order come in'.",
    input_schema: { type: "object", properties: { po_id: { type: "string", description: "The purchase order's id (from list_purchase_orders)." } }, required: ["po_id"] },
  },
  {
    name: "list_kits",
    description:
      "List the company's KITS — saved bundles of material/labor lines (assemblies) dropped onto a quote to speed up quoting common services. Returns each kit's id, name, category, and item count. Use for 'what kits do we have', 'is there a kit for a service upgrade'.",
    input_schema: { type: "object", properties: { search: { type: "string", description: "Optional text to match against kit name or category." }, limit: { type: "integer", description: "Max rows (default 20, max 40)." } } },
  },
  {
    name: "list_organize",
    description:
      "List the Organize inbox — receipts / notes / job documents that were photographed and read, each with its id, kind, title, vendor, amount, and whether it's filed or still in the 'needs attention' tray. Use for 'what's in my inbox', 'what receipts still need filing', 'what's waiting to be organized' (pass status='needs_review' for just the tray).",
    input_schema: { type: "object", properties: { status: { type: "string", description: "Optional — 'filed' or 'needs_review' (the tray)." }, limit: { type: "integer", description: "Max rows (default 30, max 40)." } } },
  },
];

const VALID_TOOL_NAMES = new Set(DATA_TOOLS.map((t) => t.name));

/**
 * Data tools that expose FINANCIAL / office-only information and must NOT be offered to a
 * field-tech caller. The chat route gates its tool surface on this (least-privilege at the tool
 * layer; the DB RLS already returns zero rows to a tech, this is defense-in-depth). Kept here,
 * next to the tool definitions, so adding a money tool can't forget to gate it. The route's own
 * STAFF_ONLY_READ set should union this in.
 */
export const STAFF_ONLY_DATA_TOOLS = new Set<string>([
  "money_pipeline", // to-invoice / drafts / outstanding / overdue — the owner's money board
  "payroll_summary", // per-employee gross pay + hours
  "get_job_financials", // one job's profit + budget burn (labor cost + margin)
  "list_job_profitability", // jobs ranked by profit/loss (cost + margin)
  "lookup_my_price", // what the company paid for materials (buy-side cost from their bills)
  "get_bill", // supplier bill + its cost breakdown
  "get_purchase_order", // vendor PO + costs (unit_cost is buy-side pricing)
  "list_kits", // saved quote-bundle pricing
  "list_organize", // receipts/notes inbox — carries vendor + amounts
]);

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
          .select("id, job_number, name, status, address, scheduled_start, scheduled_end, customers(name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        if (input.status) q = q.eq("status", String(input.status));
        if (input.search) {
          const s = sanitize(input.search);
          if (s) q = q.or(`name.ilike.%${s}%,job_number.ilike.%${s}%,description.ilike.%${s}%`);
        }
        if (input.customer_id) q = q.eq("customer_id", String(input.customer_id)); // narrow to one customer's jobs
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          jobs: (data ?? []).map((j: any) => ({
            id: j.id, // needed to schedule / assign / set status / finish / invoice a job
            job: j.job_number,
            name: j.name,
            status: j.status,
            customer: embedName(j.customers),
            address: j.address, // so "navigate to my next job" works
            scheduled_start: j.scheduled_start,
            scheduled_end: j.scheduled_end,
          })),
        });
      }

      case "list_quotes": {
        const lim = clampLimit(input.limit, 15);
        let q = supabase
          .from("quotes")
          .select("id, quote_number, title, status, total, created_at, valid_until, doc_type, customers(name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        if (input.status) q = q.eq("status", String(input.status));
        if (input.search) {
          const s = sanitize(input.search);
          if (s) q = q.or(`quote_number.ilike.%${s}%,title.ilike.%${s}%`);
        }
        if (input.customer_id) q = q.eq("customer_id", String(input.customer_id)); // the reliable way to find a named customer's estimate
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          quotes: (data ?? []).map((r: any) => ({
            id: r.id, // pass to get_quote / quote.addItem / quote.convertToJob / quote.setType
            quote: r.quote_number,
            title: r.title,
            status: r.status,
            kind: (r.doc_type ?? "estimate") === "quote" ? "Fixed-price quote" : "Estimate (T&M)",
            total: money(r.total),
            customer: embedName(r.customers),
            valid_until: r.valid_until,
            created_at: r.created_at,
          })),
        });
      }

      case "list_invoices": {
        const lim = clampLimit(input.limit, 15);
        // Org-local "today" for the overdue rule — a UTC midnight would mis-flag afternoon
        // due-today invoices for non-UTC orgs. Mirrors billing-pipeline's overdue definition.
        const { data: orgInv } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
        const today = todayStrInTz(getOrgSettings((orgInv as any)?.settings).timezone);
        let q = supabase
          .from("invoices")
          .select("id, invoice_number, status, total, amount_paid, due_date, created_at, customers(name)")
          .order("created_at", { ascending: false })
          .limit(40);
        if (input.customer_id) q = q.eq("customer_id", String(input.customer_id)); // narrow to one customer's invoices
        const { data, error } = await q;
        if (error) throw error;
        let rows = (data ?? []).map((r: any) => {
          const total = money(r.total);
          const paid = money(r.amount_paid);
          const balance = invoiceBalance(r.total, r.amount_paid); // SSOT balance — same rounding as the pipeline/portal
          return {
            id: r.id, // pass to get_invoice / payment.record
            invoice: r.invoice_number,
            status: r.status,
            total,
            paid,
            balance,
            due_date: r.due_date,
            // Overdue = has a due date in the past AND still owes money. Mirrors getMoneyPipeline.
            overdue: !!r.due_date && r.due_date < today && balance > 0.005,
            customer: embedName(r.customers),
          };
        });
        if (input.unpaid_only) rows = rows.filter((r: any) => r.balance > 0.005);
        if (input.overdue_only) rows = rows.filter((r: any) => r.overdue);
        rows.sort((a: any, b: any) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1)); // overdue first
        const outstanding = rows.reduce((s: number, r: any) => s + (r.balance > 0 ? r.balance : 0), 0);
        const overdueTotal = rows.reduce((s: number, r: any) => s + (r.overdue ? r.balance : 0), 0);
        return JSON.stringify({
          count: rows.length,
          total_outstanding: money(outstanding),
          total_overdue: money(overdueTotal),
          invoices: rows.slice(0, lim),
        });
      }

      case "list_customers": {
        const lim = clampLimit(input.limit, 20);
        const s = sanitize(input.search ?? "");
        let q = supabase
          .from("customers")
          .select("id, name, company_name, phone, email, city, state, type")
          .order("name")
          .limit(lim);
        if (s) q = q.or(`name.ilike.%${s}%,company_name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
        if (input.type) q = q.eq("type", String(input.type)); // e.g. only subcontractors
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
              ? { id: c.id, name: c.name, company: c.company_name, phone: c.phone, email: c.email, city: c.city, state: c.state, type: c.type }
              : { id: c.id, name: c.name, company: c.company_name, city: c.city, state: c.state, type: c.type },
          ),
        });
      }

      case "get_customer": {
        const { data, error } = await supabase
          .from("customers")
          .select("id, name, company_name, type, status, phone, email, address, city, state, zip, notes")
          .eq("id", String(input.customer_id))
          .maybeSingle();
        if (error) throw error;
        if (!data) return JSON.stringify({ error: "No contact with that id." });
        const c = data as any;
        return JSON.stringify({
          id: c.id,
          name: c.name,
          company: c.company_name,
          type: c.type,
          status: c.status,
          phone: c.phone,
          email: c.email,
          address: formatFullAddress(c.address, c.city, c.state, c.zip) || null,
          notes: c.notes,
        });
      }

      case "list_job_contacts": {
        const { data, error } = await supabase
          .from("job_contacts")
          .select("id, role, customer_id, customers(name, type, phone)")
          .eq("job_id", String(input.job_id))
          .order("created_at", { ascending: false });
        if (error) throw error; // job_contacts exists (migration 0087) — surface real errors, don't mask as "not set up"
        return JSON.stringify({
          count: data?.length ?? 0,
          contacts: (data ?? []).map((r: any) => {
            const cust = Array.isArray(r.customers) ? r.customers[0] : r.customers;
            return {
              link_id: r.id, // pass to job.unlinkContact (with the job_id) to remove
              customer_id: r.customer_id,
              name: cust?.name,
              role: r.role,
              type: cust?.type,
              phone: cust?.phone,
            };
          }),
        });
      }

      case "list_contact_jobs": {
        const { data, error } = await supabase
          .from("job_contacts")
          .select("id, role, jobs(id, job_number, name, status)")
          .eq("customer_id", String(input.customer_id))
          .order("created_at", { ascending: false });
        if (error) throw error; // job_contacts exists (migration 0087) — surface real errors, don't mask as "not set up"
        const jobs = (data ?? [])
          .map((r: any) => {
            const j = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
            return j ? { id: j.id, job: j.job_number, name: j.name, status: j.status, role: r.role } : null;
          })
          .filter(Boolean);
        return JSON.stringify({ count: jobs.length, jobs });
      }

      case "hours_summary": {
        // Day boundaries must be the ORG's local midnight, not UTC — else entries near midnight on
        // the from/to boundary get mis-bucketed, undercounting payroll for non-UTC orgs.
        const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
        const tz = getOrgSettings((org as any)?.settings).timezone;
        const today = new Date();
        const to = sanitize(input.to) || today.toISOString().slice(0, 10);
        const past = new Date(today);
        past.setDate(past.getDate() - 14);
        const from = sanitize(input.from) || past.toISOString().slice(0, 10);
        const fromUtc = tzDayStartUtc(from, tz).toISOString();
        const toUtc = new Date(tzDayStartUtc(to, tz).getTime() + 86_400_000).toISOString(); // end of `to`, exclusive
        const { data, error } = await supabase
          .from("time_entries")
          .select("clock_in, clock_out, lunch_minutes, profiles(full_name)")
          .gte("clock_in", fromUtc)
          .lt("clock_in", toUtc)
          .not("clock_out", "is", null);
        if (error) throw error;
        const byPerson: Record<string, number> = {};
        let skipped = 0;
        for (const e of (data ?? []) as any[]) {
          if (!e.clock_in || !e.clock_out) { skipped++; continue; }
          const gross = (new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000;
          if (gross <= 0) { skipped++; continue; } // clock-out at/before clock-in — a bad pair, not zero hours
          const lunch = Math.min(Math.max(0, e.lunch_minutes || 0), gross); // never deduct more than the shift
          const name = e.profiles?.full_name || "Unknown";
          byPerson[name] = (byPerson[name] || 0) + (gross - lunch);
        }
        const people = Object.entries(byPerson)
          .map(([name, mins]) => ({ name, hours: Math.round((mins / 60) * 100) / 100 }))
          .sort((a, b) => b.hours - a.hours);
        return JSON.stringify({
          from,
          to,
          total_hours: Math.round(people.reduce((s, p) => s + p.hours, 0) * 100) / 100,
          by_employee: people,
          ...(skipped ? { skipped_entries: skipped } : {}),
        });
      }

      case "list_forms": {
        const { data, error } = await supabase.from("forms").select("id, name, schema").eq("active", true).order("name");
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          forms: (data ?? []).map((f: any) => ({
            id: f.id,
            name: f.name,
            fields: Array.isArray(f.schema) ? f.schema.map((fl: any) => ({ label: fl.label, type: fl.type, options: fl.options })) : [],
          })),
        });
      }

      case "list_resources": {
        const lim = clampLimit(input.limit, 40);
        let q = supabase
          .from("resources")
          .select("id, name, category, contact_name, phone, email, website, address, notes")
          .order("name")
          .limit(lim);
        const cat = sanitize(input.category);
        if (cat) q = q.eq("category", cat);
        // Strip PostgREST/ILIKE metacharacters: commas (would split the .or filter) and the
        // % / _ wildcards (would let a crafted search over-match).
        const search = sanitize(input.search).replace(/[,%_]/g, "");
        if (search) q = q.or(`name.ilike.%${search}%,contact_name.ilike.%${search}%,category.ilike.%${search}%`);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          resources: (data ?? []).map((r: any) => ({
            id: r.id,
            name: r.name,
            category: r.category,
            contact: r.contact_name,
            phone: r.phone,
            email: r.email,
            website: r.website,
            address: r.address,
            notes: r.notes,
          })),
        });
      }

      case "get_payment_schedule": {
        const jid = sanitize(input.job_id);
        if (!jid) return JSON.stringify({ error: "Provide a job_id." });
        // Defense-in-depth: confirm the job is visible to this caller (RLS) before reading its
        // schedule — same guard setPaymentSchedule/requestNextPayment use, not RLS alone.
        const { data: job } = await supabase.from("jobs").select("id").eq("id", jid).maybeSingle();
        if (!job) return JSON.stringify({ found: false, message: "Job not found." });
        const { data, error } = await supabase
          .from("payment_milestones")
          .select("sort_order, label, percent, amount, status, billed_amount")
          .eq("job_id", jid)
          .order("sort_order");
        if (error) throw error;
        if (!data || !data.length)
          return JSON.stringify({ found: false, message: "No draw schedule on that job — it bills ad-hoc / T&M." });
        return JSON.stringify({
          found: true,
          milestones: data.map((m: any) => ({
            label: m.label,
            percent: m.percent,
            amount: money(m.amount),
            status: m.status,
            billed: money(m.billed_amount),
          })),
          pending: data.filter((m: any) => m.status !== "billed").length,
        });
      }

      case "get_job": {
        const jid = sanitize(input.job_id);
        if (!jid) return JSON.stringify({ error: "Provide a job_id." });
        const { data: j, error } = await supabase
          .from("jobs")
          .select("id, job_number, name, status, billing_type, address, description, scheduled_start, scheduled_end, customers(name)")
          .eq("id", jid)
          .maybeSingle();
        if (error) throw error;
        if (!j) return JSON.stringify({ found: false, message: "Job not found." });
        return JSON.stringify({
          found: true,
          id: (j as any).id,
          job: (j as any).job_number,
          name: (j as any).name,
          status: (j as any).status,
          billing_type: (j as any).billing_type,
          address: (j as any).address,
          description: (j as any).description,
          customer: embedName((j as any).customers),
          scheduled_start: (j as any).scheduled_start,
          scheduled_end: (j as any).scheduled_end,
        });
      }

      case "list_contracts": {
        const lim = clampLimit(input.limit, 20);
        let q = supabase
          .from("contracts")
          .select("id, contract_number, title, status, signed_name, signed_at, job_id, jobs(name)")
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
          contracts: (data ?? []).map((c: any) => ({
            id: c.id,
            contract_number: c.contract_number,
            title: c.title,
            status: c.status,
            signed_by: c.signed_name,
            signed_at: c.signed_at,
            job: embedName(c.jobs),
          })),
        });
      }

      case "list_compliance": {
        const lim = clampLimit(input.limit, 30);
        let q = supabase
          .from("compliance_items")
          .select("id, type, name, policy_number, amount, issued_date, expires_date")
          .order("expires_date", { ascending: true, nullsFirst: false })
          .limit(lim);
        if (input.type) {
          const t = sanitize(String(input.type));
          if (t) q = q.ilike("type", `%${escapeLike(t)}%`); // 'insurance' / 'audit' / 'license' — a forgiving contains match
        }
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          items: (data ?? []).map((c: any) => ({
            id: c.id,
            type: c.type,
            name: c.name,
            policy_number: c.policy_number,
            amount: money(c.amount),
            issued: c.issued_date,
            expires: c.expires_date,
          })),
        });
      }

      case "list_liens": {
        const lim = clampLimit(input.limit, 30);
        let q = supabase
          .from("lien_records")
          .select("id, job_id, prelim_sent_at, lien_recorded_at, completion_date, first_furnished_date, jobs(job_number, name)")
          .order("completion_date", { ascending: true, nullsFirst: false })
          .limit(lim);
        const jid = sanitize(input.job_id);
        if (jid) q = q.eq("job_id", jid);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          liens: (data ?? []).map((l: any) => ({
            id: l.id,
            job_id: l.job_id,
            job: l.jobs ? `${l.jobs.job_number} ${l.jobs.name}` : null,
            prelim_sent_at: l.prelim_sent_at,
            lien_recorded_at: l.lien_recorded_at,
            completion_date: l.completion_date,
            first_furnished_date: l.first_furnished_date,
          })),
        });
      }

      case "list_team": {
        const { data, error } = await supabase.from("profiles").select("id, full_name, role").eq("active", true).order("full_name");
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          team: (data ?? []).map((p: any) => ({ id: p.id, name: p.full_name, role: p.role })),
        });
      }

      case "list_inventory": {
        const lim = clampLimit(input.limit, 30);
        const s = sanitize(input.search);
        let q = supabase
          .from("inventory_items")
          .select("id, part_number, category, quantity_on_hand, reorder_point, unit, location")
          .order("part_number")
          .limit(lim);
        if (s) q = q.or(`part_number.ilike.%${s}%,category.ilike.%${s}%`);
        const { data, error } = await q;
        if (error) throw error;
        let rows = (data ?? []).map((it: any) => ({
          id: it.id,
          part: it.part_number,
          category: it.category,
          on_hand: it.quantity_on_hand,
          reorder_point: it.reorder_point,
          unit: it.unit,
          location: it.location,
          low: Number(it.quantity_on_hand) <= Number(it.reorder_point ?? 0),
        }));
        if (input.low_only) rows = rows.filter((r: any) => r.low);
        return JSON.stringify({ count: rows.length, items: rows });
      }

      case "list_petty_cash": {
        const lim = clampLimit(input.limit, 20);
        const { data, error } = await supabase
          .from("petty_cash")
          .select("id, tx_date, kind, amount, category, description")
          .order("tx_date", { ascending: false })
          .limit(lim);
        if (error) throw error;
        const balance = (data ?? []).reduce(
          (s: number, t: any) => s + (t.kind === "replenish" ? money(t.amount) : -money(t.amount)),
          0,
        );
        return JSON.stringify({
          count: data?.length ?? 0,
          balance: money(balance),
          transactions: (data ?? []).map((t: any) => ({
            date: t.tx_date,
            kind: t.kind,
            amount: money(t.amount),
            category: t.category,
            description: t.description,
          })),
        });
      }

      case "list_recurring": {
        const lim = clampLimit(input.limit, 20);
        const { data, error } = await supabase
          .from("recurring_templates")
          .select("id, kind, frequency, amount, description, active, customers(name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          recurring: (data ?? []).map((t: any) => ({
            id: t.id,
            kind: t.kind,
            frequency: t.frequency,
            amount: money(t.amount),
            description: t.description,
            active: t.active,
            customer: embedName(t.customers),
          })),
        });
      }

      case "list_safety": {
        const lim = clampLimit(input.limit, 30);
        let q = supabase
          .from("safety_records")
          .select("id, kind, record_date, title, severity, recordable, jobs(name)")
          .order("record_date", { ascending: false })
          .limit(lim);
        const k = sanitize(input.kind);
        if (k) q = q.eq("kind", k);
        const jid = sanitize(input.job_id);
        if (jid) q = q.eq("job_id", jid);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          records: (data ?? []).map((r: any) => ({
            id: r.id,
            kind: r.kind,
            date: r.record_date,
            title: r.title,
            severity: r.severity,
            recordable: r.recordable,
            job: embedName(r.jobs),
          })),
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

      case "get_quote": {
        let qid = sanitize(input.quote_id);
        if (!qid) {
          const jid = sanitize(input.job_id);
          if (!jid) return JSON.stringify({ error: "Provide a quote_id or a job_id." });
          const { data: latest } = await supabase
            .from("quotes")
            .select("id")
            .eq("job_id", jid)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!latest) return JSON.stringify({ found: false, message: "No quote on that job yet." });
          qid = latest.id;
        }
        const { data: qt, error } = await supabase
          .from("quotes")
          .select(
            "id, quote_number, title, status, doc_type, subtotal, tax, total, valid_until, customers(name), quote_line_items(id, description, quantity, unit, unit_price)",
          )
          .eq("id", qid)
          .maybeSingle();
        if (error) throw error;
        if (!qt) return JSON.stringify({ found: false, message: "Quote not found." });
        return JSON.stringify({
          found: true,
          quote_id: qt.id, // pass to quote.addItem / quote.convertToJob / quote.setType
          quote: qt.quote_number,
          title: qt.title,
          status: qt.status,
          kind: (((qt as any).doc_type ?? "estimate") === "quote" ? "Fixed-price quote" : "Estimate (T&M)"),
          customer: embedName(qt.customers),
          subtotal: money(qt.subtotal),
          tax: money(qt.tax),
          total: money(qt.total),
          valid_until: qt.valid_until,
          items: ((qt as any).quote_line_items ?? []).map((it: any) => ({
            item_id: it.id, // needed for quote.updateItem / quote.deleteItem
            description: it.description,
            quantity: it.quantity,
            unit: it.unit,
            unit_price: money(it.unit_price),
            amount: money((it.quantity || 1) * (it.unit_price || 0)),
          })),
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
        const balance = invoiceBalance(inv.total, inv.amount_paid); // SSOT balance
        // Org-local "today" for overdue — mirrors getMoneyPipeline / list_invoices.
        const { data: orgInv } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
        const today = todayStrInTz(getOrgSettings((orgInv as any)?.settings).timezone);
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
          balance,
          due_date: (inv as any).due_date,
          overdue: !!(inv as any).due_date && (inv as any).due_date < today && balance > 0.005,
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
        if (s) q = q.ilike("title", `%${escapeLike(s)}%`);
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
          .select("id, note, page, status, created_at, profiles:reported_by(full_name)")
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
            id: b.id, // pass to bug.resolve
            note: b.note,
            page: b.page,
            status: b.status ?? "open",
            filed: b.created_at,
            reporter: b.profiles?.full_name ?? null,
          })),
        });
      }

      case "schedule_overview": {
        // A specific date / an "around" pivot beats the named range — and both may sit in
        // the PAST (the named ranges are future-biased; "when WAS the Waldow oven visit"
        // needs to look backward).
        const day = sanitize(input.date);
        const pivot = sanitize(input.around);
        let start: string, end: string, label: string;
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          const s = Date.parse(`${day}T00:00:00Z`);
          start = new Date(s).toISOString();
          end = new Date(s + 86_400_000).toISOString();
          label = day;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(pivot)) {
          const p = Date.parse(`${pivot}T00:00:00Z`);
          start = new Date(p - 14 * 86_400_000).toISOString();
          end = new Date(p + 15 * 86_400_000).toISOString(); // ±2 weeks, pivot day inclusive
          label = `two weeks around ${pivot}`;
        } else {
          ({ start, end, label } = windowFor(String(input.range ?? "this_week")));
        }
        const [jobsRes, apptRes, taskRes] = await Promise.all([
          supabase
            .from("jobs")
            .select("job_number, name, status, scheduled_start, scheduled_end, customers(name)")
            .gte("scheduled_start", start)
            .lt("scheduled_start", end)
            .order("scheduled_start"),
          supabase
            .from("appointments")
            .select("id, title, type, starts_at, ends_at, location, status, customers(name), jobs(name)")
            .gte("starts_at", start)
            .lt("starts_at", end)
            .order("starts_at"),
          // Tasks due in-window — the WHEN buckets' cargo, so "what's on Friday"
          // includes the permit deadline, not just the crew's blocks.
          supabase
            .from("tasks")
            .select("id, title, status, due_date, assignee:assigned_to(full_name), jobs(job_number, name)")
            .gte("due_date", start.slice(0, 10))
            .lt("due_date", end.slice(0, 10))
            .order("due_date")
            .limit(40),
        ]);
        if (jobsRes.error) throw jobsRes.error;
        if (apptRes.error) throw apptRes.error;
        if (taskRes.error) throw taskRes.error;
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
            id: a.id, // pass to appointment.update (reschedule) / appointment.setStatus
            title: a.title,
            type: a.type,
            starts_at: a.starts_at,
            ends_at: a.ends_at,
            location: a.location,
            status: a.status,
            customer: embedName(a.customers),
            job: embedName(a.jobs),
          })),
          tasks_due: (taskRes.data ?? []).map((t: any) => ({
            id: t.id, // pass to task.complete / task.setDue
            title: t.title,
            status: t.status,
            due: t.due_date,
            assigned_to: t.assignee?.full_name ?? null,
            job: t.jobs ? `${t.jobs.job_number} ${t.jobs.name}` : null,
          })),
        });
      }

      case "who_is_clocked_in": {
        const { data, error } = await supabase
          .from("time_entries")
          .select("id, clock_in, status, profiles(full_name), jobs(name, job_number)")
          .is("clock_out", null)
          .order("clock_in");
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          clocked_in: (data ?? []).map((t: any) => ({
            // entry_id is what time.fixEntry needs — without it the agent can't close/correct
            // a crew entry ("Brian left at 4:30") and guesses a uuid that validate-fails.
            entry_id: t.id,
            person: embedName(t.profiles),
            job: embedName(t.jobs),
            since: t.clock_in,
            status: t.status,
          })),
        });
      }

      case "business_summary": {
        const head = { count: "exact" as const, head: true };
        // Outstanding/overdue/to-invoice come from getMoneyPipeline — the SAME source as /billing,
        // My Day, and money_pipeline — so the headline can't drift. (The old inline reduce counted
        // DRAFT invoices into "outstanding"; the pipeline excludes drafts, matching what the owner
        // actually sees as owed.)
        const [activeJobs, openQuotes, clockedIn, pipeline] = await Promise.all([
          supabase
            .from("jobs")
            .select("id", head)
            .in("status", ACTIVE_JOB_STATUSES),
          supabase.from("quotes").select("id", head).in("status", ["draft", "sent"]),
          supabase.from("time_entries").select("id", head).is("clock_out", null),
          getMoneyPipeline(supabase),
        ]);
        // Don't coerce a failed query into a confident "0 jobs / $0 outstanding" — the model would
        // state that as fact. If any of the three counts failed (transient / RLS hiccup), surface it.
        const sumErr = activeJobs.error || openQuotes.error || clockedIn.error;
        if (sumErr) throw sumErr;
        return JSON.stringify({
          active_jobs: activeJobs.count ?? 0,
          open_quotes: openQuotes.count ?? 0,
          people_clocked_in: clockedIn.count ?? 0,
          unpaid_invoice_balance: money(pipeline.outstandingTotal),
          overdue_balance: money(pipeline.overdueTotal),
          overdue_count: pipeline.overdueCount,
          to_invoice_total: money(pipeline.toInvoiceTotal), // completed jobs with no invoice yet
          jobs_to_invoice: pipeline.doneNotInvoiced.length,
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

      case "lookup_my_price": {
        const prices = await searchPaidPrices(supabase, String(input.search ?? ""), clampLimit(input.limit, 15));
        return JSON.stringify({
          count: prices.length,
          note: prices.length ? "Real prices this company has paid, from their own bills." : "No purchase history yet for that item — fall back to the price list or web_search.",
          items: prices,
        });
      }

      case "get_job_financials": {
        const jobId = String(input.job_id ?? "").trim();
        if (!jobId) return JSON.stringify({ error: "Provide a job_id (use list_jobs to find it)." });
        const f = await getJobFinancials(supabase, jobId);
        if (!f) return JSON.stringify({ error: "Job not found." });
        return JSON.stringify({
          job_number: f.job_number,
          name: f.name,
          status: f.status,
          revenue_collected: f.rev,
          cost: f.cost,
          profit: f.profit,
          estimate: f.estimate,
          work_to_date: f.workToDate,
          invoiced: f.invoiced,
          billing_type: f.billingType,
          remaining_vs_estimate: f.remaining,
          percent_of_estimate_spent: f.burnPct,
          over_budget: f.overBudget,
          note: "Revenue = cash collected net of refunds. Cost = labor (pay rate, split-aware) + materials. A cost entered as BOTH a PO and a bill is counted twice.",
        });
      }

      case "list_job_profitability": {
        const statusIn = String(input.status ?? "").trim();
        const statuses = statusIn === "active" ? [...ACTIVE_JOB_STATUSES] : statusIn ? [statusIn] : undefined;
        const sort = input.sort === "loss" ? "loss" : "profit";
        const rows = await listJobProfitability(supabase, { limit: clampLimit(input.limit, 15), statuses, sort });
        return JSON.stringify({
          count: rows.length,
          note: "Profit = revenue collected (net refunds) − cost (labor + materials). Same math as /analytics.",
          jobs: rows.map((r) => ({ job_number: r.job_number, name: r.name, status: r.status, revenue: r.rev, cost: r.cost, profit: r.profit })),
        });
      }

      case "money_pipeline": {
        // THE single source of truth for the owner's money board — same helper /billing + My Day use.
        const p = await getMoneyPipeline(supabase);
        return JSON.stringify({
          to_invoice: {
            total: money(p.toInvoiceTotal),
            count: p.doneNotInvoiced.length,
            // Completed jobs with NO invoice — the silent gap; each needs an invoice created.
            jobs: p.doneNotInvoiced.map((j) => ({
              job_id: j.id, // pass to invoice.create / get_invoice
              job: j.job_number,
              name: j.name,
              customer: j.customer,
              estimated_value: money(j.value),
            })),
          },
          drafts: {
            total: money(p.draftTotal),
            count: p.drafts.length,
            invoices: p.drafts.map((i) => ({
              invoice_id: i.id, // pass to get_invoice / invoice.send
              invoice: i.invoice_number,
              total: money(i.total),
              balance: money(i.balance),
              customer: i.customer,
              job: i.job,
            })),
          },
          unpaid: {
            outstanding_total: money(p.outstandingTotal),
            overdue_total: money(p.overdueTotal),
            overdue_count: p.overdueCount,
            count: p.unpaid.length,
            invoices: p.unpaid.map((i) => ({
              invoice_id: i.id, // pass to payment.record
              invoice: i.invoice_number,
              status: i.status,
              total: money(i.total),
              balance: money(i.balance),
              due_date: i.due_date,
              overdue: i.overdue,
              customer: i.customer,
              job: i.job,
            })),
          },
        });
      }

      case "payroll_summary": {
        // The CURRENT pay period, derived exactly like the Payroll page (org pay schedule + tz),
        // then aggregated with the SAME aggregatePayrollEntries helper — no re-derived gross.
        const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
        const settings = getOrgSettings((org as any)?.settings);
        const period = payPeriodForOffset(settings.pay_schedule, settings.pay_anchor, todayStrInTz(settings.timezone), 0);
        const startIso = tzDayStartUtc(period.start, settings.timezone).toISOString();
        const endIso = tzDayStartUtc(period.end, settings.timezone).toISOString();
        const { data: entries, error } = await supabase
          .from("time_entries")
          .select("profile_id, clock_in, clock_out, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override, profiles(full_name, hourly_rate, commute_baseline_miles)")
          .eq("status", "closed")
          .not("clock_out", "is", null)
          .gte("clock_in", startIso)
          .lt("clock_in", endIso);
        if (error) throw error;
        // TWO BUCKETS, never summed: BASE pay locks on paid_at (aggregatePayrollEntries),
        // MILEAGE locks on mileage_paid_at (split below). Mileage dollars exist ONLY as the
        // human-typed amounts recorded in kind='mileage' payroll_runs rows, summed per profile
        // (a late entry can mean a second settlement act = a second row) — never rate × miles.
        const { data: runs, error: runsErr } = await supabase
          .from("payroll_runs")
          .select("profile_id, mileage_amount")
          .eq("kind", "mileage")
          .eq("period_start", period.start)
          .eq("period_end", period.end);
        if (runsErr) throw runsErr;
        const settledAmountBy = new Map<string, number>();
        for (const run of (runs ?? []) as any[]) {
          settledAmountBy.set(run.profile_id, (settledAmountBy.get(run.profile_id) ?? 0) + Number(run.mileage_amount ?? 0));
        }
        const rows = aggregatePayrollEntries((entries ?? []) as any[], settings.timezone);
        const round = (n: number) => Math.round(n * 100) / 100;
        // Per-employee mileage split (held = mileage_paid_at null) + per-rate hours breakdown.
        // Business miles net the daily commute baseline via the same summarizeMileage the
        // Payroll page uses. Netting AFTER the held/settled split can subtract the baseline
        // twice on a day that straddles both groups — a conservative held-miles undercount.
        type MilesAcc = { baseline: number; all: any[]; held: any[]; settled: any[]; rateHours: Map<number, number> };
        const byProfile = new Map<string, MilesAcc>();
        for (const e of (entries ?? []) as any[]) {
          const acc: MilesAcc = byProfile.get(e.profile_id) ?? {
            baseline: Math.max(0, Number(e.profiles?.commute_baseline_miles ?? 0)),
            all: [],
            held: [],
            settled: [],
            rateHours: new Map(),
          };
          const m = { clock_in: e.clock_in, miles: Number(e.miles ?? 0) };
          acc.all.push(m);
          (e.mileage_paid_at ? acc.settled : acc.held).push(m);
          const rate = round(payRateForEntry(e));
          acc.rateHours.set(rate, (acc.rateHours.get(rate) ?? 0) + hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes));
          byProfile.set(e.profile_id, acc);
        }
        const byEmployee = rows.map((r) => {
          const acc = byProfile.get(r.profileId);
          const logged = acc ? summarizeMileage(acc.all, acc.baseline, settings.timezone) : { recorded: 0, business: 0 };
          const heldMiles = acc ? summarizeMileage(acc.held, acc.baseline, settings.timezone).business : 0;
          const settledMiles = acc ? summarizeMileage(acc.settled, acc.baseline, settings.timezone).business : 0;
          const settledAmount = settledAmountBy.get(r.profileId);
          // Plain sorted array (serialization-safe); sent only when the period has MIXED pay
          // rates — the anomaly cue that points at an overridden shift instead of a blend.
          const rates = [...(acc?.rateHours ?? [])]
            .map(([rate, hours]) => ({ rate: money(rate), hours: round(hours) }))
            .sort((a, b) => a.rate - b.rate);
          return {
            id: r.profileId,
            name: r.name,
            base: {
              rate: money(r.rate), // base profile rate — gross honors per-entry overrides
              ...(rates.length > 1 ? { rates } : {}),
              unpaid_hours: round(r.unpaidHours),
              unpaid_gross: money(r.unpaidGross),
              paid_hours: round(r.paidHours),
              paid_gross: money(r.paidGross),
              status: r.unpaidHours > 0 ? (r.paidHours > 0 ? "partly paid" : "unpaid") : "paid",
            },
            mileage: {
              logged_miles: logged.recorded,
              business_miles: logged.business,
              held_miles: heldMiles, // awaiting a HUMAN-decided settlement — no dollar figure exists
              settled_miles: settledMiles,
              settled_amount: settledAmount != null ? money(settledAmount) : null, // human-typed $ only
              status: heldMiles > 0 ? (settledMiles > 0 ? "partly settled" : "held") : settledMiles > 0 ? "settled" : "none",
            },
          };
        });
        return JSON.stringify({
          period: { start: period.start, end: period.end },
          // BASE bucket totals (gross pay only — tax/withholding is the accountant's, by design).
          base: {
            unpaid_gross: money(byEmployee.reduce((s, r) => s + r.base.unpaid_gross, 0)),
            unpaid_hours: round(byEmployee.reduce((s, r) => s + r.base.unpaid_hours, 0)),
            paid_gross: money(byEmployee.reduce((s, r) => s + r.base.paid_gross, 0)),
            paid_hours: round(byEmployee.reduce((s, r) => s + r.base.paid_hours, 0)),
          },
          // MILEAGE bucket totals — miles as data; dollars ONLY where a human settled them.
          mileage: {
            held_business_miles: round(byEmployee.reduce((s, r) => s + r.mileage.held_miles, 0)),
            settled_business_miles: round(byEmployee.reduce((s, r) => s + r.mileage.settled_miles, 0)),
            settled_amount: (runs ?? []).length
              ? money((runs ?? []).reduce((s: number, r: any) => s + Number(r.mileage_amount ?? 0), 0))
              : null,
          },
          by_employee: byEmployee,
        });
      }

      case "get_bill": {
        const bid = sanitize(input.bill_id);
        if (!bid) return JSON.stringify({ error: "Provide a bill_id." });
        const { data: bill, error } = await supabase
          .from("bills")
          .select("id, supplier, bill_number, amount, status, category, bill_date, notes, jobs(name), bill_line_items(id, description, quantity, unit_price, amount, category)")
          .eq("id", bid)
          .maybeSingle();
        if (error) throw error;
        if (!bill) return JSON.stringify({ found: false, message: "Bill not found." });
        const b = bill as any;
        return JSON.stringify({
          found: true,
          bill_id: b.id,
          supplier: b.supplier,
          bill_number: b.bill_number,
          amount: money(b.amount),
          status: b.status,
          category: b.category,
          bill_date: b.bill_date,
          notes: b.notes,
          job: embedName(b.jobs),
          items: (b.bill_line_items ?? []).map((it: any) => ({
            item_id: it.id,
            description: it.description,
            quantity: it.quantity,
            unit_price: money(it.unit_price),
            amount: money(it.amount),
            category: it.category,
          })),
        });
      }

      case "get_purchase_order": {
        const pid = sanitize(input.po_id);
        if (!pid) return JSON.stringify({ error: "Provide a po_id." });
        const { data: po, error } = await supabase
          .from("purchase_orders")
          .select("id, po_number, vendor, status, subtotal, total, ordered_at, notes, jobs(name), purchase_order_items(id, description, part_number, quantity, unit, unit_cost, line_total, received_qty)")
          .eq("id", pid)
          .maybeSingle();
        if (error) throw error;
        if (!po) return JSON.stringify({ found: false, message: "Purchase order not found." });
        const p = po as any;
        return JSON.stringify({
          found: true,
          po_id: p.id,
          po_number: p.po_number,
          vendor: p.vendor,
          status: p.status,
          subtotal: money(p.subtotal),
          total: money(p.total),
          ordered_at: p.ordered_at,
          notes: p.notes,
          job: embedName(p.jobs),
          items: (p.purchase_order_items ?? []).map((it: any) => {
            const ordered = Number(it.quantity) || 0;
            const received = Number(it.received_qty) || 0;
            return {
              item_id: it.id,
              description: it.description,
              part_number: it.part_number,
              unit: it.unit,
              unit_cost: money(it.unit_cost),
              line_total: money(it.line_total),
              ordered_qty: ordered,
              received_qty: received,
              remaining_qty: Math.round((ordered - received) * 100) / 100, // still to be delivered
            };
          }),
        });
      }

      case "list_kits": {
        const lim = clampLimit(input.limit, 20);
        const s = sanitize(input.search);
        let q = supabase
          .from("kits")
          .select("id, name, category, kit_items(id)")
          .order("name")
          .limit(lim);
        if (s) q = q.or(`name.ilike.%${s}%,category.ilike.%${s}%`);
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          kits: (data ?? []).map((k: any) => ({
            id: k.id,
            name: k.name,
            category: k.category,
            items: k.kit_items?.length ?? 0,
          })),
        });
      }

      case "list_organize": {
        const lim = clampLimit(input.limit, 30);
        let q = supabase
          .from("organized_items")
          .select("id, kind, title, vendor, amount, item_date, category, status, confidence, jobs(job_number, name)")
          .order("created_at", { ascending: false })
          .limit(lim);
        const st = sanitize(input.status);
        if (st) q = q.eq("status", st); // 'needs_review' = the tray
        const { data, error } = await q;
        if (error) throw error;
        return JSON.stringify({
          count: data?.length ?? 0,
          items: (data ?? []).map((i: any) => ({
            id: i.id, // pass to organize file/assign actions
            kind: i.kind,
            title: i.title,
            vendor: i.vendor,
            amount: i.amount == null ? null : money(i.amount),
            date: i.item_date,
            category: i.category,
            status: i.status,
            confidence: i.confidence,
            job: i.jobs ? `${i.jobs.job_number} ${i.jobs.name}` : null,
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
