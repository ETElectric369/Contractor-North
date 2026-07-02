import { createClient } from "@/lib/supabase/server";
import { formatDate, DEFAULT_TIMEZONE } from "@/lib/utils";
import { todayStrInTz } from "@/lib/tz";

export const runtime = "nodejs";

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
      .limit(6),
    supabase
      .from("customers")
      .select("id, name, company_name")
      .or(`name.ilike.${like},company_name.ilike.${like}`)
      .limit(5),
    supabase
      .from("quotes")
      .select("id, quote_number, title, status")
      .or(`quote_number.ilike.${like},title.ilike.${like}`)
      .limit(5),
    supabase
      .from("invoices")
      .select("id, invoice_number, status")
      .ilike("invoice_number", like)
      .limit(5),
    // Past appointments included on purpose — "when WAS the oven visit" is the
    // seek question; hits deep-link to the calendar's day drill.
    supabase
      .from("appointments")
      .select("id, title, starts_at, customers(name), jobs(job_number, name)")
      .ilike("title", like)
      .neq("status", "cancelled")
      .order("starts_at", { ascending: false })
      .limit(5),
  ]);

  const results = [
    ...(jobs.data ?? []).map((j: any) => ({
      type: "Job",
      label: `${j.job_number} · ${j.name}`,
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
      sub: [formatDate(a.starts_at), a.customers?.name ?? (a.jobs ? `${a.jobs.job_number} ${a.jobs.name}` : null)]
        .filter(Boolean)
        .join(" · "),
      href: `/schedule?view=day&date=${todayStrInTz(DEFAULT_TIMEZONE, new Date(a.starts_at))}`,
    })),
  ];

  return Response.json({ results });
}
