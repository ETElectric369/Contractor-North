import Link from "next/link";
import { notFound } from "next/navigation";
import { Home, ChevronRight, MapPin, User, Calendar, Receipt } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Tabs } from "@/components/tabs";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  hoursBetween,
  initials,
} from "@/lib/utils";
import { JobDocuments } from "./job-documents";
import { JobNotes } from "./job-notes";
import { JobStatusControl } from "./job-status-control";
import { ConvertButton } from "@/components/convert-button";
import { EditCustomerButton } from "../../crm/[id]/edit-customer-button";
import { createInvoiceForJob } from "../actions";
import type { Customer } from "@/lib/types";

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
    .select("*, customers(*)")
    .eq("id", id)
    .maybeSingle();
  if (!job) notFound();
  const j = job as any;

  const [
    { data: quotes },
    { data: workOrders },
    { data: changeOrders },
    { data: invoices },
    { data: pos },
    { data: entries },
    { data: docRows },
    { data: staff },
  ] = await Promise.all([
    supabase.from("quotes").select("id, quote_number, status, total").eq("job_id", id),
    supabase.from("work_orders").select("id, wo_number, title, status").eq("job_id", id),
    supabase.from("change_orders").select("id, co_number, amount, status").eq("job_id", id),
    supabase.from("invoices").select("id, invoice_number, status, total, amount_paid").eq("job_id", id),
    supabase.from("purchase_orders").select("id, po_number, vendor, status, total").eq("job_id", id),
    supabase
      .from("time_entries")
      .select("id, clock_in, clock_out, lunch_minutes, status, job_code, profiles(full_name, hourly_rate), time_allocations(id, hours, job_code)")
      .eq("job_id", id)
      .order("clock_in", { ascending: false }),
    supabase
      .from("documents")
      .select("id, name, category, file_url, size_bytes, created_at")
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
    j.assigned_to?.length
      ? supabase.from("profiles").select("id, full_name").in("id", j.assigned_to)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  // Costing
  let laborCost = 0;
  let laborHours = 0;
  for (const e of entries ?? []) {
    if ((e as any).time_allocations?.length) {
      for (const a of (e as any).time_allocations)
        laborHours += Number(a.hours ?? 0);
      // allocation cost uses this entry's rate
      const rate = Number((e as any).profiles?.hourly_rate ?? 0);
      for (const a of (e as any).time_allocations)
        laborCost += Number(a.hours ?? 0) * rate;
      continue;
    }
    if (e.status === "closed" && e.clock_out) {
      const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
      laborHours += h;
      laborCost += h * Number((e as any).profiles?.hourly_rate ?? 0);
    }
  }
  const materialCost = (pos ?? []).reduce((s: number, p: any) => s + Number(p.total ?? 0), 0);
  const invoiced = (invoices ?? []).reduce((s: number, i: any) => s + Number(i.total ?? 0), 0);
  const quoted = (quotes ?? []).reduce((s: number, q: any) => s + Number(q.total ?? 0), 0);
  const revenue = invoiced > 0 ? invoiced : quoted;
  const profit = revenue - laborCost - materialCost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  const docs = await Promise.all(
    (docRows ?? []).map(async (d: any) => {
      const { data } = await supabase.storage.from("documents").createSignedUrl(d.file_url, 3600);
      return { ...d, signedUrl: data?.signedUrl ?? null };
    }),
  );

  const empty = (label: string) => (
    <p className="px-1 py-6 text-center text-sm text-slate-400">No {label} yet.</p>
  );

  const tabs = [
    {
      id: "job",
      label: "Job",
      content: (
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 py-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Customer</div>
                  <div className="mt-1 flex items-center gap-2">
                    {j.customers ? (
                      <>
                        <Link href={`/crm/${j.customers.id}`} className="text-sm font-medium text-slate-900 hover:text-brand">
                          {j.customers.name}
                        </Link>
                        <EditCustomerButton customer={j.customers as Customer} />
                      </>
                    ) : (
                      <span className="text-sm text-slate-400">—</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</div>
                  <div className="mt-1">
                    <JobStatusControl id={j.id} status={j.status} />
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Address</div>
                  <div className="mt-1 flex items-center gap-1 text-sm text-slate-700">
                    {j.address ? (
                      <>
                        <MapPin className="h-3.5 w-3.5 text-slate-400" /> {j.address}
                        {[j.city, j.state, j.zip].filter(Boolean).length > 0 && (
                          <span>· {[j.city, j.state, j.zip].filter(Boolean).join(", ")}</span>
                        )}
                      </>
                    ) : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Scheduled</div>
                  <div className="mt-1 flex items-center gap-1 text-sm text-slate-700">
                    <Calendar className="h-3.5 w-3.5 text-slate-400" />
                    {j.scheduled_start ? formatDateTime(j.scheduled_start) : "—"}
                  </div>
                </div>
              </div>
              {j.description && (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Description</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{j.description}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Assigned staff</div>
              <div className="flex flex-wrap gap-2">
                {(staff ?? []).length === 0 && <span className="text-sm text-slate-400">Unassigned</span>}
                {(staff ?? []).map((s: any) => (
                  <span key={s.id} className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-[10px] font-semibold text-white">
                      {initials(s.full_name)}
                    </span>
                    {s.full_name}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      id: "notes",
      label: "Notes",
      content: (
        <Card>
          <CardContent className="py-5">
            <JobNotes jobId={j.id} notes={j.notes} />
          </CardContent>
        </Card>
      ),
    },
    {
      id: "time",
      label: "Time",
      count: entries?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 text-sm">
            <span className="font-semibold text-slate-900">Time on this job</span>
            <span className="font-medium text-slate-700">{formatDuration(laborHours)}</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {(entries ?? []).map((e: any) => {
              const h = e.status === "closed" && e.clock_out
                ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : null;
              return (
                <li key={e.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                  <div>
                    <span className="text-slate-700">{formatDate(e.clock_in)}</span>
                    <span className="ml-2 text-slate-500">{e.profiles?.full_name ?? "—"}</span>
                    {e.job_code && <Badge tone="slate" className="ml-2">{e.job_code}</Badge>}
                  </div>
                  <span className="font-medium text-slate-800">{h != null ? formatDuration(h) : "open"}</span>
                </li>
              );
            })}
            {(!entries || entries.length === 0) && empty("time entries")}
          </ul>
        </Card>
      ),
    },
    {
      id: "costs",
      label: "Costs",
      content: (
        <div className="space-y-4">
          <Card>
            <CardContent className="py-5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                <div><div className="text-lg font-bold text-slate-900">{formatCurrency(revenue)}</div><div className="text-xs text-slate-500">{invoiced > 0 ? "Invoiced" : "Quoted"}</div></div>
                <div><div className="text-lg font-bold text-slate-900">{formatCurrency(laborCost)}</div><div className="text-xs text-slate-500">Labor · {formatDuration(laborHours)}</div></div>
                <div><div className="text-lg font-bold text-slate-900">{formatCurrency(materialCost)}</div><div className="text-xs text-slate-500">Materials</div></div>
                <div><div className={`text-lg font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{formatCurrency(profit)}</div><div className="text-xs text-slate-500">Profit</div></div>
                <div><div className={`text-lg font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{margin.toFixed(0)}%</div><div className="text-xs text-slate-500">Margin</div></div>
              </div>
            </CardContent>
          </Card>
          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">Material purchase orders</div>
            <ul className="divide-y divide-slate-100">
              {(pos ?? []).map((p: any) => (
                <li key={p.id}>
                  <Link href={`/purchasing/${p.id}`} className="flex items-center justify-between px-5 py-2.5 text-sm hover:bg-slate-50">
                    <span>{p.po_number} · {p.vendor}</span>
                    <span className="text-slate-700">{formatCurrency(p.total)}</span>
                  </Link>
                </li>
              ))}
              {(!pos || pos.length === 0) && empty("purchase orders")}
            </ul>
          </Card>
        </div>
      ),
    },
    {
      id: "quotes",
      label: "Quotes",
      count: quotes?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(quotes ?? []).map((q: any) => (
              <li key={q.id}>
                <Link href={`/quotes/${q.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
                  <span className="font-medium text-slate-900">{q.quote_number}</span>
                  <span className="flex items-center gap-3"><span className="text-slate-600">{formatCurrency(q.total)}</span><Badge tone={statusTone(q.status)}>{q.status}</Badge></span>
                </Link>
              </li>
            ))}
            {(!quotes || quotes.length === 0) && empty("quotes")}
          </ul>
        </Card>
      ),
    },
    {
      id: "invoices",
      label: "Invoices",
      count: invoices?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(invoices ?? []).map((iv: any) => (
              <li key={iv.id}>
                <Link href={`/billing/${iv.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
                  <span className="font-medium text-slate-900">{iv.invoice_number}</span>
                  <span className="flex items-center gap-3"><span className="text-slate-600">{formatCurrency(iv.total)}</span><Badge tone={statusTone(iv.status)}>{iv.status}</Badge></span>
                </Link>
              </li>
            ))}
            {(!invoices || invoices.length === 0) && empty("invoices")}
          </ul>
        </Card>
      ),
    },
    {
      id: "wos",
      label: "Work Orders",
      count: workOrders?.length ?? 0,
      content: (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(workOrders ?? []).map((w: any) => (
              <li key={w.id}>
                <Link href={`/work-orders/${w.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
                  <span><span className="font-medium text-slate-900">{w.wo_number}</span> <span className="text-slate-500">{w.title}</span></span>
                  <Badge tone={statusTone(w.status)}>{w.status.replace("_", " ")}</Badge>
                </Link>
              </li>
            ))}
            {(!workOrders || workOrders.length === 0) && empty("work orders")}
          </ul>
        </Card>
      ),
    },
    {
      id: "receipts",
      label: "Receipts",
      count: docs.length,
      content: (
        <Card>
          <CardContent className="py-5">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Receipt className="h-4 w-4 text-slate-400" /> Receipts &amp; documents
            </h3>
            <JobDocuments orgId={j.org_id} jobId={j.id} docs={docs} />
          </CardContent>
        </Card>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center gap-1.5 text-sm text-slate-500">
        <Link href="/dashboard" className="hover:text-slate-800"><Home className="h-4 w-4" /></Link>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
        <Link href="/jobs" className="hover:text-slate-800">Jobs</Link>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
        <span className="font-medium text-slate-700">{j.job_number}</span>
      </div>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{j.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-400">
            <span>{j.job_number}</span>
            <Badge tone={statusTone(j.status)}>{j.status.replace("_", " ")}</Badge>
          </div>
        </div>
        <ConvertButton
          label="Create invoice"
          run={createInvoiceForJob.bind(null, j.id)}
          hrefPrefix="/billing/"
        />
      </div>

      <Tabs tabs={tabs} />
    </div>
  );
}
