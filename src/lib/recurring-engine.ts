import "server-only";
import { reportError } from "@/lib/observe";

/** The recurring jobs/expenses generation engine, extracted so BOTH the in-app
 *  "Generate" buttons (user client, RLS-scoped to one org) and the daily cron
 *  (service client, all orgs) run the exact same logic. */

/** Advance a yyyy-mm-dd date by one period of the given frequency. */
export function advance(date: string, frequency: string): string {
  const d = new Date(`${date}T12:00:00`);
  switch (frequency) {
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "biweekly": d.setDate(d.getDate() + 14); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Create one occurrence (a job or an expense bill) from a template and advance
 *  its next_date. org_id is set EXPLICITLY from the template: under the service
 *  client (the cron) there is no auth context, so the set_org_id trigger can't
 *  infer the tenant — an explicit org_id is what keeps cron-generated rows in the
 *  right org (and it's a harmless no-op for the user path, which sets the same id).
 *  Returns false on insert error. */
export async function runTemplate(supabase: any, t: any, userId: string | null): Promise<boolean> {
  if (t.kind === "job") {
    const { error } = await supabase.from("jobs").insert({
      org_id: t.org_id,
      name: t.title,
      customer_id: t.customer_id,
      description: t.description,
      status: "scheduled",
      scheduled_start: new Date(`${t.next_date}T08:00:00`).toISOString(),
      scheduled_end: new Date(`${t.next_date}T16:00:00`).toISOString(),
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
  await supabase
    .from("recurring_templates")
    .update({ next_date: advance(t.next_date, t.frequency), last_generated_at: new Date().toISOString() })
    .eq("id", t.id);
  return true;
}

/** Generate every active template that is due (next_date on or before today),
 *  catching up multiple overdue periods (capped at 24 to avoid runaways). Works
 *  with ANY client: a user client (RLS scopes the select to their org) or the
 *  service client (sees all orgs — for the cron). Cron rows are attributed to the
 *  template's creator. Returns how many occurrences were created. */
export async function generateDueTemplates(supabase: any, userId: string | null): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: due } = await supabase
    .from("recurring_templates")
    .select("*")
    .eq("active", true)
    .lte("next_date", today);
  let count = 0;
  for (const t of due ?? []) {
    let guard = 0;
    let cur = { ...t };
    while (cur.next_date <= today && guard++ < 24) {
      const ok = await runTemplate(supabase, cur, userId ?? t.created_by ?? null);
      if (!ok) break;
      cur = { ...cur, next_date: advance(cur.next_date, cur.frequency) };
      count++;
    }
  }
  return count;
}
