import Link from "next/link";
import { notFound } from "next/navigation";
import { Home, ChevronRight, MapPin, Calendar, Receipt, Plus } from "lucide-react";
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
import { JobPhotos } from "./job-photos";
import { JobNotes } from "./job-notes";
import { JobBills } from "./job-bills";
import { JobTasks } from "./job-tasks";
import { JobPermits } from "./job-permits";
import { JobAddTimeEntry } from "./job-add-time";
import { JobStatusControl } from "./job-status-control";
import { JobEditButton } from "./job-edit-button";
import { JobScheduleControl } from "./job-schedule-control";
import { FinishJobButton } from "./finish-job-button";
import { ProposeDatesButton } from "./propose-dates-button";
import { NewWorkOrderButton } from "../../work-orders/new-wo-button";
import { NewPoButton } from "../../purchasing/new-po-button";
import { ConvertButton } from "@/components/convert-button";
import { DeleteButton } from "@/components/delete-button";
import { EditCustomerButton } from "../../crm/[id]/edit-customer-button";
import { createInvoiceForJob, deleteJob } from "../actions";
import { getOrgSettings } from "@/lib/org-settings";
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
    { data: bills },
    { data: tasks },
    { data: permits },
  ] = await Promise.all([
    supabase.from("quotes").select("id, quote_number, status, total").eq("job_id", id),
    supabase.from("work_orders").select("id, wo_number, title, status").eq("job_id", id),
    supabase.from("change_orders").select("id, co_number, amount, status").eq("job_id", id),
    supabase.from("invoices").select("id, invoice_number, status, total, amount_paid").eq("job_id", id),
    supabase.from("purchase_orders").select("id, po_number, vendor, status, total").eq("job_id", id),
    supabase
      .from("time_entries")
      .select("id, clock_in, clock_out, lunch_minutes, miles, status, job_code, profiles(full_name, hourly_rate), time_allocations(id, hours, job_code)")
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
    supabase
      .from("bills")
      .select("id, supplier, bill_number, amount, status, bill_date")
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("tasks")
      .select("id, title, category, status, priority, due_date")
      .eq("job_id", id)
      .order("status", { ascending: true })
      .order("priority", { ascending: false })
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("permits")
      .select("id, permit_number, type, authority, status, applied_date, issued_date, inspection_date, inspector, inspection_result, fee, notes, portal_url")
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
  ]);

  const { data: pendingProposal } = await supabase
    .from("schedule_proposals")
    .select("id, token, dates")
    .eq("job_id", id)
    .eq("status", "pending")
    .maybeSingle();

  const { data: scheduleSegments } = await supabase
    .from("job_schedule_segments")
    .select("start_date, end_date")
    .eq("job_id", id)
    .order("start_date");

  const { data: jobLists } = await supabase
    .from("material_lists")
    .select("id, name, created_at, material_list_items(count)")
    .eq("job_id", id)
    .order("created_at", { ascending: false });

  // Extra data for the per-tab "Add" buttons.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ data: techs }, { data: jobCodes }, { data: lists }, { data: org }, { data: allCustomers }] = await Promise.all([
    supabase.from("profiles").select("id, full_name").order("full_name"),
    supabase.from("job_codes").select("*").order("code"),
    supabase.from("material_lists").select("id, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("organizations").select("address_line1, city, state, zip, settings").limit(1).maybeSingle(),
    supabase.from("customers").select("id, name").order("name"),
  ]);
  const thisJobOpt = [{ id: j.id, job_number: j.job_number, name: j.name }];
  const companyAddress = [org?.address_line1, org?.city, org?.state, org?.zip].filter(Boolean).join(", ");
  const jobAddress = [j.address, j.city, j.state, j.zip].filter(Boolean).join(", ");
  const mileageRate = getOrgSettings((org as any)?.settings).mileage_rate;

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
  const billsCost = (bills ?? []).reduce((s: number, b: any) => s + Number(b.amount ?? 0), 0);
  const totalMiles = (entries ?? []).reduce((s: number, e: any) => s + Number(e.miles ?? 0), 0);
  const mileageCost = totalMiles * mileageRate;
  const invoiced = (invoices ?? []).reduce((s: number, i: any) => s + Number(i.total ?? 0), 0);
  const quoted = (quotes ?? []).reduce((s: number, q: any) => s + Number(q.total ?? 0), 0);
  const revenue = invoiced > 0 ? invoiced : quoted;
  const profit = revenue - laborCost - materialCost - billsCost - mileageCost;
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
                <div className="sm:col-span-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Scheduled</div>
                  <div className="mt-1">
                    <JobScheduleControl id={j.id} start={j.scheduled_start} end={j.scheduled_end} segments={(scheduleSegments ?? []) as any} />
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
            <JobNotes jobId={j.id} orgId={j.org_id} notes={j.notes} />
          </CardContent>
        </Card>
      ),
    },
    {
      id: "photos",
      label: "Photos",
      count: docs.filter((d: any) => /\.(jpe?g|png|webp|gif|heic)($|\?)/i.test(d.signedUrl ?? d.name)).length,
      content: (
        <Card>
          <CardContent className="py-5">
            <JobPhotos orgId={j.org_id} jobId={j.id} docs={docs} />
          </CardContent>
        </Card>
      ),
    },
    {
      id: "tasks",
      label: "Tasks",
      count: (tasks ?? []).filter((t: any) => t.status !== "done").length,
      content: (
        <Card>
          <CardContent className="py-5">
            <JobTasks jobId={j.id} tasks={(tasks ?? []) as any} />
          </CardContent>
        </Card>
      ),
    },
    {
      id: "permits",
      label: "Permits",
      count: permits?.length ?? 0,
      content: (
        <Card>
          <CardContent className="py-5">
            <JobPermits jobId={j.id} permits={(permits ?? []) as any} />
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
            <span className="font-semibold text-slate-900">Time on this job · {formatDuration(laborHours)}</span>
            <JobAddTimeEntry
              jobId={j.id}
              techs={techs ?? []}
              jobCodes={(jobCodes ?? []) as any}
              defaultProfileId={user?.id ?? ""}
              companyAddress={companyAddress}
              jobAddress={jobAddress}
              mileageRate={mileageRate}
            />
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
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
                <div><div className="text-lg font-bold text-slate-900">{formatCurrency(revenue)}</div><div className="text-xs text-slate-500">{invoiced > 0 ? "Invoiced" : "Quoted"}</div></div>
                <div><div className="text-lg font-bold text-slate-900">{formatCurrency(laborCost)}</div><div className="text-xs text-slate-500">Labor · {formatDuration(laborHours)}</div></div>
                <div><div className="text-lg font-bold text-slate-900">{formatCurrency(materialCost)}</div><div className="text-xs text-slate-500">Materials</div></div>
                <div><div className="text-lg font-bold text-slate-900">{formatCurrency(billsCost)}</div><div className="text-xs text-slate-500">Bills</div></div>
                <div><div className="text-lg font-bold text-slate-900">{formatCurrency(mileageCost)}</div><div className="text-xs text-slate-500">Mileage · {totalMiles} mi</div></div>
                <div><div className={`text-lg font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{formatCurrency(profit)}</div><div className="text-xs text-slate-500">Profit</div></div>
                <div><div className={`text-lg font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{margin.toFixed(0)}%</div><div className="text-xs text-slate-500">Margin</div></div>
              </div>
            </CardContent>
          </Card>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
              <span className="text-sm font-semibold text-slate-900">Material purchase orders</span>
              <NewPoButton jobs={thisJobOpt} lists={lists ?? []} />
            </div>
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

          <Card>
            <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">Supplier bills</div>
            <CardContent className="py-5">
              <JobBills jobId={j.id} bills={(bills ?? []) as any} />
            </CardContent>
          </Card>

          <Card>
            <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">
              <Receipt className="h-4 w-4 text-slate-400" /> Receipts &amp; documents
            </div>
            <CardContent className="py-5">
              <JobDocuments orgId={j.org_id} jobId={j.id} docs={docs} />
            </CardContent>
          </Card>
        </div>
      ),
    },
    {
      id: "materials",
      label: "Materials",
      count: jobLists?.length ?? 0,
      content: (
        <div className="space-y-3">
          {(jobLists ?? []).length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm text-slate-500">No material lists yet.</p>
                <p className="mt-1 text-xs text-slate-400">
                  Open a quote and tap <span className="font-medium">Build material list</span> to generate a take-off from its line items.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-slate-100">
                {(jobLists ?? []).map((ml: any) => {
                  const count = ml.material_list_items?.[0]?.count ?? 0;
                  return (
                    <li key={ml.id}>
                      <Link href={`/materials/${ml.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
                        <span className="font-medium text-slate-900">{ml.name}</span>
                        <span className="text-slate-500">{count} {count === 1 ? "item" : "items"}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      ),
    },
    {
      id: "quotes",
      label: "Quotes",
      count: quotes?.length ?? 0,
      content: (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Link
              href={`/quotes/new?customer=${j.customer_id ?? ""}&job=${j.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              <Plus className="h-3.5 w-3.5" /> New quote
            </Link>
          </div>
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
        </div>
      ),
    },
    {
      id: "invoices",
      label: "Invoices",
      count: invoices?.length ?? 0,
      content: (
        <div className="space-y-3">
          <div className="flex justify-end">
            <ConvertButton
              label="Create invoice"
              run={createInvoiceForJob.bind(null, j.id)}
              hrefPrefix="/billing/"
            />
          </div>
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
        </div>
      ),
    },
    {
      id: "wos",
      label: "Work Orders",
      count: workOrders?.length ?? 0,
      content: (
        <div className="space-y-3">
          <div className="flex justify-end">
            <NewWorkOrderButton jobs={thisJobOpt} techs={techs ?? []} defaultJob={j.id} autoOpen={false} />
          </div>
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
        </div>
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
        <div className="flex flex-wrap items-center gap-2">
          {j.status !== "complete" && j.status !== "invoiced" && j.status !== "cancelled" && (
            <>
              <ProposeDatesButton
                jobId={j.id}
                customerPhone={j.customers?.phone}
                pending={(pendingProposal as any) ?? null}
              />
              <FinishJobButton jobId={j.id} hasQuote={(quotes ?? []).length > 0} />
            </>
          )}
          <JobEditButton job={j} customers={allCustomers ?? []} techs={techs ?? []} />
          <ConvertButton
            label="Create invoice"
            run={createInvoiceForJob.bind(null, j.id)}
            hrefPrefix="/billing/"
          />
          <DeleteButton
            run={deleteJob.bind(null, j.id)}
            confirmText={`Delete job ${j.job_number}? Time entries, quotes, and invoices keep their data but lose the job link.`}
            redirectTo="/jobs"
          />
        </div>
      </div>

      <Tabs tabs={tabs} />
    </div>
  );
}
