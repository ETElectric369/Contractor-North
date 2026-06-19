import Link from "next/link";
import { notFound } from "next/navigation";
import { Home, ChevronRight, MapPin, Calendar, Receipt, Plus, Printer } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Tabs, type TabDef } from "@/components/tabs";
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
import { JobClockButton } from "./job-clock-button";
import { EditEntryButton } from "../../timecards/edit-entry-button";
import { JobStatusControl } from "./job-status-control";
import { JobEditButton } from "./job-edit-button";
import { JobScheduleControl } from "./job-schedule-control";
import { FinishJobButton } from "./finish-job-button";
import { ProposeDatesButton } from "./propose-dates-button";
import { ProgressInvoiceButton } from "./progress-invoice-button";
import { NewWorkOrderButton } from "../../work-orders/new-wo-button";
import { NewChangeOrderButton } from "../../change-orders/new-co-button";
import { CoStatusControl } from "../../change-orders/co-status-control";
import { CoRowActions } from "../../change-orders/co-row-actions";
import { NewListButton } from "../../materials/new-list-button";
import { AppointmentButton } from "../../appointments/appointment-button";
import { NewPoButton } from "../../purchasing/new-po-button";
import { ConvertButton } from "@/components/convert-button";
import { DeleteButton } from "@/components/delete-button";
import { EditCustomerButton } from "../../crm/[id]/edit-customer-button";
import { createInvoiceForJob, deleteJob } from "../actions";
import { getOrgSettings } from "@/lib/org-settings";
import { formatDateTz } from "@/lib/tz";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

// In-page nav order, grouped frequency-of-use then role. The tabs a tech touches
// every visit stay visible; everything financial/closeout collapses into "More".
// Materials rides up front (2nd) — it's a daily-use take-off list.
const JOB_TAB_ORDER = [
  "job", "materials", "tasks", "photos", "time", "appointments", "notes",
  "permits", "quotes", "costs", "invoices", "change-orders", "wos",
];
const JOB_PRIMARY = new Set(["job", "materials", "tasks", "photos", "time", "appointments", "notes"]);
const JOB_STAFF_ONLY = new Set(["costs", "quotes", "invoices", "change-orders"]);

/** Order the job tabs and tag each with its tier + staff-gating, so <Tabs> shows
 *  6 primary tabs + a "More" menu and hides money tabs from techs itself. */
function arrangeJobTabs(tabs: TabDef[]): TabDef[] {
  return [...tabs]
    .sort((a, b) => JOB_TAB_ORDER.indexOf(a.id) - JOB_TAB_ORDER.indexOf(b.id))
    .map((t) => ({
      ...t,
      tier: JOB_PRIMARY.has(t.id) ? ("primary" as const) : ("overflow" as const),
      staffOnly: JOB_STAFF_ONLY.has(t.id),
    }));
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("*, customers(*)")
    .eq("id", id)
    .maybeSingle();
  if (jobErr) throw jobErr; // a real failure shouldn't masquerade as 404
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
    supabase.from("quotes").select("id, quote_number, status, total, doc_type").eq("job_id", id),
    supabase.from("work_orders").select("id, wo_number, title, status").eq("job_id", id),
    supabase.from("change_orders").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("invoices").select("id, invoice_number, status, total, amount_paid").eq("job_id", id),
    supabase.from("purchase_orders").select("id, po_number, vendor, status, total").eq("job_id", id),
    supabase
      .from("time_entries")
      .select("id, profile_id, clock_in, clock_out, lunch_minutes, miles, status, job_id, job_code, notes, rate_override, profiles(full_name, hourly_rate), job:job_id(job_number, name), time_allocations(id, hours, job_code)")
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

  const { data: jobAppts } = await supabase
    .from("appointments")
    .select("id, type, title, starts_at, ends_at, location, status")
    .eq("job_id", id)
    .order("starts_at");

  // Extra data for the per-tab "Add" buttons.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: meRow } = await supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle();
  const viewerIsStaff = ["owner", "admin", "office"].includes((meRow as any)?.role ?? "");
  const [{ data: techs }, { data: jobCodes }, { data: lists }, { data: org }, { data: allCustomers }, { data: allJobs }] = await Promise.all([
    supabase.from("profiles").select("id, full_name, home_address").order("full_name"),
    supabase.from("job_codes").select("*").order("code"),
    supabase.from("material_lists").select("id, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("organizations").select("address_line1, city, state, zip, settings").limit(1).maybeSingle(),
    supabase.from("customers").select("id, name").order("name"),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
  ]);
  const thisJobOpt = [{ id: j.id, job_number: j.job_number, name: j.name }];
  // Appointment button takes {id,label} option lists.
  const apptJobOpts = [{ id: j.id, label: `${j.job_number} · ${j.name}`, address: [j.address, j.city, j.state, j.zip].filter(Boolean).join(", ") || null }];
  const apptCustOpts = (allCustomers ?? []).map((c: any) => ({ id: c.id, label: c.name }));
  const apptStaffOpts = (techs ?? []).map((t: any) => ({ id: t.id, label: t.full_name ?? "Unnamed" }));
  const companyAddress = [org?.address_line1, org?.city, org?.state, org?.zip].filter(Boolean).join(", ");
  const jobAddress = [j.address, j.city, j.state, j.zip].filter(Boolean).join(", ");
  const mileageRate = getOrgSettings((org as any)?.settings).mileage_rate;
  const tz = getOrgSettings((org as any)?.settings).timezone; // business tz for time-entry dates

  // Costing
  let laborCost = 0;
  let laborHours = 0;
  for (const e of entries ?? []) {
    // Per-entry pay rate: an explicit override (e.g. supervisor rate) wins,
    // otherwise the person's default profile rate.
    const rate = Number((e as any).rate_override ?? (e as any).profiles?.hourly_rate ?? 0);
    if ((e as any).time_allocations?.length) {
      for (const a of (e as any).time_allocations)
        laborHours += Number(a.hours ?? 0);
      for (const a of (e as any).time_allocations)
        laborCost += Number(a.hours ?? 0) * rate;
      continue;
    }
    if (e.status === "closed" && e.clock_out) {
      const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
      laborHours += h;
      laborCost += h * rate;
    }
  }
  const materialCost = (pos ?? []).reduce((s: number, p: any) => s + Number(p.total ?? 0), 0);
  const billsCost = (bills ?? []).reduce((s: number, b: any) => s + Number(b.amount ?? 0), 0);
  const totalMiles = (entries ?? []).reduce((s: number, e: any) => s + Number(e.miles ?? 0), 0);
  const mileageCost = totalMiles * mileageRate;
  // Revenue = CASH COLLECTED on this job (Erik's rule): the amount actually paid
  // on the job's non-void invoices, net of refunds — NOT the sum of invoice/quote
  // totals (which double-counts a progress invoice + the final). invoiced/quoted
  // stay for context only.
  const invoiced = (invoices ?? []).reduce((s: number, i: any) => s + Number(i.total ?? 0), 0);
  const quoted = (quotes ?? []).reduce((s: number, q: any) => s + Number(q.total ?? 0), 0);
  // Billed-to-date for progress payments = non-void invoice totals (drafts count
  // so you don't re-bill a milestone already drafted).
  const billedToDate = (invoices ?? []).reduce((s: number, i: any) => (i.status !== "void" ? s + Number(i.total ?? 0) : s), 0);
  const collected = (invoices ?? []).reduce(
    (s: number, i: any) => (i.status !== "void" ? s + Number(i.amount_paid ?? 0) : s),
    0,
  );
  // Open invoices (non-void, balance still owed) — targets for "record a payment".
  const openInvoices = (invoices ?? [])
    .filter((i: any) => i.status !== "void" && Number(i.total ?? 0) - Number(i.amount_paid ?? 0) > 0.005)
    .map((i: any) => ({
      id: i.id,
      number: i.invoice_number,
      balance: Math.round((Number(i.total ?? 0) - Number(i.amount_paid ?? 0)) * 100) / 100,
    }));
  const invoiceIds = (invoices ?? []).map((i: any) => i.id);
  const { data: refundRows } = invoiceIds.length
    ? await supabase.from("customer_credits").select("amount").eq("disposition", "refund").in("invoice_id", invoiceIds)
    : { data: [] as any[] };
  const jobRefunds = (refundRows ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
  const revenue = Math.max(0, collected - jobRefunds);
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
      label: "Overview",
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
            <div className="flex items-center gap-2">
              <JobClockButton jobId={j.id} />
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
          </div>
          <ul className="divide-y divide-slate-100">
            {(entries ?? []).map((e: any) => {
              const h = e.status === "closed" && e.clock_out
                ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : null;
              return (
                <li key={e.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                  <div>
                    <span className="text-slate-700">{formatDateTz(e.clock_in, tz)}</span>
                    <span className="ml-2 text-slate-500">{e.profiles?.full_name ?? "—"}</span>
                    {e.job_code && <Badge tone="slate" className="ml-2">{e.job_code}</Badge>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-slate-800">{h != null ? formatDuration(h) : "open"}</span>
                    <EditEntryButton
                      entry={e}
                      jobCodes={(jobCodes ?? []) as any}
                      jobs={allJobs ?? []}
                      members={(techs ?? []) as any}
                      isStaff={viewerIsStaff}
                    />
                  </div>
                </li>
              );
            })}
            {(!entries || entries.length === 0) && empty("time entries")}
          </ul>
        </Card>
      ),
    },
    {
      id: "appointments",
      label: "Appointments",
      count: jobAppts?.length ?? 0,
      content: (
        <div className="space-y-3">
          <div className="flex justify-end">
            <AppointmentButton jobs={apptJobOpts} customers={apptCustOpts} staff={apptStaffOpts} />
          </div>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
              {(jobAppts ?? []).map((a: any) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge tone={a.type === "inspection" ? "amber" : "blue"}>{a.type}</Badge>
                    <span className="truncate font-medium text-slate-900">{a.title}</span>
                    {a.status === "completed" && <Badge tone="green">done</Badge>}
                  </div>
                  <span className="shrink-0 text-slate-500">{formatDateTime(a.starts_at)}</span>
                </li>
              ))}
              {(!jobAppts || jobAppts.length === 0) && empty("appointments")}
            </ul>
          </Card>
        </div>
      ),
    },
    {
      id: "costs",
      label: "Costs",
      content: (
        <div className="space-y-4">
          <Card>
            <CardContent className="py-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(revenue)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">{invoiced > 0 ? "Invoiced" : "Quoted"}</div></div>
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(laborCost)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">Labor · {formatDuration(laborHours)}</div></div>
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(materialCost)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">Materials</div></div>
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(billsCost)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">Bills</div></div>
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(mileageCost)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">Mileage · {totalMiles} mi</div></div>
                </div>
                <div className="flex gap-6 border-t border-slate-100 pt-3 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
                  <div><div className={`text-2xl font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{formatCurrency(profit)}</div><div className="text-xs font-medium text-slate-500">Profit</div></div>
                  <div><div className={`text-2xl font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{margin.toFixed(0)}%</div><div className="text-xs font-medium text-slate-500">Margin</div></div>
                </div>
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
              {/* Photograph or upload a receipt right here in Costs — receipts
                  tagged Receipt/Bill auto-post as a job cost. */}
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
          <div className="flex justify-end">
            <NewListButton jobs={thisJobOpt} />
          </div>
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
                  <span className="font-medium text-slate-900">
                    {q.quote_number}
                    <span className="ml-2 align-middle rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      {(q.doc_type ?? "quote") === "estimate" ? "Est" : "Quote"}
                    </span>
                  </span>
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
          <div className="flex justify-end gap-2">
            <ProgressInvoiceButton jobId={j.id} contract={quoted} invoiced={billedToDate} paid={collected} openInvoices={openInvoices} />
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
      id: "change-orders",
      label: "Change orders",
      count: changeOrders?.length ?? 0,
      content: (
        <div className="space-y-3">
          <div className="flex justify-end">
            <NewChangeOrderButton jobs={thisJobOpt} />
          </div>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
              {(changeOrders ?? []).map((c: any) => (
                <li key={c.id} className="flex items-start gap-4 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">{c.co_number}</span>
                      <span className="text-xs text-slate-400">{formatDate(c.created_at)}</span>
                    </div>
                    {c.description && <p className="mt-1 text-sm text-slate-600">{c.description}</p>}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="text-sm font-semibold text-slate-900">{formatCurrency(c.amount)}</span>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/print/change-order/${c.id}`}
                        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        title="Print / PDF"
                      >
                        <Printer className="h-4 w-4" />
                      </Link>
                      <CoRowActions co={c} jobs={thisJobOpt} />
                      <CoStatusControl id={c.id} status={c.status} />
                    </div>
                  </div>
                </li>
              ))}
              {(!changeOrders || changeOrders.length === 0) && empty("change orders")}
            </ul>
          </Card>
        </div>
      ),
    },
    {
      id: "wos",
      label: "Work orders",
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
        <Link href="/planner" className="hover:text-slate-800"><Home className="h-4 w-4" /></Link>
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

      <Tabs tabs={arrangeJobTabs(tabs)} viewerIsStaff={viewerIsStaff} urlSync />
    </div>
  );
}
