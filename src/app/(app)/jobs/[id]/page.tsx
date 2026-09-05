import { attachRates, payRateMap } from "@/lib/profile-columns";
import { storyForJob } from "@/lib/story";
import { SettleUpButton } from "@/components/settle-up-button";
import { OpenInspectorButton } from "./open-inspector-button";
import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { notFound } from "next/navigation";
import { Home, ChevronRight, MapPin, Receipt, Plus, Printer, Phone, type LucideIcon } from "lucide-react";
// The More-panel chip icons must come through a "use client" re-export so the
// component REFERENCES survive the server→client serialization into <Tabs>.
import {
  LayoutDashboard, Clock, Package, Camera, ListChecks, CalendarDays,
  ClipboardCheck, FileText, DollarSign, Receipt as ReceiptTab, StickyNote, Stamp, FileDiff,
} from "./job-tab-icons";
import { createClient } from "@/lib/supabase/server";
import { acceptedQuoteTotal } from "@/lib/payment-schedule-math";
import { invoiceBalance, isDrawKind } from "@/lib/invoice-math";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { appointmentTypeLabel, isInspectionType } from "@/lib/statuses";
import { Tabs, type TabDef } from "@/components/tabs";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  hoursBetween,
  initials,
  formatCityStateZip,
  formatFullAddress,
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
import { JobContacts } from "./job-contacts";
import { JobScheduleControl } from "./job-schedule-control";
import { JobActionDock } from "./job-action-dock";
import { PaymentScheduleCard } from "./payment-schedule-card";
import { ContractCard } from "./contract-card";
import { LienInsuranceCard } from "./lien-insurance-card";
import { JobDescription } from "./job-description";
import { computeJobProgress, livePurchaseOrders } from "@/lib/job-progress-math";
import { jobLabel } from "@/lib/schedule-options";
import { directionsTarget } from "@/lib/maps";
import { ProgressInvoiceButton } from "./progress-invoice-button";
import { NewInvoiceButton } from "./new-invoice-button";
import { NewWorkOrderButton } from "../../work-orders/new-wo-button";
import { NewChangeOrderButton } from "../../change-orders/new-co-button";
import { CoStatusControl } from "../../change-orders/co-status-control";
import { CoRowActions } from "../../change-orders/co-row-actions";
import { ItemEditor } from "../../materials/[id]/item-editor";
import { NeedMaterials } from "../../materials/need-materials";
import { AppointmentButton, type ApptValue } from "../../appointments/appointment-button";
import { NewPoButton } from "../../purchasing/new-po-button";
import { EditCustomerButton } from "../../crm/[id]/edit-customer-button";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { computeJobLaborBilling, customerLaborRateForJob, fetchJobLaborRows, laborCostForJob } from "@/lib/labor-billing";
import { formatDateTz } from "@/lib/tz";
import { NavLink } from "@/components/nav-link";
import { IntakeFiles } from "../../leads/intake-files";
import { intakePaths } from "@/lib/playbook/uploads";
import type { Customer } from "@/lib/types";

export const dynamic = "force-dynamic";

// In-page nav order — the lifecycle-honest strip. The Work core (Overview, Time,
// Materials, Photos) prefers to stay inline (TIME rides 2nd so it never hides in
// "More" on a phone); everything financial/closeout clusters into the More menu.
const JOB_TAB_ORDER = [
  "job", "time", "materials", "photos", "tasks", "appointments", "notes",
  "quotes", "costs", "invoices", "change-orders", "permits", "wos",
];
const JOB_PRIMARY = new Set(["job", "time", "materials", "photos"]);
const JOB_STAFF_ONLY = new Set(["costs", "quotes", "invoices", "change-orders"]);

// The More panel's mini-map: cluster header + chamfered glass chip icon per tab.
// A LucideIcon COMPONENT reference renders ONLY in the More panel (width-neutral
// for the strip and its measuring ghost — the 375px fit is untouched). The whole
// Money cluster is staffOnly, so it vanishes for techs as a unit.
const JOB_TAB_META: Record<string, { group?: string; icon?: LucideIcon }> = {
  job: { icon: LayoutDashboard },
  time: { icon: Clock },
  materials: { icon: Package },
  photos: { group: "Docs", icon: Camera },
  tasks: { group: "Work", icon: ListChecks },
  appointments: { group: "Work", icon: CalendarDays },
  wos: { group: "Work", icon: ClipboardCheck },
  quotes: { group: "Money", icon: FileText },
  // DollarSign, not Wallet: a wallet and a box (Materials' Package) share the same
  // rounded-rect silhouette at glance size — $ vs box can't be confused.
  costs: { group: "Money", icon: DollarSign },
  invoices: { group: "Money", icon: ReceiptTab },
  "change-orders": { group: "Money", icon: FileDiff },
  notes: { group: "Docs", icon: StickyNote },
  permits: { group: "Docs", icon: Stamp },
};

/** Order the job tabs and tag each with its tier + cluster + staff-gating, so
 *  <Tabs> keeps the Work core visible and folds the rest into a clustered,
 *  bloom-skinned "More" menu (and hides money tabs from techs itself). */
function arrangeJobTabs(tabs: TabDef[]): TabDef[] {
  return [...tabs]
    .sort((a, b) => JOB_TAB_ORDER.indexOf(a.id) - JOB_TAB_ORDER.indexOf(b.id))
    .map((t) => ({
      ...t,
      ...(JOB_TAB_META[t.id] ?? {}),
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
    .select("*, customers(*), inquiry:inquiry_id(id, name, intake)")
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
    { data: paymentMilestones },
    { data: contractRows },
    { data: lienRecord },
    { data: insuranceClaim },
    { data: pos },
    { data: ownEntries },
    { data: inboundAllocRows },
    { data: docRows },
    { data: staff },
    { data: bills },
    { data: tasks },
    { data: permits },
  ] = await Promise.all([
    supabase.from("quotes").select("id, quote_number, status, total, doc_type, created_at").eq("job_id", id),
    supabase.from("work_orders").select("id, wo_number, title, status").eq("job_id", id),
    supabase.from("change_orders").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("invoices").select("id, invoice_number, status, total, amount_paid, invoice_kind").eq("job_id", id),
    supabase.from("payment_milestones").select("id, sort_order, label, percent, amount, status, invoice_id, billed_amount").eq("job_id", id).order("sort_order"),
    supabase.from("contracts").select("id, status, contract_number, title, body, public_token, signed_name, signed_at").eq("job_id", id).neq("status", "void").order("created_at", { ascending: false }).limit(1),
    supabase.from("lien_records").select("*").eq("job_id", id).maybeSingle(),
    supabase.from("insurance_claims").select("*").eq("job_id", id).maybeSingle(),
    supabase.from("purchase_orders").select("id, po_number, vendor, status, total").eq("job_id", id),
    supabase
      .from("time_entries")
      .select("id, profile_id, clock_in, clock_out, lunch_minutes, miles, status, job_id, job_code, notes, rate_override, paid_at, mileage_paid_at, profiles(full_name), job:job_id(job_number, name), time_allocations(id, job_id, hours, job_code, description)")
      .eq("job_id", id)
      .order("clock_in", { ascending: false }),
    // Time allocated INTO this job from shifts clocked on OTHER jobs (or no job). Without this
    // second direction, an hour split onto this job from another job's shift was invisible here —
    // while billing (fetchJobLaborRows) already billed it. Same two-way read billing uses; the
    // parent entry comes embedded with ALL its allocations so the per-job share math works.
    supabase
      .from("time_allocations")
      .select("id, time_entries!inner(id, profile_id, clock_in, clock_out, lunch_minutes, miles, status, job_id, job_code, notes, rate_override, paid_at, mileage_paid_at, profiles(full_name), job:job_id(job_number, name), time_allocations(id, job_id, hours, job_code, description))")
      .eq("job_id", id),
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
      .select("id, supplier, bill_number, amount, status, bill_date, po_id")
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

  // RATES MERGED FROM THE STAFF-SCOPED VIEW (0215/0216 revoked them from the authenticated
  // role, so these embeds cannot carry them). Without this the job hub's Labor line and every
  // profit figure on the page read ZERO — the exact bug the pay-boundary work was meant to
  // avoid, reintroduced by narrowing the embeds without merging. Both shapes: the entry rows,
  // and the allocation rows whose entry is nested one level down.
  {
    const rates = await payRateMap(supabase);
    attachRates((ownEntries ?? []) as any[], rates, (e: any) => ({ id: e.profile_id, holder: e }));
    attachRates((inboundAllocRows ?? []) as any[], rates, (a: any) => ({
      id: a.time_entries?.profile_id,
      holder: a.time_entries,
    }));
  }

  /**
   * ONE WAVE, NOT SIX (audit v800 wave B). These six reads are independent of each other and of
   * everything between them, and they were running strictly one after another — six full
   * round trips to Supabase, in series, before the page could render. On a truck at the edge of
   * coverage that is the difference between a job opening and a tech giving up on it, and the
   * 60mph rule is the standing measure for this page.
   *
   * Only two reads on this page genuinely depend on another: the canonical material list's items
   * (needs the list) and the viewer's role (needs the user). Those follow in a second wave rather
   * than dragging four unrelated queries along behind them.
   */
  const [
    { data: pendingProposal },
    { data: scheduleSegments },
    { data: jobLists },
    { data: jobAppts },
    { data: jobContactsRaw },
    {
      data: { user },
    },
  ] = await Promise.all([
    supabase
      .from("schedule_proposals")
      .select("id, token, dates")
      .eq("job_id", id)
      .eq("status", "pending")
      .maybeSingle(),
    supabase
      .from("job_schedule_segments")
      .select("start_date, end_date")
      .eq("job_id", id)
      .order("start_date"),
    supabase
      .from("material_lists")
      .select("id, name, created_at, material_list_items(count)")
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
    // Full ApptValue fields so each row can open the edit modal in place.
    supabase
      .from("appointments")
      .select("id, type, title, starts_at, ends_at, location, notes, status, job_id, customer_id, assigned_to")
      .eq("job_id", id)
      .eq("absorbed", false) // the converted source booking is the job now, not a live visit (audit v921)
      .order("starts_at"),
    // Subs & contacts linked to THIS job (many-to-many). Graceful: if job_contacts doesn't exist
    // yet (migration 0087 not applied), the query errors and we just show an empty card.
    supabase
      .from("job_contacts")
      .select("id, role, customer_id, customers(name, phone)")
      .eq("job_id", j.id)
      .order("created_at"),
    supabase.auth.getUser(),
  ]);

  // THE job's materials list — Erik's rule: the Materials tab IS the list, not a
  // list-of-lists. Newest wins, which makes the estimate's take-off (created on
  // "Build material list") canonical when one exists. No list yet → the tab still
  // renders the editor; the first added item lazily creates it server-side
  // (ensureJobMaterialList), so viewing a job never writes data.
  const canonicalList = ((jobLists ?? [])[0] ?? null) as { id: string; name: string } | null;
  // WAVE 2 — the only two reads that genuinely need a wave-1 result.
  const [{ data: canonicalItems }, { data: meRow }] = await Promise.all([
    canonicalList
      ? supabase.from("material_list_items").select("*").eq("list_id", canonicalList.id).order("sort_order")
      : Promise.resolve({ data: null }),
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
  ]);
  const viewerIsStaff = isStaffRole((meRow as any)?.role ?? "");
  // Merge the two directions into ONE entries list: shifts clocked on this job, plus shifts
  // clocked elsewhere that allocated hours here (deduped; the row math shows only this job's
  // share). laborCostForJob already attributes per-allocation, so totals stay exact.
  const ownIds = new Set(((ownEntries ?? []) as any[]).map((e: any) => e.id));
  const foreignEntries = Array.from(
    new Map(
      ((inboundAllocRows ?? []) as any[])
        .map((r: any) => r.time_entries)
        .filter((e: any) => e && !ownIds.has(e.id))
        .map((e: any) => [e.id, e]),
    ).values(),
  );
  const entries = [...((ownEntries ?? []) as any[]), ...foreignEntries].sort((a: any, b: any) =>
    a.clock_in < b.clock_in ? 1 : -1,
  );

  const [{ data: techs }, { data: jobCodes }, { data: lists }, { data: org }, { data: allCustomers }, { data: allJobs }, { data: codeTemplates }, { data: openEntryRow }] = await Promise.all([
    // Staff get hourly_rate + bill_rate for the add-time/edit modals' pay-rate
    // anchor; NON-staff keep the narrow select. The gate matters here: this array
    // serializes into client-component props (RSC), so an unconditional enrichment
    // would hand every tech the whole crew's pay + bill rates — "the modal returns
    // null for non-staff" is not a serialization defense.
    viewerIsStaff
      ? supabase.from("profile_pay").select("id, full_name, home_address, hourly_rate, bill_rate").order("full_name")
      : supabase.from("profile_pay").select("id, full_name, home_address").order("full_name"),
    supabase.from("job_codes").select("*").order("code"),
    supabase.from("material_lists").select("id, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("organizations").select("address_line1, city, state, zip, settings").limit(1).maybeSingle(),
    supabase.from("customers").select("id, name, type").order("name"),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("job_code_templates").select("id, name").order("name"),
    // The viewer's OPEN time entry (drives the action dock's 3-state TIME button).
    // Summed time_allocations = hours already recorded by mid-shift switches, so a
    // "Switch here" confirm can honestly name the outgoing segment's hours.
    supabase
      .from("time_entries")
      .select("id, clock_in, job_id, job:job_id(job_number, name), time_allocations(hours)")
      .eq("profile_id", user?.id ?? "")
      .eq("status", "open")
      .maybeSingle(),
  ]);
  const oe = openEntryRow as any;
  const openEntry = oe
    ? {
        id: oe.id as string,
        clock_in: oe.clock_in as string,
        job_id: (oe.job_id ?? null) as string | null,
        jobLabel: oe.job ? jobLabel(oe.job) : null,
        allocatedHours: (oe.time_allocations ?? []).reduce((s: number, a: any) => s + (Number(a.hours) || 0), 0),
      }
    : null;
  const jobContacts = (jobContactsRaw ?? []).map((r: any) => ({
    id: r.id,
    role: r.role,
    customer_id: r.customer_id,
    name: r.customers?.name ?? "—",
    phone: r.customers?.phone ?? null,
  }));
  const contactOptions = (allCustomers ?? []).map((c: any) => ({ id: c.id, name: c.name, type: c.type ?? null }));
  const thisJobOpt = [{ id: j.id, job_number: j.job_number, name: j.name }];
  // Appointment button takes {id,label} option lists.
  const apptJobOpts = [{ id: j.id, label: jobLabel(j), address: formatFullAddress(j.address, j.city, j.state, j.zip) || null }];
  const apptCustOpts = (allCustomers ?? []).map((c: any) => ({ id: c.id, label: c.name }));
  const apptStaffOpts = (techs ?? []).map((t: any) => ({ id: t.id, label: t.full_name ?? "Unnamed" }));
  const companyAddress = formatFullAddress(org?.address_line1, org?.city, org?.state, org?.zip);
  const jobAddress = formatFullAddress(j.address, j.city, j.state, j.zip);
  // Where "Navigate" should point. Prefer the job's own structured address, else the
  // customer's saved address (jobs happen at the customer site), else the job NAME —
  // which in the field often IS the address (typed there as a shortcut). Guarantees the
  // Navigate/Map control never silently vanishes just because the address fields are blank.
  const customerAddress = formatFullAddress(
    (j.customers as any)?.address, (j.customers as any)?.city, (j.customers as any)?.state, (j.customers as any)?.zip,
  );
  const navTarget = directionsTarget(jobAddress, customerAddress, j.name);
  const tz = getOrgSettings((org as any)?.settings).timezone; // business tz for time-entry dates

  // The activity log — assembled from the rows themselves, see lib/story.
  const story = await storyForJob(supabase, j.id);
  // The org's all-day work window (Settings → Scheduling) — the same resolver the
  // schedule writers use, threaded into the schedule/edit controls so their "blank
  // time = all-day" sentinel and default times track the org's window, not a fixed 8-4.
  const workDay = workDayWindowHm((org as any)?.settings);

  // Costing. laborCost = what we PAY (pay rate); billableLabor = what we CHARGE
  // (bill rate) — the latter feeds the estimate-vs-actual draw tracking.
  // laborCost (what we PAY) via the shared allocation-aware helper — identical math to /analytics.
  const { hours: laborHours, cost: laborCost } = laborCostForJob(entries ?? [], id);
  // Materials, via the ONE shared rule (livePurchaseOrders): a draft/cancelled PO isn't a
  // cost, and a PO whose supplier bill has arrived is SUPERSEDED by that bill (bills.po_id,
  // migration 0142) — so one CED delivery entered as both a PO and the supplier's invoice
  // is costed once, at the invoiced amount, here and on /analytics and on the draw.
  const materialCost = livePurchaseOrders((pos ?? []) as any[], (bills ?? []) as any[]).reduce(
    (s: number, p: any) => s + Number(p.total ?? 0),
    0,
  );
  const billsCost = (bills ?? []).reduce((s: number, b: any) => s + Number(b.amount ?? 0), 0);
  // Billable work to date + the progress rollups — via the extracted computeJobProgress
  // SSOT (the exact rollup the draw modal / print report use: estimate = accepted contract
  // via contractTotalFromQuotes, invoiced = non-void non-draft, collected = non-void
  // amount_paid, materials marked up per row like importCosts). One rule change there
  // reaches this hub automatically. fetchJobLaborRows also captures cross-job allocations.
  const materialMarkup = getOrgSettings((org as any)?.settings).material_markup_percent;
  const defaultLaborRate = getOrgSettings((org as any)?.settings).default_labor_rate;
  // timeclock_job_codes=false must hide EVERY code picker (cn-v517) — including the
  // Time tab's add/edit modals here, not just the /timecards mounts.
  const jobCodesEnabled = getOrgSettings((org as any)?.settings).timeclock_job_codes;
  const laborRows = await fetchJobLaborRows(supabase, id);
  const jobLevelRate = await customerLaborRateForJob(supabase, id);
  const billableLabor = computeJobLaborBilling(laborRows.jobEntries, laborRows.jobAllocs, defaultLaborRate, jobLevelRate, laborRows.nonBillableCodes).total;
  const progress = computeJobProgress({
    billingTypeRaw: (j as any).billing_type,
    quotes: (quotes ?? []) as any,
    invoices: (invoices ?? []) as any,
    billableLabor,
    pos: (pos ?? []) as any,
    bills: (bills ?? []) as any,
    markupPercent: materialMarkup,
  });
  const workedToDate = progress.workToDate;
  const totalMiles = (entries ?? []).reduce((s: number, e: any) => s + Number(e.miles ?? 0), 0);
  // Revenue = CASH COLLECTED on this job (Erik's rule): the amount actually paid
  // on the job's non-void invoices, net of refunds — NOT the sum of invoice/quote
  // totals (which double-counts a progress invoice + the final). invoiced/quoted
  // stay for context only. `invoiced` is deliberately the RAW all-invoices sum
  // (drafts included) — it only picks the "Invoiced vs Estimated" label below,
  // not a money figure; the billed money figure is progress.invoiced.
  const invoiced = (invoices ?? []).reduce((s: number, i: any) => s + Number(i.total ?? 0), 0);
  // Estimate base = the ACCEPTED contract (progress.estimate). Same value under two
  // names: `quoted` feeds the draw UI, `contractTotal` the payment schedule.
  const quoted = progress.estimate;
  const contractTotal = progress.estimate;
  // Billed-to-date for progress payments = invoices actually SENT to the customer
  // (non-void, non-draft — a draft draw isn't a real bill): progress.invoiced.
  const billedToDate = progress.invoiced;
  const collected = progress.collected;
  // Open invoices (non-void, balance still owed) — targets for "record a payment".
  const openInvoices = (invoices ?? [])
    .filter((i: any) => i.status !== "void" && invoiceBalance(i.total, i.amount_paid) > 0.005)
    .map((i: any) => ({
      id: i.id,
      number: i.invoice_number,
      balance: invoiceBalance(i.total, i.amount_paid),
    }));
  const invoiceIds = (invoices ?? []).map((i: any) => i.id);
  const { data: refundRows } = invoiceIds.length
    ? await supabase.from("customer_credits").select("amount").eq("disposition", "refund").in("invoice_id", invoiceIds)
    : { data: [] as any[] };
  const jobRefunds = (refundRows ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
  const revenue = Math.max(0, collected - jobRefunds);
  // Profit excludes mileage on PURPOSE so this hub and /analytics show the SAME number
  // for the same job: mileage is a per-entry value that isn't allocation-aware (a split
  // shift can't apportion its miles across jobs), and /analytics doesn't carry it. Mileage
  // is surfaced below as MILES ONLY — no app-computed dollars (mileage pay is a human-typed
  // settlement on /payroll, never rate×miles). If mileage dollars are ever folded back in,
  // they must be added to BOTH surfaces.
  const profit = revenue - laborCost - materialCost - billsCost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  const docs = await Promise.all(
    (docRows ?? []).map(async (d: any) => {
      // Organize notes filed to a job are documents rows with NO file (file_url null).
      // createSignedUrl(null) throws a TypeError that storage-js rethrows (it only
      // swallows StorageErrors), crashing the whole RSC render — guard like /organize.
      if (!d.file_url) return { ...d, signedUrl: null };
      const { data } = await supabase.storage.from("documents").createSignedUrl(d.file_url, 3600);
      return { ...d, signedUrl: data?.signedUrl ?? null };
    }),
  );

  const empty = (label: string) => (
    <p className="px-1 py-6 text-center text-sm text-slate-400">No {label} yet.</p>
  );

  // Time-tab serialization gate (same class as the gated techs select above):
  // `entries` keeps rate_override + the joined hourly_rate/bill_rate because the
  // server-side cost math (laborCostForJob, totalMiles) needs the full rows, but
  // each row also serializes into EditEntryButton props on a page techs can view.
  // Non-staff get an allowlist projection with every pay field stripped; staff
  // pass the full rows through unchanged (the edit modal's Rate anchor uses them).
  const timeTabEntries: {
    id: string;
    profile_id: string;
    clock_in: string;
    clock_out: string | null;
    lunch_minutes: number;
    miles?: number; // Entry's shape: DB null → undefined in the projection
    status: string;
    job_id: string | null;
    job_code: string | null;
    notes: string | null;
    profiles: { full_name: string | null } | null;
    job: { job_number: string; name: string } | null;
    time_allocations: { id: string; job_id: string | null; hours: number | null; job_code: string | null; description: string | null }[];
    rate_override?: number | null;
    // The payroll locks aren't pay data — they drive the edit modal's
    // "paid period" banner, which every role should see before a blocked save.
    paid_at?: string | null;
    mileage_paid_at?: string | null;
  }[] = viewerIsStaff
    ? ((entries ?? []) as any[])
    : ((entries ?? []) as any[]).map((e) => ({
        id: e.id,
        profile_id: e.profile_id,
        clock_in: e.clock_in,
        clock_out: e.clock_out,
        lunch_minutes: e.lunch_minutes,
        miles: e.miles ?? undefined,
        status: e.status,
        job_id: e.job_id,
        job_code: e.job_code,
        notes: e.notes,
        profiles: e.profiles ? { full_name: e.profiles.full_name ?? null } : null,
        job: e.job ?? null,
        time_allocations: e.time_allocations ?? [],
        paid_at: e.paid_at ?? null,
        mileage_paid_at: e.mileage_paid_at ?? null,
      }));

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
                  {/* Tap-to-call: one of the two things a job gets opened for from the truck. */}
                  {j.customers?.phone && (
                    <a href={`tel:${j.customers.phone}`} className="flex min-h-[44px] items-center gap-1.5 text-sm text-slate-600 hover:text-brand">
                      <Phone className="h-3.5 w-3.5 text-slate-400" /> {j.customers.phone}
                    </a>
                  )}
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</div>
                  <div className="mt-1">
                    <JobStatusControl id={j.id} status={j.status} holdReason={(j as any).hold_reason ?? null} />
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Address</div>
                  <div className="mt-1 text-sm text-slate-700">
                    {j.address ? (
                      // Tap-to-navigate: the address opens guided directions in the user's maps app.
                      <NavLink address={jobAddress} className="flex min-h-[44px] items-center gap-1 text-left hover:text-brand">
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" /> {j.address}
                        {[j.city, j.state, j.zip].filter(Boolean).length > 0 && (
                          <span>· {formatCityStateZip(j.city, j.state, j.zip)}</span>
                        )}
                      </NavLink>
                    ) : "—"}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Scheduled</div>
                  <div className="mt-1">
                    <JobScheduleControl id={j.id} start={j.scheduled_start} end={j.scheduled_end} segments={(scheduleSegments ?? []) as any} workDayStart={workDay.start} />
                  </div>
                </div>
              </div>
              <JobDescription jobId={j.id} description={j.description} />
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

          <JobContacts jobId={j.id} contacts={jobContacts} options={contactOptions} />
          {/* ACTIVITY LOG — Erik's name for it, at the bottom where a history belongs: the page
              leads with what the job needs NOW, and how it got here reads back from the end.
              Every chapter is assembled from the rows themselves (lib/story); the "from lead"
              arrow lands here instead of resurrecting the lead on the leads page. */}
          {story.length > 0 && (
            <Card id="activity" className="scroll-mt-24">
              <CardContent className="py-5">
                <h3 className="mb-3 text-sm font-semibold text-slate-900">Activity log</h3>
                <ol className="space-y-2">
                  {story.map((ev, i) => (
                    <li key={i} className="flex items-baseline gap-2 text-sm">
                      <span className="w-20 shrink-0 font-mono text-xs tabular-nums text-slate-400">
                        {formatDateTz(ev.at, tz)}
                      </span>
                      <span className="h-1.5 w-1.5 shrink-0 translate-y-[-2px] rounded-full bg-brand/50" aria-hidden />
                      {ev.href ? (
                        <Link href={ev.href} className="min-w-0 text-slate-700 hover:text-brand">
                          {ev.text}
                        </Link>
                      ) : (
                        <span className="min-w-0 text-slate-700">{ev.text}</span>
                      )}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
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
              <JobClockButton jobId={j.id} isStaff={viewerIsStaff} />
              {viewerIsStaff && (
                <JobAddTimeEntry
                  jobId={j.id}
                  techs={techs ?? []}
                  jobCodes={(jobCodes ?? []) as any}
                  defaultProfileId={user?.id ?? ""}
                  companyAddress={companyAddress}
                  jobAddress={jobAddress}
                  jobCodesEnabled={jobCodesEnabled}
                />
              )}
            </div>
          </div>
          <ul className="divide-y divide-slate-100">
            {timeTabEntries.map((e) => {
              const h = e.status === "closed" && e.clock_out
                ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : null;
              // THIS job's share of the shift: allocation rows naming this job (unlabeled rows
              // belong to the entry's own job), else the whole shift. The row shows the share —
              // the number that actually bills here — with the full-shift context alongside.
              const allocs = e.time_allocations ?? [];
              const share = allocs.length
                ? allocs.reduce((sum: number, a: any) => sum + (((a.job_id ?? e.job_id) === j.id) ? Number(a.hours ?? 0) : 0), 0)
                : h;
              const isSplit = allocs.length > 0 && h != null && Math.abs((share ?? 0) - h) > 0.01;
              const fromOtherJob = e.job_id !== j.id;
              return (
                <li key={e.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div>
                    <span className="text-slate-700">{formatDateTz(e.clock_in, tz)}</span>
                    <span className="ml-2 text-slate-500">{e.profiles?.full_name ?? "—"}</span>
                    {e.job_code && <Badge tone="slate" className="ml-2">{e.job_code}</Badge>}
                    {fromOtherJob && e.job && (
                      <Badge tone="blue" className="ml-2">via {e.job.job_number}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isSplit && <span className="text-xs text-slate-400">of {formatDuration(h!)} shift</span>}
                    <span className="font-medium text-slate-800">{share != null ? formatDuration(share) : "open"}</span>
                    <EditEntryButton
                      entry={e}
                      jobCodes={(jobCodes ?? []) as any}
                      jobs={allJobs ?? []}
                      members={(techs ?? []) as any}
                      isStaff={viewerIsStaff}
                      jobCodesEnabled={jobCodesEnabled}
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
            {/* Defaults matter: booked from the Miller job, it must land ON the Miller job. Without
                these the component opened blank and the appointment was never linked back. */}
            <AppointmentButton jobs={apptJobOpts} customers={apptCustOpts} staff={apptStaffOpts} defaultJobId={job.id} defaultCustomerId={job.customer_id ?? undefined} />
          </div>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-slate-100">
              {(jobAppts ?? []).map((a: any) => {
                // Same edit door the schedule's appointment rows use — the row
                // is no longer a read-only dead-end.
                const appt: ApptValue = {
                  id: a.id, type: a.type, title: a.title, starts_at: a.starts_at, ends_at: a.ends_at,
                  job_id: a.job_id, customer_id: a.customer_id, location: a.location, notes: a.notes, assigned_to: a.assigned_to,
                };
                return (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      {/* Spine label + predicate (statuses.ts): final_inspection lands exactly
                          here (code inspection at job end) — a raw {a.type} rendered it as
                          underscore text in default blue. */}
                      <Badge tone={isInspectionType(a.type) ? "amber" : "blue"}>{appointmentTypeLabel(a.type)}</Badge>
                      <span className="truncate font-medium text-slate-900">{a.title}</span>
                      {a.status === "completed" && <Badge tone="green">done</Badge>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-slate-500">{formatDateTime(a.starts_at)}</span>
                      <AppointmentButton jobs={apptJobOpts} customers={apptCustOpts} staff={apptStaffOpts} appointment={appt} />
                    </div>
                  </li>
                );
              })}
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
              {/* auto-fit, not viewport breakpoints: at ~675px the window LOOKS "tablet" to sm:
                  media queries but the sidebar eats half the width, so fixed sm:grid-cols-3 +
                  side-by-side profit overlapped the numbers (Erik's 7/24 screenshot). auto-fit
                  wraps by the space the card actually has. */}
              <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-6 gap-y-3">
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(revenue)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">{invoiced > 0 ? "Invoiced" : "Estimated"}</div></div>
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(laborCost)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">Labor · {formatDuration(laborHours)}</div></div>
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(materialCost)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">Materials</div></div>
                  <div><div className="text-base font-semibold text-slate-700">{formatCurrency(billsCost)}</div><div className="text-[11px] uppercase tracking-wide text-slate-400">Bills</div></div>
                  {/* Miles only — mileage dollars are a /payroll settlement decision,
                      never an app-computed figure (and never in profit above). */}
                  <div><div className="text-base font-semibold text-slate-700">{totalMiles.toFixed(1)} mi</div><div className="text-[11px] uppercase tracking-wide text-slate-400">Mileage</div></div>
                </div>
                <div className="flex shrink-0 gap-6 border-t border-slate-100 pt-3 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
                  <div><div className={`text-2xl font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{formatCurrency(profit)}</div><div className="text-xs font-medium text-slate-500">Profit</div></div>
                  <div><div className={`text-2xl font-bold ${profit >= 0 ? "text-green-600" : "text-red-600"}`}>{margin.toFixed(0)}%</div><div className="text-xs font-medium text-slate-500">Margin</div></div>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
              <span className="text-sm font-semibold text-slate-900">Material purchase orders</span>
              <NewPoButton jobs={thisJobOpt} lists={lists ?? []} defaultJobId={j.id} />
            </div>
            <ul className="divide-y divide-slate-100">
              {(pos ?? []).map((p: any) => (
                <li key={p.id}>
                  <Link href={`/purchasing/${p.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
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
              <JobBills jobId={j.id} bills={(bills ?? []) as any} pos={(pos ?? []) as any} />
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
      count: canonicalItems?.length ?? 0,
      content: (
        <div className="space-y-3">
          {/* Hit Materials and THE list is right there (Erik, 7/14) — no
              list-of-lists, nothing to create or open. Checked items sink to the
              bottom inside the editor; the pick-list print and PO seed ride on
              top of the SAME list. */}
          {canonicalList && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Link
                href={`/print/pdf-preview?doc=material-list&id=${canonicalList.id}&back=/jobs/${j.id}?tab=materials`}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <ListChecks className="h-4 w-4 shrink-0" /> Print Pick List
              </Link>
              <NewPoButton
                jobs={thisJobOpt}
                lists={[{ id: canonicalList.id, name: canonicalList.name }]}
                defaultJobId={j.id}
                defaultListId={canonicalList.id}
              />
            </div>
          )}
          {/* A TECH GETS THE LIST READ-ONLY AND A WAY TO ASK. The editor's six writes all need
              is_org_staff() at the policy, so rendering it for a tech was six buttons that
              silently did nothing — Erik: "if a tech on a job says he needs materials for that
              job, it should show up as an alert for the boss." */}
          {viewerIsStaff ? (
            <ItemEditor listId={canonicalList?.id ?? null} jobId={j.id} items={(canonicalItems ?? []) as any} />
          ) : (
            <div className="space-y-3">
              {(canonicalItems ?? []).length > 0 && (
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {((canonicalItems ?? []) as any[]).map((it) => (
                    <li key={it.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className={it.purchased ? "text-slate-400 line-through" : "text-slate-700"}>
                        {it.description}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-slate-400">
                        {it.quantity ?? ""} {it.unit ?? ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {/* He still needs to SEE the list, or he'll ask for something that's already in the van. */}
              <NeedMaterials jobId={j.id} />
            </div>
          )}
          {(jobLists ?? []).length > 1 && (
            <div className="text-right">
              <Link
                href={`/materials?job=${j.id}`}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                other lists ({(jobLists ?? []).length - 1})
              </Link>
            </div>
          )}
        </div>
      ),
    },
    {
      id: "quotes",
      label: "Estimates",
      count: quotes?.length ?? 0,
      content: (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Link
              href={`/quotes/new?customer=${j.customer_id ?? ""}&job=${j.id}`}
              className="btn-gloss inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[rgb(var(--glass-ink))] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[rgb(var(--glass-ink))]/90"
            >
              <Plus className="h-4 w-4 shrink-0" /> New Estimate
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
            {(!quotes || quotes.length === 0) && empty("estimates")}
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
          {/* Lead with the INVOICES (this is the Invoices tab) — the contract / payment
              schedule / lien cards live below, since they're supporting deal-to-cash context. */}
          {/* Billing actions live HERE, on the Invoices tab, where you'd look to bill — a plain
              "New invoice" (it used to hide in the Manage ⋯ menu, so a T&M job looked like it could
              only do Progress payment) next to the progress/payment hub. */}
          <div className="flex flex-wrap justify-end gap-2">
            {viewerIsStaff && <NewInvoiceButton jobId={j.id} />}
            <ProgressInvoiceButton jobId={j.id} billingType={(j as any).billing_type ?? "fixed"} estimate={quoted} worked={workedToDate} invoiced={billedToDate} paid={collected} openInvoices={openInvoices} scheduleActive={((paymentMilestones as any) ?? []).length > 0} />
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
          <PaymentScheduleCard
            jobId={j.id}
            billingType={(j as any).billing_type ?? "fixed"}
            contractTotal={contractTotal}
            depositPercent={getOrgSettings((org as any)?.settings).deposit_percent}
            milestones={(paymentMilestones as any) ?? []}
          />
          <ContractCard jobId={j.id} contract={((contractRows as any) ?? [])[0] ?? null} />
          <LienInsuranceCard
            jobId={j.id}
            lien={(lienRecord as any) ?? null}
            insurance={(insuranceClaim as any) ?? null}
            defaults={{
              ownerName: (j.customers as any)?.name ?? undefined,
              ownerAddress: formatFullAddress((j.customers as any)?.address, (j.customers as any)?.city, (j.customers as any)?.state, (j.customers as any)?.zip) || undefined,
              // ACCEPTED-only, matching what the notice itself prints (audit 8): this prefilled
              // the sum of every quote, so a job with two unaccepted revisions handed staff a
              // doubled figure to serve on a legal notice, one Save away from being sworn to.
              estimatedAmount: acceptedQuoteTotal((quotes ?? []) as any),
            }}
          />
        </div>
      ),
    },
    {
      id: "change-orders",
      label: "Change Orders",
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
                        href={`/print/pdf-preview?doc=change-order&id=${c.id}&back=/jobs/${j.id}?tab=change-orders`}
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
                  <Badge tone={statusTone(w.status)}>{jobStatusLabel(w.status)}</Badge>
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

      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-900">{j.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
          <span>{j.job_number}</span>
          <Badge tone={statusTone(j.status)}>{jobStatusLabel(j.status)}</Badge>
          {/* Done & paid — the critical path's last step, on the record itself. Staff only, and
              not on a job already settled by draws (settleUp re-checks server-side; hiding it
              here just spares the tap that would be refused). */}
          {viewerIsStaff && j.status !== "cancelled" && (
            <SettleUpButton
              source="job"
              id={j.id}
              compact
              methods={getOrgSettings((org as any)?.settings).payment_methods}
              venmoConfigured={Boolean(getOrgSettings((org as any)?.settings).venmo_handle?.trim())}
            />
          )}
          {/* The Inspector — every note, photo and intake answer from any entrance point, one tap
              away. An access point, not a wall. */}
          {viewerIsStaff && <OpenInspectorButton jobId={j.id} />}
          {/* Provenance backlink → THE STORY, not /leads?focus= — that door resurrected the lead
              as a lead, live convert menu and all. Erik: "a lead not being a lead anymore doesnt
              include putting it back." The origin lives on in the first chapter below. */}
          {(j as any).inquiry && (
            <Link href={`/jobs/${j.id}?tab=job#activity`} className="text-brand hover:underline">
              ← from lead: {(j as any).inquiry.name}
            </Link>
          )}
        </div>
        {/* What the customer attached at intake (plans, photos) — carried the whole trail, because
            the lead leaves the inbox on conversion and the crew builds from these. */}
        {(j as any).inquiry && (
          <IntakeFiles inquiryId={(j as any).inquiry.id} paths={intakePaths((j as any).inquiry.intake)} />
        )}
      </div>

      {/* The action dock — one sticky glass bar replacing the old 7-control row:
          TIME (the only filled button) · Add cost · Photo · Call · Navigate · Manage ⋯ */}
      <JobActionDock
        job={j}
        viewerIsStaff={viewerIsStaff}
        tz={tz}
        openEntry={openEntry}
        techs={techs ?? []}
        defaultProfileId={user?.id ?? ""}
        jobAddress={navTarget}
        customerPhone={j.customers?.phone ?? null}
        pendingProposal={(pendingProposal as any) ?? null}
        hasQuote={(quotes ?? []).length > 0}
        defaultSendInvoice={getOrgSettings((org as any)?.settings).auto_send_invoice_on_complete}
        isDrawBilled={(invoices ?? []).some(
          (i: any) => isDrawKind(i.invoice_kind) && i.status !== "void",
        )}
        customers={allCustomers ?? []}
        templates={(codeTemplates ?? []) as { id: string; name: string }[]}
        workDay={workDay}
      />

      <Tabs tabs={arrangeJobTabs(tabs)} viewerIsStaff={viewerIsStaff} urlSync />
    </div>
  );
}
