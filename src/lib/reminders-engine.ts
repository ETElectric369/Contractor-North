import "server-only";
import { sendEmail, renderReminderEmail, money } from "@/lib/email";
import { invoiceBalance } from "@/lib/invoice-math";
import { todayStrInTz } from "@/lib/tz";
import { reportError } from "@/lib/observe";
import { getOrgSettings, accentHex, orgPublicBaseUrl } from "@/lib/org-settings";
import { reminderSuppressed } from "@/lib/automations-math";

/** The opt-in customer-reminder engine (run by the daily automations cron). For each
 *  org that has turned a reminder toggle ON, find what's due, send a branded email,
 *  and record it in reminder_log so the cadence cap holds — a customer is never
 *  spammed. Email-only and best-effort: a customer with no email is skipped, a send
 *  failure is just not logged (so it retries next run). Nothing sends for an org whose
 *  toggles are off. */

type Counts = { invoice_due: number; quote_followup: number; appointment: number; skipped_no_email: number };
const DAY = 86_400_000;

export async function sendDueReminders(supabase: any): Promise<Counts> {
  const now = Date.now();
  const counts: Counts = { invoice_due: 0, quote_followup: 0, appointment: 0, skipped_no_email: 0 };

  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name, phone, email, settings");

  for (const org of orgs ?? []) {
    const s = getOrgSettings(org.settings);
    if (!s.remind_invoice_due && !s.remind_quote_followup && !s.remind_appointments) continue;
    const tz = s.timezone; // via the settings SSOT — same default the pipeline's orgTodayStr resolves
    const today = todayStrInTz(tz);
    const brand = {
      name: org.name || "Contractor North",
      brand: accentHex(s.glass_tint),
      phone: org.phone,
      email: org.email,
    };
    // Links land on THIS org's own domain (custom domain → their subdomain → fallback), so a
    // customer's invoice/quote button points at the brand they hired, not a generic app URL.
    const site = orgPublicBaseUrl(s);

    // Has a reminder of (kind, entity) already gone out within `withinDays`, or hit `cap`?
    // Fail CLOSED: if the dedup read errors, suppress — never risk re-spamming a customer.
    async function suppress(kind: string, entityId: string, withinDays: number, cap: number): Promise<boolean> {
      const { data, error } = await supabase
        .from("reminder_log")
        .select("sent_at")
        .eq("org_id", org.id)
        .eq("kind", kind)
        .eq("entity_id", entityId)
        .order("sent_at", { ascending: false });
      if (error) return true; // fail closed: can't verify -> don't risk re-sending
      const sentMs = (data ?? []).map((r: any) => new Date(r.sent_at).getTime());
      return reminderSuppressed(sentMs, withinDays, cap, now);
    }
    // Returns whether the dedup row actually persisted. A failed write is logged (so
    // the silent resend it would cause is diagnosable) and NOT counted as success.
    async function logSent(kind: string, entityId: string): Promise<boolean> {
      const { error } = await supabase
        .from("reminder_log")
        .insert({ org_id: org.id, kind, entity_id: entityId, channel: "email" });
      if (error) {
        // A failed dedup write would silently re-send next run — make it visible.
        reportError("reminders-log", error, { orgId: org.id, kind, entityId });
        return false;
      }
      return true;
    }

    // 1) Overdue invoices — remind at most weekly, max 3 total.
    if (s.remind_invoice_due) {
      const { data: invs } = await supabase
        .from("invoices")
        .select("id, invoice_number, total, amount_paid, public_token, customers(name, email)")
        .eq("org_id", org.id)
        .in("status", ["sent", "partial"])
        .lt("due_date", today);
      for (const inv of invs ?? []) {
        const bal = invoiceBalance(inv.total, inv.amount_paid);
        if (bal <= 0.005) continue;
        const cust = (inv as any).customers;
        if (!cust?.email) { counts.skipped_no_email++; continue; }
        if (await suppress("invoice_due", inv.id, 7, 3)) continue;
        const html = renderReminderEmail({
          company: brand,
          customerName: cust.name || "there",
          heading: `Payment reminder — Invoice ${inv.invoice_number}`,
          message: `This is a friendly reminder that invoice ${inv.invoice_number} has an outstanding balance of ${money(bal)}, now past its due date. You can review and pay it securely using the button below.`,
          cta: inv.public_token ? { label: "View & pay invoice", link: `${site}/i/${inv.public_token}` } : undefined,
        });
        const r = await sendEmail({
          to: cust.email,
          subject: `Payment reminder: Invoice ${inv.invoice_number} from ${brand.name}`,
          fromName: brand.name,
          html,
          replyTo: brand.email ?? undefined,
        });
        if (r.ok && (await logSent("invoice_due", inv.id))) counts.invoice_due++;
      }
    }

    // 2) Quote follow-ups — sent + not yet accepted/declined, 3+ days since the quote
    // was last touched (updated_at tracks the status->sent transition, so it's far
    // closer to "time since sent" than created_at; no sent_at column exists yet); max 2.
    if (s.remind_quote_followup) {
      const cutoff = new Date(now - 3 * DAY).toISOString();
      const { data: qs } = await supabase
        .from("quotes")
        .select("id, quote_number, public_token, customers(name, email)")
        .eq("org_id", org.id)
        .eq("status", "sent")
        .lt("updated_at", cutoff);
      for (const q of qs ?? []) {
        const cust = (q as any).customers;
        if (!cust?.email) { counts.skipped_no_email++; continue; }
        if (await suppress("quote_followup", q.id, 7, 2)) continue;
        const html = renderReminderEmail({
          company: brand,
          customerName: cust.name || "there",
          heading: `Following up on Quote ${q.quote_number}`,
          message: `We wanted to follow up on the quote we sent over (${q.quote_number}). We'd be glad to answer any questions or get your project on the schedule whenever you're ready.`,
          cta: q.public_token ? { label: "View quote", link: `${site}/q/${q.public_token}` } : undefined,
        });
        const r = await sendEmail({
          to: cust.email,
          subject: `Following up on your quote from ${brand.name}`,
          fromName: brand.name,
          html,
          replyTo: brand.email ?? undefined,
        });
        if (r.ok && (await logSent("quote_followup", q.id))) counts.quote_followup++;
      }
    }

    // 3) Appointment reminders — scheduled, starting within ~36h, once only.
    if (s.remind_appointments) {
      const nowIso = new Date(now).toISOString();
      const horizon = new Date(now + 36 * 3_600_000).toISOString();
      const { data: appts } = await supabase
        .from("appointments")
        .select("id, title, starts_at, location, customers(name, email)")
        .eq("org_id", org.id)
        .eq("status", "scheduled")
        .gte("starts_at", nowIso)
        .lte("starts_at", horizon);
      for (const a of appts ?? []) {
        const cust = (a as any).customers;
        if (!cust?.email) { counts.skipped_no_email++; continue; }
        if (await suppress("appointment", a.id, 3650, 1)) continue;
        const when = new Date(a.starts_at).toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
        const html = renderReminderEmail({
          company: brand,
          customerName: cust.name || "there",
          heading: "Appointment reminder",
          message: `This is a reminder of your upcoming appointment${a.title ? ` (${a.title})` : ""} on ${when}${a.location ? ` at ${a.location}` : ""}. If you need to reschedule, just reply to this email${brand.phone ? ` or call us at ${brand.phone}` : ""}.`,
        });
        const r = await sendEmail({
          to: cust.email,
          subject: `Reminder: your upcoming appointment with ${brand.name}`,
          fromName: brand.name,
          html,
          replyTo: brand.email ?? undefined,
        });
        if (r.ok && (await logSent("appointment", a.id))) counts.appointment++;
      }
    }
  }
  return counts;
}
