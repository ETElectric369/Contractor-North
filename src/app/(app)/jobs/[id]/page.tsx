import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MapPin, User, FileText, ClipboardList, Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatCurrency, formatDate, formatDuration, hoursBetween } from "@/lib/utils";
import { JobDocuments } from "./job-documents";
import { ConvertButton } from "@/components/convert-button";
import { createInvoiceForJob } from "../actions";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: job } = await supabase
    .from("jobs")
    .select("*, customers(id, name, company_name)")
    .eq("id", id)
    .maybeSingle();
  if (!job) notFound();
  const j = job as any;

  const [{ data: quotes }, { data: workOrders }, { data: changeOrders }, { data: docRows }] =
    await Promise.all([
      supabase.from("quotes").select("id, quote_number, status, total").eq("job_id", id),
      supabase.from("work_orders").select("id, wo_number, title, status").eq("job_id", id),
      supabase.from("change_orders").select("id, co_number, amount, status").eq("job_id", id),
      supabase
        .from("documents")
        .select("id, name, category, file_url, size_bytes, created_at")
        .eq("job_id", id)
        .order("created_at", { ascending: false }),
    ]);

  // ── Job costing: revenue (invoiced/quoted) vs labor (hrs × rate) + materials (POs)
  const [{ data: invoices }, { data: pos }, { data: jobEntries }, { data: jobAllocs }] =
    await Promise.all([
      supabase.from("invoices").select("total, amount_paid").eq("job_id", id),
      supabase.from("purchase_orders").select("total").eq("job_id", id),
      supabase
        .from("time_entries")
        .select("clock_in, clock_out, lunch_minutes, status, profiles(hourly_rate), time_allocations(id)")
        .eq("job_id", id)
        .eq("status", "closed"),
      supabase
        .from("time_allocations")
        .select("hours, time_entries(profiles(hourly_rate))")
        .eq("job_id", id),
    ]);

  // Entry-level labor (only entries with NO per-job split, to avoid double count)
  let laborCost = 0;
  let laborHours = 0;
  for (const e of jobEntries ?? []) {
    if ((e as any).time_allocations?.length) continue;
    if (!e.clock_out) continue;
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    laborHours += h;
    laborCost += h * Number((e as any).profiles?.hourly_rate ?? 0);
  }
  // Allocation-level labor (per-job split at clock-out)
  for (const a of jobAllocs ?? []) {
    const h = Number((a as any).hours ?? 0);
    laborHours += h;
    laborCost += h * Number((a as any).time_entries?.profiles?.hourly_rate ?? 0);
  }

  const materialCost = (pos ?? []).reduce((s: number, p: any) => s + Number(p.total ?? 0), 0);
  const invoiced = (invoices ?? []).reduce((s: number, i: any) => s + Number(i.total ?? 0), 0);
  const quoted = (quotes ?? []).reduce((s: number, q: any) => s + Number(q.total ?? 0), 0);
  const revenue = invoiced > 0 ? invoiced : quoted;
  const cost = laborCost + materialCost;
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  // Sign each document URL for private access.
  const docs = await Promise.all(
    (docRows ?? []).map(async (d: any) => {
      const { data } = await supabase.storage
        .from("documents")
        .createSignedUrl(d.file_url, 3600);
      return { ...d, signedUrl: data?.signedUrl ?? null };
    }),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/schedule"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" /> Back to schedule
      </Link>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">{j.name}</h1>
          <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <span>{j.job_number}</span>
          {j.customers && (
            <Link href={`/crm/${j.customers.id}`} className="flex items-center gap-1 hover:text-brand">
              <User className="h-3.5 w-3.5" /> {j.customers.name}
            </Link>
          )}
          {j.address && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" /> {j.address}
            </span>
          )}
          {j.scheduled_start && <span>{formatDate(j.scheduled_start)}</span>}
        </div>
        {j.description && <p className="mt-3 text-sm text-slate-600">{j.description}</p>}
        </div>
        <ConvertButton
          label="Create invoice"
          run={createInvoiceForJob.bind(null, j.id)}
          hrefPrefix="/billing/"
        />
      </div>

      {/* Job costing */}
      <Card className="mb-6">
        <CardContent className="py-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Job costing</h3>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <div>
              <div className="text-lg font-bold text-slate-900">{formatCurrency(revenue)}</div>
              <div className="text-xs text-slate-500">{invoiced > 0 ? "Invoiced" : "Quoted"}</div>
            </div>
            <div>
              <div className="text-lg font-bold text-slate-900">{formatCurrency(laborCost)}</div>
              <div className="text-xs text-slate-500">Labor · {formatDuration(laborHours)}</div>
            </div>
            <div>
              <div className="text-lg font-bold text-slate-900">{formatCurrency(materialCost)}</div>
              <div className="text-xs text-slate-500">Materials (POs)</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                {formatCurrency(profit)}
              </div>
              <div className="text-xs text-slate-500">Profit</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                {margin.toFixed(0)}%
              </div>
              <div className="text-xs text-slate-500">Margin</div>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Labor uses each teammate's hourly rate (set in their profile); materials from purchase orders linked to this job.
          </p>
        </CardContent>
      </Card>

      {/* Receipts & documents */}
      <Card className="mb-6">
        <CardContent className="py-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Receipt className="h-4 w-4 text-slate-400" /> Receipts &amp; documents
          </h3>
          <JobDocuments orgId={j.org_id} jobId={j.id} docs={docs} />
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            <FileText className="h-4 w-4 text-slate-400" /> Quotes
          </div>
          <ul className="divide-y divide-slate-100">
            {(quotes ?? []).map((q: any) => (
              <li key={q.id}>
                <Link href={`/quotes/${q.id}`} className="flex items-center justify-between px-5 py-2.5 text-sm hover:bg-slate-50">
                  <span>{q.quote_number}</span>
                  <span className="text-slate-500">{formatCurrency(q.total)}</span>
                </Link>
              </li>
            ))}
            {(!quotes || quotes.length === 0) && (
              <li className="px-5 py-4 text-center text-xs text-slate-400">None</li>
            )}
          </ul>
        </Card>

        <Card>
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            <ClipboardList className="h-4 w-4 text-slate-400" /> Work orders
          </div>
          <ul className="divide-y divide-slate-100">
            {(workOrders ?? []).map((w: any) => (
              <li key={w.id}>
                <Link href={`/work-orders/${w.id}`} className="flex items-center justify-between px-5 py-2.5 text-sm hover:bg-slate-50">
                  <span className="truncate">{w.wo_number}</span>
                  <Badge tone={statusTone(w.status)}>{w.status.replace("_", " ")}</Badge>
                </Link>
              </li>
            ))}
            {(!workOrders || workOrders.length === 0) && (
              <li className="px-5 py-4 text-center text-xs text-slate-400">None</li>
            )}
          </ul>
        </Card>

        <Card>
          <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
            Change orders
          </div>
          <ul className="divide-y divide-slate-100">
            {(changeOrders ?? []).map((c: any) => (
              <li key={c.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span>{c.co_number}</span>
                <span className="text-slate-500">{formatCurrency(c.amount)}</span>
              </li>
            ))}
            {(!changeOrders || changeOrders.length === 0) && (
              <li className="px-5 py-4 text-center text-xs text-slate-400">None</li>
            )}
          </ul>
        </Card>
      </div>
    </div>
  );
}
