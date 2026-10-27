import { createClient } from "@/lib/supabase/server";
import { formatDate, DEFAULT_TIMEZONE } from "@/lib/utils";
import { todayStrInTz } from "@/lib/tz";
import { jobLabel } from "@/lib/schedule-options";
import { JOB_STATUS_PRIORITY } from "@/lib/job-status";

export const runtime = "nodejs";

/**
 * LIVE WORK FIRST (cn-v1128): the jobs read comes back newest-first from the database; this keeps
 * that order inside each status and puts the statuses in the dock's spine order (in progress,
 * scheduled, to be scheduled, on hold, complete, cancelled last). sort() is stable. The deep
 * review's search-02: a broad word returned an arbitrary few, old and cancelled included.
 */
function liveFirst<T extends { status?: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (JOB_STATUS_PRIORITY[a.status ?? ""] ?? 9) - (JOB_STATUS_PRIORITY[b.status ?? ""] ?? 9));
}

/**
 * Global search for the command bar. Runs through the caller's own RLS-scoped
 * session, so results are automatically limited to their organization. Read-only.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ results: [] }, { status: 401 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").replace(/[,()%*]/g, " ").trim().slice(0, 60);
  if (!q) return Response.json({ results: [] });
  const like = `%${q}%`;

  const [jobs, customers, quotes, invoices, appointments] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, job_number, name, status")
      .or(`name.ilike.${like},job_number.ilike.${like}`)
      .order("updated_at", { ascending: false })
      .limit(12),
    supabase
      .from("customers")
      .select("id, name, company_name")
      .or(`name.ilike.${like},company_name.ilike.${like}`)
      .order("updated_at", { ascending: false })
      .limit(5),
    supabase
      .from("quotes")
      .select("id, quote_number, title, status")
      .or(`quote_number.ilike.${like},title.ilike.${like}`)
      .order("updated_at", { ascending: false })
      .limit(5),
    supabase
      .from("invoices")
      .select("id, invoice_number, status")
      .ilike("invoice_number", like)
      .order("updated_at", { ascending: false })
      .limit(5),
    // Past appointments included on purpose — "when WAS the oven visit" is the
    // seek question; hits deep-link to the calendar's day drill.
    supabase
      .from("appointments")
      .select("id, title, starts_at, customers(name), jobs(job_number, name)")
      .ilike("title", like)
      .neq("status", "cancelled")
      // A visit waiting for a day (no start, 0368) sorts after the dated ones.
      .order("starts_at", { ascending: false, nullsFirst: false })
      .limit(5),
  ]);

  const results = [
    ...liveFirst(jobs.data ?? []).slice(0, 6).map((j: any) => ({
      type: "Job",
      label: jobLabel(j),
      sub: j.status,
      href: `/jobs/${j.id}`,
    })),
    ...(customers.data ?? []).map((c: any) => ({
      type: "Customer",
      label: c.name,
      sub: c.company_name ?? undefined,
      href: `/crm/${c.id}`,
    })),
    ...(quotes.data ?? []).map((qt: any) => ({
      type: "Quote",
      label: `${qt.quote_number}${qt.title ? ` · ${qt.title}` : ""}`,
      sub: qt.status,
      href: `/quotes/${qt.id}`,
    })),
    ...(invoices.data ?? []).map((iv: any) => ({
      type: "Invoice",
      label: iv.invoice_number,
      sub: iv.status,
      href: `/billing/${iv.id}`,
    })),
    ...(appointments.data ?? []).map((a: any) => ({
      type: "Appointment",
      label: a.title,
      // WHEN is the answer being sought — lead the sub with the date.
      sub: [a.starts_at ? formatDate(a.starts_at) : "Waiting For A Day", a.customers?.name ?? (a.jobs ? `${a.jobs.job_number} ${a.jobs.name}` : null)]
        .filter(Boolean)
        .join(" · "),
      // A visit waiting for a day has no day to drill into (never the calendar's 1970): its own page.
      href: a.starts_at ? `/schedule?view=day&date=${todayStrInTz(DEFAULT_TIMEZONE, new Date(a.starts_at))}` : `/appointments/${a.id}`,
    })),
  ];

  return Response.json({ results });
}
