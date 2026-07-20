import { getOrgSettings } from "@/lib/org-settings";
import { tzLocalHourUtc, todayStrInTz } from "@/lib/tz";

/** Pure: default invoice due date = today (in the org tz) + the org's net terms, stamped
 *  to NOON in the org tz (same convention as setInvoiceDueDate / payment dates). Net terms
 *  come from the org's invoice_due_days setting; unset/0 falls back to Net 30.
 *
 *  Start from today in the org tz so "+net days" lands on the right calendar day, then
 *  shift forward by netDays of local-midnight days and stamp noon in the org tz. */
export function dueDateIsoFromSettings(settingsRaw: unknown, now: Date = new Date()): string {
  const settings = getOrgSettings(settingsRaw);
  const tz = settings.timezone || "America/Los_Angeles";
  const netDays = settings.invoice_due_days > 0 ? settings.invoice_due_days : 30;
  const todayStart = tzLocalHourUtc(todayStrInTz(tz, now), 0, tz);
  const dueStr = todayStrInTz(tz, new Date(todayStart.getTime() + netDays * 86_400_000));
  return tzLocalHourUtc(dueStr, 12, tz).toISOString();
}

/** THE invoice due date for one org. Without a due date the Overdue tracker never fires
 *  (billing-pipeline, computeArAging and the reminders cron all filter `due_date < today`,
 *  and SQL's `<` drops NULL entirely), so EVERY creation path stamps one — including the
 *  unattended recurring-invoice cron, which used to leave it NULL and quietly parked months
 *  of unpaid service-agreement invoices under "Current — not yet due", never chased.
 *
 *  Pass `orgId` when the caller has no auth context (the service-role cron reads EVERY
 *  org's row, so an unfiltered maybeSingle() would grab an arbitrary org's timezone and
 *  net terms). Omit it on a user client — RLS already scopes the read to one org. */
export async function defaultDueDateIsoForOrg(
  supabase: { from: (t: string) => any },
  orgId?: string | null,
): Promise<string> {
  const base = supabase.from("organizations").select("settings");
  const { data } = await (orgId ? base.eq("id", orgId) : base).maybeSingle();
  return dueDateIsoFromSettings((data as { settings?: unknown } | null)?.settings);
}
