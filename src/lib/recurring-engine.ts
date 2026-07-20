import "server-only";
import { reportError } from "@/lib/observe";
import { advance } from "@/lib/automations-math";
import { deliverInvoiceEmail } from "@/lib/invoice-email";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { defaultDueDateIsoForOrg } from "@/lib/invoice-due";
import { todayStrInTz, tzDateTimeUtc } from "@/lib/tz";

/** The recurring jobs/expenses/invoices generation engine, extracted so BOTH the
 *  in-app "Generate" buttons (user client, RLS-scoped to one org) and the daily cron
 *  (service client, all orgs) run the exact same logic. */

/** Create one occurrence (a job or an expense bill) from a template and advance its
 *  next_date. org_id is set EXPLICITLY from the template: under the service client (the
 *  cron) there is no auth context, so the set_org_id trigger can't infer the tenant — an
 *  explicit org_id keeps cron-generated rows in the right org (a no-op for the user path,
 *  which sets the same id). Returns false on insert error. (Invoices go through
 *  runInvoiceTemplate instead — they need claim-first idempotency.) */
export async function runTemplate(supabase: any, t: any, userId: string | null, orgSettingsRaw?: unknown): Promise<boolean> {
  if (t.kind === "job") {
    // The org's work-day window in the ORG's timezone — not a bare `T08:00` parse (which
    // reads in the SERVER's tz: on Vercel/UTC that lands recurring jobs at midnight-1 AM
    // Pacific) and not a hardcoded 8-4 (the window is a setting, workDayWindowHm).
    const raw =
      orgSettingsRaw !== undefined
        ? orgSettingsRaw
        : (await supabase.from("organizations").select("settings").eq("id", t.org_id).maybeSingle()).data?.settings;
    const tz = getOrgSettings(raw).timezone;
    const win = workDayWindowHm(raw);
    const { error } = await supabase.from("jobs").insert({
      org_id: t.org_id,
      name: t.title,
      customer_id: t.customer_id,
      description: t.description,
      status: "scheduled",
      scheduled_start: tzDateTimeUtc(t.next_date, win.start, tz),
      scheduled_end: tzDateTimeUtc(t.next_date, win.end, tz),
      created_by: userId,
    });
    if (error) { reportError("recurring-template", error, { templateId: t.id, kind: t.kind }); return false; }
  } else {
    const { error } = await supabase.from("bills").insert({
      org_id: t.org_id,
      job_id: null,
      supplier: t.vendor || t.title,
      amount: t.amount ?? 0,
      status: "unpaid",
      bill_date: t.next_date,
      category: t.category,
      notes: `Recurring expense: ${t.title}`,
      created_by: userId,
    });
    if (error) { reportError("recurring-template", error, { templateId: t.id, kind: t.kind }); return false; }
  }
  // Critical: if this advance silently fails, the occurrence was already created but
  // next_date stays in the past, so the NEXT cron run re-generates it — a duplicate
  // job/payable. Surface the failure so the duplicate is caught instead of invisible.
  const { error: advErr } = await supabase
    .from("recurring_templates")
    .update({ next_date: advance(t.next_date, t.frequency), last_generated_at: new Date().toISOString() })
    .eq("id", t.id);
  if (advErr) reportError("recurring-advance", advErr, { templateId: t.id, kind: t.kind });
  return true;
}

/** Create one customer invoice from a recurring template — a flat line for `amount` at
 *  the template's tax rate. Totals via the shared subtotalTaxTotal (pure — no recalc
 *  round-trip). org_id explicit for the cron path. Auto-sends best-effort when the
 *  template opts in. Does NOT advance next_date — the caller claims the period first
 *  (runInvoiceTemplate). */
async function createRecurringInvoice(supabase: any, t: any, userId: string | null): Promise<boolean> {
  const taxRate = Number(t.tax_rate) || 0;
  // Itemized when the template carries line_items; otherwise a single line from
  // `amount` (back-compat with single-amount templates created before line items).
  const src = Array.isArray(t.line_items) && t.line_items.length ? t.line_items : null;
  const li = (src ?? [{ description: t.title, quantity: 1, unit: "ea", unit_price: Number(t.amount) || 0 }]).map((x: any) => ({
    description: String(x.description || t.title || "Service").slice(0, 500),
    quantity: Number(x.quantity) || 1,
    unit: x.unit || "ea",
    unit_price: Math.round((Number(x.unit_price) || 0) * 100) / 100,
  }));
  // Rollup via the shared subtotalTaxTotal — the SAME rounding as every other invoice
  // writer, so the one unattended (cron) invoice path can't drift a cent from the rest.
  const { subtotal, tax, total } = subtotalTaxTotal(li.map((x: any) => x.quantity * x.unit_price), taxRate);
  const { data: inv, error } = await supabase
    .from("invoices")
    .insert({
      org_id: t.org_id,
      customer_id: t.customer_id,
      status: "draft",
      title: t.title,
      tax_rate: taxRate,
      subtotal,
      tax,
      total,
      // EVERY creation path stamps a due date — without one the Overdue tracker,
      // /billing/ar and the payment-reminder cron all skip the invoice (they filter
      // `due_date < today`, and SQL's `<` drops NULL), so an auto-sent monthly service
      // agreement could go unpaid for months while the Overdue tile read $0. org_id is
      // passed explicitly: the cron runs service-role across ALL orgs, so an unscoped
      // settings read would price this org's net terms off an arbitrary org's row.
      due_date: await defaultDueDateIsoForOrg(supabase, t.org_id),
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) { reportError("recurring-template", error, { templateId: t.id, kind: t.kind }); return false; }
  const rows = li.map((x: any, idx: number) => ({
    invoice_id: inv.id,
    description: x.description,
    quantity: x.quantity,
    unit: x.unit,
    unit_price: x.unit_price,
    sort_order: idx,
  }));
  const { error: liErr } = await supabase.from("invoice_items").insert(rows);
  if (liErr) { reportError("recurring-invoice-item", liErr, { templateId: t.id, invoiceId: inv.id }); return false; }
  if (t.auto_send) {
    // Best-effort send: a customer with no email just leaves a draft to send by hand.
    const sent = await deliverInvoiceEmail(supabase, inv.id);
    if (!sent.ok && sent.error && !/no email/i.test(sent.error)) {
      reportError("recurring-invoice-send", new Error(sent.error), { templateId: t.id, invoiceId: inv.id });
    }
  }
  return true;
}

/** Generate ONE invoice for a recurring template, claim-first: fast-forward next_date
 *  PAST today and only proceed if our optimistic lock (next_date unchanged) still holds.
 *  So a multi-period backlog never emails a STORM of back-dated invoices, and a
 *  failed/retried/concurrent run can't double-bill the customer. Returns true if an
 *  invoice was created. */
export async function runInvoiceTemplate(
  supabase: any,
  t: any,
  userId: string | null,
  today: string,
): Promise<boolean> {
  let nd = advance(t.next_date, t.frequency);
  let g = 0;
  while (nd <= today && g++ < 600) nd = advance(nd, t.frequency);
  // Optimistic lock: only one run wins the claim for this period.
  const { data: claimed, error: claimErr } = await supabase
    .from("recurring_templates")
    .update({ next_date: nd, last_generated_at: new Date().toISOString() })
    .eq("id", t.id)
    .eq("next_date", t.next_date)
    .select("id");
  if (claimErr) { reportError("recurring-invoice-claim", claimErr, { templateId: t.id }); return false; }
  if (!claimed || !claimed.length) return false; // another run already claimed this period
  return createRecurringInvoice(supabase, t, userId);
}

/** Generate every active template that is due (next_date on or before today). Jobs and
 *  expenses CATCH UP multiple overdue periods (internal rows; capped at 24). Invoices
 *  generate exactly ONE per run (a customer-facing email/bill — no back-dated storm).
 *  Works with ANY client: a user client (RLS scopes to one org) or the service client
 *  (all orgs — the cron). Returns how many occurrences were created. */
export async function generateDueTemplates(supabase: any, userId: string | null): Promise<number> {
  // "Due" is judged against each ORG's local today — a UTC today rolls over at ~5 PM
  // Pacific, generating tomorrow's occurrences tonight. Fetch every reachable org's
  // settings once (service client = all orgs; user client = RLS-scoped to one), query
  // up to the LATEST local today among them, then gate each template on its own org's.
  const { data: orgs } = await supabase.from("organizations").select("id, settings");
  const todayByOrg: Record<string, string> = {};
  const settingsByOrg: Record<string, unknown> = {};
  for (const o of orgs ?? []) {
    settingsByOrg[o.id] = o.settings;
    todayByOrg[o.id] = todayStrInTz(getOrgSettings(o.settings).timezone);
  }
  const fallbackToday = new Date().toISOString().slice(0, 10); // template whose org row is unreadable
  const latestToday = Object.values(todayByOrg).reduce((a, b) => (b > a ? b : a), fallbackToday);
  const { data: due } = await supabase
    .from("recurring_templates")
    .select("*")
    .eq("active", true)
    .lte("next_date", latestToday);
  let count = 0;
  for (const t of due ?? []) {
    // Isolate each template: one malformed row (e.g. a bad next_date that makes new Date(...)
    // throw) must NOT abort the whole run OR re-crash the cron every night. Name it, skip it.
    try {
      const today = todayByOrg[t.org_id] ?? fallbackToday;
      if (t.next_date > today) continue; // due in another org's tz, not this org's yet
      if (t.kind === "invoice") {
        const ok = await runInvoiceTemplate(supabase, t, userId ?? t.created_by ?? null, today);
        if (ok) count++;
        continue;
      }
      let guard = 0;
      let cur = { ...t };
      while (cur.next_date <= today && guard++ < 24) {
        const ok = await runTemplate(supabase, cur, userId ?? t.created_by ?? null, settingsByOrg[t.org_id]);
        if (!ok) break;
        cur = { ...cur, next_date: advance(cur.next_date, cur.frequency) };
        count++;
      }
    } catch (e) {
      reportError("recurring-template-crash", e, { templateId: t?.id, kind: t?.kind });
    }
  }
  return count;
}
