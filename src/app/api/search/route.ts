import { createClient } from "@/lib/supabase/server";

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

  const [jobs, customers, quotes, invoices] = await Promise.all([
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
  ];

  return Response.json({ results });
}
