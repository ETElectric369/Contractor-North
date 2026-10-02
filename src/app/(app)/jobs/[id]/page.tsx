import { attachRates, payRateMap } from "@/lib/profile-columns";
import { storyForJob } from "@/lib/story";
import { SettleUpButton } from "@/components/settle-up-button";
import { smsReadiness } from "@/lib/sms";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { OpenInspectorButton } from "./open-inspector-button";
import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { notFound } from "next/navigation";
import { Home, ChevronRight, Plus, Printer, Phone, HardHat } from "lucide-react";
import { ClipboardCheck, ListChecks } from "./job-tab-icons";
import { arrangeJobTabs } from "./job-tabs";
import { FeatureOffLine } from "@/components/feature-off-line";
import { featureOn, type FeatureKey } from "@/lib/features";
import { createClient } from "@/lib/supabase/server";
import { acceptedQuoteTotal, leftToBill, scheduleStatus, type Milestone } from "@/lib/payment-schedule-math";
import { invoiceBalance, isDrawKind } from "@/lib/invoice-math";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { appointmentTypeLabel, isInspectionType } from "@/lib/statuses";
import { Tabs } from "@/components/tabs";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDuration,
  formatTime,
  hoursBetween,
  formatCityStateZip,
  formatFullAddress,
  unitLine,
} from "@/lib/utils";
import { JobDocuments } from "./job-documents";
import { JobCostCapture } from "./job-cost-capture";
import { UnbilledCard, UnbilledDoorButton, type UnbilledView } from "./unbilled-card";
import { LeftToBillCard, contractEstimates } from "./left-to-bill-card";
import { fixedBillingsNotYetNetted, unbilledWorkForJob } from "@/lib/unbilled-work";
import { groupJobCosts, openRowsDrawn } from "@/lib/job-cost-groups";
import { readJobPapers } from "./job-papers";
import { JobPaperList, type JobPaperView } from "./job-paper-list";
import { tmWorkToDate } from "@/lib/job-financials";
import { readJobStock, stockCostLabel, stockKey, stockShortsSentence } from "@/lib/stock-billing";
import { readAlreadyBilledReach, readHandClaimsForJob, type HandClaims } from "@/lib/already-billed-read";
import { hoursByHand, jobAlreadyBilledDoors } from "@/lib/already-billed";
import { AlreadyBilledButton } from "@/components/already-billed-sheet";
import { newInvoicePageFacts, openDraftOnJob, type OpenDraft } from "@/lib/actuals-draw";
import { isLiveQuote, jobBillsItsActuals, nextInvoiceImportsActuals } from "@/lib/invoice-import-rule";
import { reportError } from "@/lib/observe";
import { loadShiftChains } from "@/lib/shift-chain";
import { JobPhotos } from "./job-photos";
import { JobCustomerPage } from "./job-customer-page";
import { JobPanelLoader } from "./job-panel-loader";
import { JobBills } from "./job-bills";
import { JobTaskList, type TaskPhotos } from "./job-task-list";
import { jobTaskTally, readJobTasks, taskPhoto } from "@/lib/job-tasks";
import { buyMaterials, openToBuyCount } from "@/lib/materials-checklist";
import { countOpen, isOpenAppointment, isOpenChangeOrder, isOpenInvoice, isOpenPermit, isOpenQuote, isOpenWorkOrder } from "@/lib/open-counts";
import { JobPermits } from "./job-permits";
import { permitStatusTone, permitResultTone } from "@/lib/permit-options";
import { AddTimeEntry } from "../../timecards/add-time-entry";
import { NoJobPunches, type NearPunches } from "./no-job-punches";
import { jobCrewIds, nearJobWindow, readNoJobPunchesNearJob } from "@/lib/no-job-hours";
import { EditEntryButton } from "../../timecards/edit-entry-button";
import { JobStatusControl } from "./job-status-control";
import { ProposeDatesButton } from "./propose-dates-button";
import { JobContacts } from "./job-contacts";
import { JobScheduleControl } from "./job-schedule-control";
import { JobActionDock } from "./job-action-dock";
import { PaymentScheduleCard } from "./payment-schedule-card";
import { ContractCard } from "./contract-card";
import { LienInsuranceCard } from "./lien-insurance-card";
import { JobTextBox } from "./job-description";
import { JobCrewCard } from "./job-crew-card";
import { ProfitLine } from "./profit-line";
import { computeJobProgress, livePurchaseOrders } from "@/lib/job-progress-math";
import { signDocumentUrls } from "@/lib/signed-docs";
import { documentsForViewer } from "@/lib/tech-documents";
import { billPapers, papersOffThisJob, sortJobPapers, type PaperTie } from "@/lib/job-photos";
import { jobLabel } from "@/lib/schedule-options";
import { FIXED_PILL_CLASS, isFixedPrice } from "@/lib/doc-label";
import { directionsTarget } from "@/lib/maps";
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
import { isOwnerShift } from "@/lib/build-time-cost";
import { ownerRegister } from "@/lib/owner-draw";
import { formatDateTz, todayStrInTz } from "@/lib/tz";
import { dayWords, hmWords, readJobBlock } from "@/lib/schedule/job-block";
import { ownHoursByJobDay, segmentCols, withDayHours, type SegmentRow } from "@/lib/schedule/segment-hours";
import { datesOnly, type DayHours } from "@/lib/schedule-math";
import { InvoiceAmount, InvoiceAmountDetail } from "@/components/invoice-amount";
import { IntakeFiles } from "../../leads/intake-files";
import { intakePaths } from "@/lib/playbook/uploads";
import { TECH_ITEM_COLUMNS } from "@/lib/materials-columns";
import { readJobShelfNet, splitJobMaterialCost } from "@/lib/job-cost";
import { jobTakes } from "@/lib/stock-ledger";
import { TookFromStock } from "../../materials/took-from-stock";
import type { Customer } from "@/lib/types";
import { staleSharedPhotoIds } from "@/lib/portal/shared-photo-state";
import { readSettledBySupplier } from "@/lib/supplier-owed-read";
import { shortSupplierName } from "@/lib/supplier-name";

export const dynamic = "force-dynamic";

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

  // THE SHELF'S PART OF THIS JOB'S MATERIALS (Shop Stock, 0303), started beside the reads below.
  // Staff only through RLS: a tech reads no rows here, and reads no bills either.
  const shelfNetP = readJobShelfNet(supabase, id);
  // THE JOB'S TAKES FROM STOCK (Phase 3, 0344): for the crew and the office, never a cost. Started
  // here too; it needs only the job id.
  const takesP = jobTakes(supabase, id);

  const [
    { data: quotes, error: quotesErr },
    { data: workOrders, error: workOrdersErr },
    { data: changeOrders, error: changeOrdersErr },
    { data: invoices, error: invoicesErr },
    { data: paymentMilestones },
    { data: contractRows },
    { data: lienRecord },
    { data: insuranceClaim },
    { data: pos },
    { data: ownEntries },
    { data: docRows, error: docsErr },
    { data: staff },
    { data: bills },
    jobTasks,
    {
      data: { user },
    },
    rates,
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
      .select("id, profile_id, clock_in, clock_out, lunch_minutes, miles, status, job_id, job_code, notes, rate_override, paid_at, mileage_paid_at, split_from, split_how, source, profiles(full_name), job:job_id(job_number, name)")
      .eq("job_id", id)
      .order("clock_in", { ascending: false }),
    supabase
      .from("documents")
      // uploaded_by: a tech may delete only the photos he took (deleteDocument's rule).
      .select("id, name, category, file_url, size_bytes, created_at, uploaded_by")
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
    j.assigned_to?.length
      ? supabase.from("profiles").select("id, full_name").in("id", j.assigned_to)
      : Promise.resolve({ data: [] as any[] }),
    supabase
      .from("bills")
      // THE LINE STATE RIDES WITH THE BILL (review of the fix wave, 2026-09-20). computeJobProgress
      // now nets a receipt down to what it can BILL - the snacks and the shop stock come off - and
      // MaterialBill.bill_line_items is optional, so a row that arrives without them silently
      // bills its whole amount exactly as it always did. job-financials went through
      // readJobBillsWithLines; this read did not, so the hub's Work To Date and the draw modal
      // that opens from it disagreed by $12.22 on the Wexley job while both claimed to be the
      // same number. The projection law, on the one figure the two screens share.
      // supplier_account_id, supplier_invoice_number, notes and is_statement ride along for the one
      // covering walk (readSettledBySupplier, 8a982483): without them this tab could not be told
      // that the supplier's own closed paper already covers a ticket, so the SAME ticket read
      // "Settled · CED Says" on /bills and "On Account" here.
      // scope_category (0105) rides along for item C1: which part of the job each cost counts under.
      // Without it on the wire the Costs tab row would say no part is set on every cost, and the Edit
      // Bill box would open empty and clear a part somebody had already set — THE PROJECTION LAW.
      .select(
        "id, supplier, supplier_account_id, supplier_invoice_number, is_statement, notes, bill_number, amount, status, bill_date, po_id, scope_category, bill_line_items(id, description, quantity, unit_price, amount, category, billable, billed_amount)",
      )
      .eq("job_id", id)
      // THE BUTTON THAT SET IT ASIDE HAS TO MEAN SOMETHING HERE TOO (review, 2026-09-19). Without
      // this the hub counted the $95.27 duplicate on 13631 Nightshade in cost, in profit and in
      // work-to-date, while /analytics and the job's own financials dropped it - the same job
      // reading $1,990.57 on one screen and $1,895.30 on another.
      .is("superseded_by_bill_id", null)
      .order("created_at", { ascending: false }),
    // THE JOB'S ONE TASK LIST (0358): the Overview card, the Tasks chip's count and the Tasks tab
    // all read this. Safe on a database without 0358 (readJobTasks falls back to the old columns).
    readJobTasks(supabase, id),
    // WHO IS LOOKING rides the first wave (cn-v945): the viewer's role picks the select list for
    // the materials items and the permits below (projection law — a tech's rows never carry
    // money), so the role read must land BEFORE those queries, and the role read needs the user.
    // Fetched here, with nothing waiting on it, the user costs the page no extra round trip.
    supabase.auth.getUser(),
    // Rides along in the wave instead of behind it (audit v921): it needs nothing from these
    // reads, and awaiting it separately cost the page a whole round trip on every job open.
    payRateMap(supabase),
  ]);

  // RATES MERGED FROM THE STAFF-SCOPED VIEW (0215/0216 revoked them from the authenticated
  // role, so these embeds cannot carry them). Without this the job hub's Labor line and every
  // profit figure on the page read ZERO — the exact bug the pay-boundary work was meant to
  // avoid, reintroduced by narrowing the embeds without merging.
  attachRates((ownEntries ?? []) as any[], rates, (e: any) => ({ id: e.profile_id, holder: e }));

  /**
   * ONE WAVE, NOT SIX (audit v800 wave B). These six reads are independent of each other and of
   * everything between them, and they were running strictly one after another — six full
   * round trips to Supabase, in series, before the page could render. On a truck at the edge of
   * coverage that is the difference between a job opening and a tech giving up on it, and the
   * 60mph rule is the standing measure for this page.
   *
   * Only a few reads on this page genuinely depend on another. The viewer's role (needs the
   * user, wave 1) rides here; the canonical material list's items (need the list from this wave
   * AND the role, because the select list is role-shaped) and the permits (same reason) ride the
   * third wave with the rest, rather than dragging unrelated queries along behind them.
   */
  // This job's live bills (ids from the database, so safe inside the filter string below).
  const liveBillIds = ((bills ?? []) as any[]).map((b: any) => String(b.id));
  const [
    { data: pendingProposal },
    { data: scheduleSegments },
    { data: jobLists },
    { data: jobAppts, error: jobApptsErr },
    { data: jobContactsRaw },
    { data: meRow },
    { data: tieRows, error: tieErr },
  ] = await Promise.all([
    supabase
      .from("schedule_proposals")
      .select("id, token, dates")
      .eq("job_id", id)
      .eq("status", "pending")
      .maybeSingle(),
    // Each day's own hours ride along (0370; the read without them before the migration).
    withDayHours((h) =>
      supabase
        .from("job_schedule_segments")
        .select(segmentCols("start_date, end_date", h))
        .eq("job_id", id)
        .order("start_date"),
    ),
    supabase
      .from("material_lists")
      .select("id, name, created_at, material_list_items(count)")
      .eq("job_id", id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
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
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
    // WHICH PAPER MADE WHICH BILL (Erik, 2026-09-27: bills and job photos kept separate): the links
    // the receipt reader, Add Cost and File It write, for this job's papers and this job's bills (a
    // bill moved here keeps its receipt on the old job; its link still names the bill). Rides this
    // wave because it needs the bills above. Staff only by RLS in effect (a tech reads his own rows
    // and the page uses none of them for him).
    supabase
      .from("organized_items")
      .select("id, kind, category, document_id, bill_id, tied_bill_id, tied_supplier_invoice_id, petty_cash_id, file_url")
      .or([`job_id.eq.${j.id}`, ...(liveBillIds.length ? [`bill_id.in.(${liveBillIds})`, `tied_bill_id.in.(${liveBillIds})`] : [])].join(","))
      .limit(2000),
  ]);
  const viewerIsStaff = isStaffRole((meRow as any)?.role ?? "");

  // THE job's materials list — Erik's rule: the Materials tab IS the list, not a
  // list-of-lists. Newest wins, which makes the estimate's take-off (created on
  // "Build material list") canonical when one exists. No list yet → the tab still
  // renders the editor; the first added item lazily creates it server-side
  // (ensureJobMaterialList), so viewing a job never writes data.
  const canonicalList = ((jobLists ?? [])[0] ?? null) as { id: string; name: string } | null;
  // The shifts on this job. A split shift is ordinary entries now (0288), each on its own job, so
  // the part of a shift that went to another job lives on that job's page, and this list is simply
  // this job's rows.
  const entries = ((ownEntries ?? []) as any[]).slice().sort((a: any, b: any) => (a.clock_in < b.clock_in ? 1 : -1));

  // FOUR MORE THAT WERE WAITING THEIR TURN FOR NOTHING (audit v921). storyForJob, the billing
  // labor rows, the customer's labor rate and this job's refunds each need only the job id (and
  // the invoices wave 1 already returned) — they ran one after another below, four extra serial
  // round trips on the most-opened page in the app. They ride this wave instead.
  const invoiceIds = (invoices ?? []).map((i: any) => i.id);
  // PROJECTION LAW (cn-v945): the fee is money, and the read-only permit rows a tech gets are
  // rendered from this same array — so the column is never selected for him, not dropped after.
  const PERMIT_COLUMNS = "id, permit_number, type, authority, status, applied_date, issued_date, inspection_date, inspector, inspection_result, notes, portal_url";
  // THE CARD'S MONEY IS THE DOOR'S MONEY (MONEY law). EVERY Time & Material job bills its actuals
  // (unclaimed hours + bills), estimate or not: on T&M the estimate is a guide, never a block (Erik,
  // 2026-09-26, Tess J-002, whose accepted estimate hid the running total). A payment schedule is
  // billed by its milestones and a fixed-price job by its contract; there no door would draft the
  // card's figure, so the Overview carries no UnbilledCard at all and the page skips the read.
  // One rule with the customer portal (jobBillsItsActuals), so the customer is shown "not on a
  // bill yet" on exactly the jobs the office is.
  const billsActuals = jobBillsItsActuals(j.billing_type, (paymentMilestones ?? []).length);
  // THE COSTS TAB'S PILES FOLLOW NEW INVOICE'S OWN RULE (nextInvoiceImportsActuals): wherever the next
  // New Invoice pulls the job's hours and receipts, the tab says what is Not Billed Yet and offers
  // Already Billed, fixed-price jobs with no live estimate included (J-010 Pinyon Sage). The same rule
  // opens the Already Billed sheet, so no door shows where the sheet refuses and none is missing where
  // it works. Wider than billsActuals (every Time & Material job with no schedule is in both); the
  // Overview's running total keeps billsActuals.
  const importsActuals = nextInvoiceImportsActuals(
    j.billing_type,
    (paymentMilestones ?? []).length,
    ((quotes ?? []) as { status?: string | null }[]).some((q) => isLiveQuote(q.status)),
  );
  const pilesOn = billsActuals || (viewerIsStaff && importsActuals);
  const [
    { data: canonicalItems },
    { data: permits, error: permitsErr },
    { data: techs },
    { data: jobCodes },
    { data: lists },
    { data: org },
    { data: allCustomers },
    { data: allJobs },
    { data: codeTemplates },
    { data: openEntryRow },
    story,
    laborRows,
    jobLevelRate,
    { data: refundRows },
    unbilled,
    { data: pettyRows },
    openDraft,
    lumpToNet,
    panelCount,
    panelHolds,
    tmWork,
    papers,
    jobStock,
    handClaims,
    abReach,
    settledSays,
  ] = await Promise.all([
    // THE job's items, role-shaped (projection law): staff read every column, a tech reads
    // TECH_ITEM_COLUMNS — no est_cost, no vendor — the same list /materials/[id] uses, so the one
    // materials list shows the crew the same face through either door. This read used to sit in
    // a wave of its own; it needs the list (wave 1) and the role (wave 2), both in hand here.
    canonicalList
      ? supabase
          .from("material_list_items")
          .select(viewerIsStaff ? "*" : TECH_ITEM_COLUMNS)
          .eq("list_id", canonicalList.id)
          .order("sort_order")
      : Promise.resolve({ data: null }),
    supabase
      .from("permits")
      .select(viewerIsStaff ? `${PERMIT_COLUMNS}, fee` : PERMIT_COLUMNS)
      .eq("job_id", id)
      .order("created_at", { ascending: false }),
    // Staff get hourly_rate + bill_rate for the add-time/edit modals' pay-rate
    // anchor; NON-staff keep the narrow select. The gate matters here: this array
    // serializes into client-component props (RSC), so an unconditional enrichment
    // would hand every tech the whole crew's pay + bill rates — "the modal returns
    // null for non-staff" is not a serialization defense. paid_by_draw (0286) tells the add-time
    // modal to hide the pay-rate override for the owner, whose shifts have no pay rate.
    // `active` (not money) lets the Overview's crew card offer only people still on the team.
    viewerIsStaff
      ? supabase.from("profile_pay").select("id, full_name, home_address, hourly_rate, bill_rate, paid_by_draw, active").order("full_name")
      : supabase.from("profile_pay").select("id, full_name, home_address").order("full_name"),
    supabase.from("job_codes").select("*").order("code"),
    supabase.from("material_lists").select("id, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("organizations").select("address_line1, city, state, zip, settings, stripe_account_id, stripe_account_status, stripe_charges_enabled").limit(1).maybeSingle(),
    // The customer book feeds the contacts editor, the appointment picker and the dock's Edit
    // Job modal — every one a staff door — so a tech's page doesn't pay for the read.
    viewerIsStaff
      ? supabase.from("customers").select("id, name, type").order("name")
      : Promise.resolve({ data: [] as any[] }),
    supabase.from("jobs").select("id, job_number, name").order("created_at", { ascending: false }).limit(100),
    supabase.from("job_code_templates").select("id, name").order("name"),
    // The viewer's OPEN time entry (drives the action dock's 3-state TIME button). A Switch Job
    // closes it and opens the next piece (0288 switch_job), so its clock_in IS where the running
    // part started, and the "Switch here" confirm names now - clock_in as the outgoing hours.
    supabase
      .from("time_entries")
      .select("id, profile_id, clock_in, job_id, job_code, split_from, job:job_id(job_number, name)")
      .eq("profile_id", user?.id ?? "")
      .eq("status", "open")
      .maybeSingle(),
    // The activity log — assembled from the rows themselves, see lib/story.
    storyForJob(supabase, j.id),
    // A lost hours or rate read throws (audit v1018 money-1): logged, and a fixed-price job's Work
    // To Date says it couldn't total (workedToDate below) instead of counting no labor.
    fetchJobLaborRows(supabase, id).catch((e) => {
      reportError("jobs.[id].laborRows", e, { jobId: id });
      return null;
    }),
    customerLaborRateForJob(supabase, id).catch((e) => {
      reportError("jobs.[id].levelRate", e, { jobId: id });
      return undefined;
    }),
    invoiceIds.length
      ? supabase.from("customer_credits").select("amount").eq("disposition", "refund").in("invoice_id", invoiceIds)
      : Promise.resolve({ data: [] as any[] }),
    // THE RUNNING TOTAL for the Overview's UnbilledCard — the hours and bills no non-void
    // invoice has claimed, the arithmetic Nort's job-numbers tool speaks. Rides this wave
    // (it needs only the job id) and only on a job that BILLS its actuals (billsActuals, above), or,
    // for the office's Costs tab piles, one whose next New Invoice pulls them (pilesOn): anywhere
    // else the figure isn't what the door would draft, so the page doesn't read it. A failure here
    // must not take the job page down with it (the 60mph rule): logged, and the card says it
    // couldn't total and names the tabs.
    pilesOn
      ? unbilledWorkForJob(supabase, id).catch((e) => {
          reportError("jobs.[id].unbilledWork", e, { jobId: id });
          return null;
        })
      : Promise.resolve(null),
    // THE JOB'S PETTY CASH IS COST HERE TOO (0286 build). /analytics and Nort have counted it since
    // audit v800 (computeJobProfitRows), and this hub did not, so one job carried two profits. Staff
    // only by RLS (0056), which is fine: the Costs tab is staff-only. `replenish` is the tin being
    // refilled, a transfer, never a cost.
    viewerIsStaff
      ? supabase.from("petty_cash").select("amount, kind").eq("job_id", id)
      : Promise.resolve({ data: [] as any[] }),
    // THE OPEN DRAFT AND WHETHER NEW WORK CAN GO ON IT (lib/actuals-draw, J-011). The Overview
    // card's button and the job's New Invoice both read it, so neither offers a door the
    // server refuses: an actuals draw says "Add to INV-078", a contract draw says "Open INV-0xx".
    // Staff only (a tech's card has no button) and only when a draft exists at all. A failed read
    // falls back to the invoices already in hand, treating any draw as one to open, not add to.
    viewerIsStaff && (invoices ?? []).some((i: any) => i.status === "draft")
      ? openDraftOnJob(supabase, id).catch((e) => {
          reportError("jobs.[id].openDraft", e, { jobId: id });
          const d = ((invoices ?? []) as any[]).find((i) => i.status === "draft");
          return d ? ({ id: d.id, number: d.invoice_number ?? null, kind: d.invoice_kind ?? "standard", refreshable: !isDrawKind(d.invoice_kind) } as OpenDraft) : null;
        })
      : Promise.resolve(null as OpenDraft | null),
    // THE DEPOSIT THE NEXT BILL TAKES OFF (review, 2026-09-24). On a job with a draw, the card's
    // "Create Invoice" is a progress report, and that report nets any deposit or set-amount draw no
    // bill has taken off yet (resolveDrawCredit). The card names the net - or says the deposit still
    // covers it - instead of a figure the click won't bill. A lost read is logged and counts $0:
    // the button then shows the gross, and the server still nets and says so.
    viewerIsStaff && pilesOn && (invoices ?? []).some((i: any) => i.status !== "void" && isDrawKind(i.invoice_kind))
      ? fixedBillingsNotYetNetted(supabase, id).catch((e) => {
          reportError("jobs.[id].lumpToNet", e, { jobId: id });
          return 0;
        })
      : Promise.resolve(0),
    // THE PANEL CHIP'S COUNT: one head-only count of the job's live SUGGESTED circuits (the take-off's
    // and the readers' rows waiting on a Keep or a Not This), riding this wave (no round trip of its
    // own). Open only (Erik, 2026-09-27: "all badges only show whats open"): the kept circuits are the
    // panel's contents, not work, so they are never the badge. A database without 0333 yet answers
    // with an error: no count, and the tab says so itself when opened.
    supabase
      .from("job_circuits")
      .select("id", { count: "exact", head: true })
      .eq("job_id", id)
      .eq("state", "suggested")
      .is("removed_at", null)
      .then(
        (r: { count: number | null; error: unknown }) => (r.error ? undefined : (r.count ?? 0)),
        () => undefined,
      ),
    // DOES THE PANEL TAB HOLD ANYTHING: any panel, or any live circuit, kept or suggested. Head-only
    // counts; the badge stays panelCount (the open ones). `holds` is what tells the crew's strip the
    // tab has nothing to read and nothing he could add; a failed read (a database without 0333
    // included) counts as holding, so an error never takes the tab off his strip.
    Promise.all([
      supabase.from("job_panels").select("id", { count: "exact", head: true }).eq("job_id", id).is("removed_at", null),
      supabase.from("job_circuits").select("id", { count: "exact", head: true }).eq("job_id", id).is("removed_at", null),
    ]).then(
      ([p, c]: { count: number | null; error: unknown }[]) => (p.error || c.error ? true : (p.count ?? 0) + (c.count ?? 0) > 0),
      () => true,
    ),
    // A TIME & MATERIAL JOB'S WORK TO DATE IS WHAT WAS BILLED, AT THE PRICE BILLED, PLUS WHAT THE
    // NEXT BILL WOULD CHARGE (tmWorkToDate, the reader behind the Progress Summary and Nort). Staff
    // only: the New Invoice sheet's "Work so far" is its one reader here. A failed read is
    // logged and the sheet says it couldn't total - never a figure priced some other way.
    viewerIsStaff && (j as any).billing_type === "tm"
      ? tmWorkToDate(supabase, id).catch((e: unknown) => {
          reportError("jobs.[id].tmWorkToDate", e, { jobId: id });
          return "failed" as const;
        })
      : Promise.resolve(null),
    // THE SUPPLIER'S PAPERS THAT NAME THIS JOB AND ARE IN NOBODY'S BOOKS (Erik, 2026-09-25: CED
    // 8802-1107820, $187.64, "41 LARKSPUR", was on no cost list and no invoice). The Costs tab's
    // Named On A Paper list; staff only (the Costs tab is). A failed read is logged and the list
    // says it couldn't check - never an empty list, which would read as "nothing missing".
    viewerIsStaff
      ? readJobPapers(supabase, j.org_id, id).catch((e: unknown) => {
          reportError("jobs.[id].papers", e, { jobId: id });
          return null;
        })
      : Promise.resolve([]),
    // THE JOB'S TAKES FROM STOCK (Shop Stock, Phase 3), read once for two things: the pieces taken
    // past the shelf, said before an invoice is built (the job's New Invoice carries the sentence,
    // in its sheet or beside it), and the takes themselves, which are a FIXED-PRICE job's work to
    // date exactly as the invoice page and the /print report count them (jobProgressFinancials). A
    // Time & Material job's takes are in tmWork above (billed ones as their lines, open ones in
    // unbilledWorkForJob), never counted a second way here. Staff only (a tech's page reads no stock
    // and builds no invoice). A lost read is SAID (stockReadFailed below): a fixed-price job's work to
    // date can't be totalled without it, exactly as jobProgressFinancials throws on /i and /print.
    viewerIsStaff
      ? readJobStock(supabase, id).then(
          (s) => s,
          (e) => {
            reportError("jobs.[id].stock", e, { jobId: id });
            return null;
          },
        )
      : Promise.resolve(null as Awaited<ReturnType<typeof readJobStock>> | null),
    // ALREADY BILLED (0357): which of the job's rows a person marked as billed, and on which line,
    // for "Billed By Hand On INV-x · Not Billed After All". Staff only, on EVERY job whatever its
    // billing type: a mark can sit on a fixed-price job New Invoice bills from its actuals (J-010
    // Pinyon Sage), and the way back has to be there wherever a mark is. A lost read is logged and
    // SAID (handsNote below): the marks and their Not Billed After All can't be shown, and marked
    // hours would otherwise vanish from the tab without a word. A database without 0357 reads as
    // not ready (nothing can have been marked).
    viewerIsStaff
      ? readHandClaimsForJob(supabase, id, (j as any).customer_id ?? null).catch((e: unknown) => {
          reportError("jobs.[id].handClaims", e, { jobId: id });
          return "failed" as const;
        })
      : Promise.resolve(null as HandClaims | "failed" | null),
    // ALREADY BILLED'S DOORS ASK WHETHER A LINE COULD HOLD THE COST, by the sheet's own reading
    // (readAlreadyBilledReach: the job's sent bills and, on a job that isn't Time & Material, its
    // customer's invoices with no job). A door onto a sheet with no line to pick is a dead end. A lost
    // read is logged and the doors show as before (the sheet says what it finds). A database without
    // 0357 (not ready) draws no door, like the Bills page and the supplier cards: every sheet it
    // opened would only say it needs an update. Skipped where nothing could hold a cost: no sent bill
    // on the job, and (T&M) no other invoice it may use.
    viewerIsStaff &&
    importsActuals &&
    (((invoices ?? []) as any[]).some((i) => i.status !== "draft" && i.status !== "void") || (j.billing_type !== "tm" && !!j.customer_id))
      ? readAlreadyBilledReach(supabase, j.org_id, [id]).then(
          (r) => (r.ready ? (r.jobs.get(id) ?? { charge: false, ret: false }) : { charge: false, ret: false }),
          (e: unknown) => {
            reportError("jobs.[id].alreadyBilledReach", e, { jobId: id });
            return null;
          },
        )
      : Promise.resolve(null as { charge: boolean; ret: boolean } | null),
    // WHAT THE SUPPLIER'S OWN BOOKS SAY ABOUT THESE TICKETS (8a982483). The badge on a bill row is
    // one expression both screens draw, but only /bills had ever been handed the fact, so a ticket
    // whose covering supplier paper is closed said "Settled · CED Says" there and "On Account" here -
    // one ticket described two ways, with nothing on this tab saying the money had already left the
    // supplier's balance. THE SAME covering walk, never a second copy. Staff only (the Costs tab is).
    // A lost read says so in words below; it never quietly draws "On Account".
    viewerIsStaff
      ? readSettledBySupplier(supabase, j.org_id, (bills ?? []) as any[]).catch((e: unknown) => {
          reportError("jobs.[id].settledBySupplier", e, { jobId: id });
          return { settled: new Map<string, string>(), unread: true, failed: ["the suppliers' own papers"] };
        })
      : Promise.resolve({ settled: new Map<string, string>(), unread: false, failed: [] as string[] }),
  ]);

  // THE COSTS TAB'S BILL ROWS, CARRYING THE SUPPLIER'S OWN VERDICT (8a982483). The badge is one
  // expression (billSettledLabel) and this screen drew it already; what it had never been handed was
  // the FACT, so every ticket here read "On Account" however many closed supplier papers covered it.
  // The name is the ACCOUNT's, the way /bills names it, so the two rows read the same words.
  const costBills = ((bills ?? []) as any[]).map((b) => {
    const says = settledSays.settled.get(String(b.id));
    return {
      ...b,
      settledBySupplier: says !== undefined,
      settledBySupplierName: says ? shortSupplierName(says) : null,
    };
  });

  // PROJECTION at the boundary: staff get the money; a tech's view is HOURS ONLY — no rate, no
  // amount, no bills, no crew (a tech reads only his own rows, so the hours ARE his) — built here
  // so the figures never reach his props (tech-job-access). Before migration 0255 lands the labor
  // claims are unknowable (schemaReady:false) and the hours would count every shift ever worked:
  // MONEY law, never invent a figure — the card says it couldn't total rather than show that.
  const unbilledView: UnbilledView | null = !unbilled || !unbilled.schemaReady
    ? null
    : viewerIsStaff
      ? { kind: "staff", ...unbilled }
      : {
          kind: "tech",
          hours: unbilled.hours,
          lastInvoiceNumber: unbilled.lastInvoiceNumber,
          lastInvoiceAt: unbilled.lastInvoiceAt,
          // His running shift is on THIS job (the dock's TIME button reads the same row): the card
          // must not send him to a Clock In the dock isn't showing.
          onClockHere: !!openEntryRow && String((openEntryRow as { job_id?: string | null }).job_id ?? "") === String(j.id),
          // On the clock somewhere else: the same row makes the dock's button read Switch, so the
          // card names Switch (another job, or a punch with no job), never a Clock In that isn't there.
          onClockElsewhere: !openEntryRow || String((openEntryRow as { job_id?: string | null }).job_id ?? "") === String(j.id)
            ? null
            : (openEntryRow as { job_id?: string | null }).job_id ? "another_job" : "no_job",
        };
  // THE COSTS TAB, OPEN FIRST (Erik, 2026-09-25). The job's bills and orders sorted by the Unbilled
  // card's own per-row verdict (UnbilledWork.costRows), so Not Billed Yet is exactly what that
  // card's button bills. Only where the card exists (a job that bills its actuals, the claims
  // readable): on a fixed-price or scheduled job no invoice bills these rows, so "not billed yet" would be
  // every bill forever, and the tab keeps its one plain list.
  const costGroups =
    viewerIsStaff && unbilled && unbilled.schemaReady
      ? groupJobCosts(
          [
            ...((bills ?? []) as any[]).map((b) => ({ id: String(b.id), kind: "bill" as const, amount: Number(b.amount) || 0 })),
            ...((pos ?? []) as any[]).map((p) => ({ id: String(p.id), kind: "po" as const, amount: Number(p.total) || 0 })),
          ],
          unbilled.costRows,
          id,
        )
      : null;
  const costGroupsNote =
    viewerIsStaff && pilesOn && !costGroups
      ? "Couldn't tell which bills are on an invoice right now, so this is every bill on the job. The Invoices tab has what each invoice holds."
      : null;
  // ALREADY BILLED (0357, Erik's Pinyon Sage). Only where the piles exist (staff, a job whose next New
  // Invoice pulls its actuals, the claims readable): Already Billed on a Not Billed Yet row when a
  // sent bill the sheet offers could hold it (never one with no job for a Time & Material job: its
  // work to date counts only its own invoices); Billed By Hand · Not Billed After All on a row a
  // person marked. The hours line gets the same pair below. A lost reach read offers the doors
  // wherever a sent bill is on the job (the sheet says what it finds).
  const alreadyBilledOffer = ((invoices ?? []) as any[]).some((i) => i.status !== "draft" && i.status !== "void" && (i.invoice_kind ?? "standard") !== "deposit");
  const alreadyBilledCan = abReach ?? { charge: alreadyBilledOffer, ret: alreadyBilledOffer };
  const handById = handClaims && handClaims !== "failed" && handClaims.ready ? handClaims.byId : null;
  const handsNote =
    handClaims === "failed"
      ? "Couldn't tell which rows were marked billed by hand just now, so Not Billed After All isn't shown. Reload to try again."
      : null;
  // Without the piles (a fixed-price job, or the claims unreadable) the tab is one plain list, and a
  // row a person marked still says so there, with Not Billed After All: every row is a candidate.
  const alreadyBilledDoors =
    costGroups || (handById && handById.size > 0)
      ? jobAlreadyBilledDoors({
          groups: costGroups ?? { open: { ids: [] }, billed: [{ ids: ((bills ?? []) as any[]).map((b) => String(b.id)) }] },
          bills: (bills ?? []) as any[],
          pos: (pos ?? []) as any[],
          takes: (jobStock?.takes ?? []).map((t) => ({ key: stockKey(t.group), moveIds: t.moveIds, label: stockCostLabel(t) })),
          hands: handById,
          offer: costGroups ? alreadyBilledCan : { charge: false, ret: false },
        })
      : null;
  const hoursMarked = hoursByHand((laborRows?.jobEntries ?? []) as any[], handById);
  const paperViews: JobPaperView[] | null = papers
    ? papers.map((p) => ({
        id: p.id,
        invoiceNumber: p.invoiceNumber,
        invoiceDate: p.invoiceDate,
        jobNameRaw: p.jobNameRaw,
        total: p.total,
        filed: p.jobId === id,
        accountId: p.accountId,
        onNeedsYou: p.onNeedsYou === true,
        waitingOnCredit: p.waitingOnCredit === true,
        waitingSince: p.waitingSince ?? null,
        supplier: p.supplier ?? null,
      }))
    : null;
  const oe = openEntryRow as any;
  // THE SHIFT, NOT THE PIECE (audit v994 SW1): the long-shift door counts from the first part.
  let oeShiftStart: string | null = null;
  if (oe?.split_from) {
    try {
      oeShiftStart = (await loadShiftChains(supabase as any, [oe], null)).get(String(oe.id))?.startIso ?? null;
    } catch (e) {
      reportError("jobs.[id].shiftChain", e, { jobId: id });
    }
  }
  const openEntry = oe
    ? {
        id: oe.id as string,
        clock_in: oe.clock_in as string,
        shift_start: oeShiftStart,
        job_id: (oe.job_id ?? null) as string | null,
        job_code: (oe.job_code ?? null) as string | null,
        jobLabel: oe.job ? jobLabel(oe.job) : null,
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

  // PUNCHES WITH NO JOB near this job (the duplicate punches, 2026-09-26): its crew's closed,
  // job-less, unbilled shifts from the day before its first day to two days after its last, for
  // the office's Put This On door on the Time tab. Office only. Null = the read failed (said).
  // STARTED HERE, awaited below: it is up to three round trips one after another (codes, entries,
  // claims), and everything it needs is known by now, so it runs beside the shelf, takes, document
  // and split reads instead of after them on every office open of this page.
  const nearPunchesP: Promise<NearPunches | null> = viewerIsStaff
    ? readNoJobPunchesNearJob(supabase as any, {
        crewIds: jobCrewIds(j.assigned_to, (entries ?? []) as { profile_id?: string | null }[]),
        window: nearJobWindow({
          tz,
          entries: (entries ?? []) as { clock_in?: string | null; clock_out?: string | null }[],
          scheduledStart: j.scheduled_start,
          scheduledEnd: j.scheduled_end,
          segments: (scheduleSegments ?? []) as unknown as { start_date?: string | null; end_date?: string | null }[],
        }),
        tz,
        todayStr: todayStrInTz(tz),
      }).then(
        (near) =>
          near
            ? {
                punches: near.shifts.map((s) => ({ id: s.id, name: s.name, clockIn: s.clockIn, clockOut: s.clockOut, hours: s.hours, jobCode: s.jobCode })),
                capped: near.capped,
              }
            : null,
        (e) => {
          reportError("jobs.[id].noJobPunches", e, { jobId: id });
          return null;
        },
      )
    : Promise.resolve({ punches: [], capped: false });

  // The org's all-day work window (Settings → Scheduling) — the same resolver the
  // schedule writers use, threaded into the schedule/edit controls so their "blank
  // time = all-day" sentinel and default times track the org's window, not a fixed 8-4.
  const workDay = workDayWindowHm((org as any)?.settings);
  // The lifecycle gate the dock's Finish Job and the Overview's Offer Dates share: a done, invoiced
  // or cancelled job is not offered a schedule.
  const schedulable = j.status !== "complete" && j.status !== "invoiced" && j.status !== "cancelled";

  // THE SCHEDULE AS A SENTENCE, for a tech (cn-v945). The date pickers save on change through
  // setJobScheduleRanges, a staff-only writer — so for him they were inputs that quietly
  // reverted. Segments are date-only strings (formatDate anchors them to noon UTC, so the day
  // never shifts in Pacific); a start time shows only when it's an explicit one, i.e. not the
  // org's all-day sentinel — the same rule the picker uses to decide whether to show a time.
  // THE JOB'S BLOCK on the company's clock: its start and the end its length gives it, the one rule
  // the calendar draws and the time controls edit (lib/schedule/job-block).
  const block = readJobBlock({
    scheduledStart: j.scheduled_start ?? null,
    scheduledEnd: j.scheduled_end ?? null,
    plannedMinutes: j.planned_minutes ?? null,
    tz,
    workDay,
  });
  /* THE DAYS, AS DAYS (the range editor and the words list the ranges a person made, never split where
     a day keeps its own hours), and THE DAYS THAT KEEP THEIR OWN HOURS (0370), said: the time control
     below sets the job's usual hours, every OTHER day. */
  const segRows = (scheduleSegments ?? []) as unknown as SegmentRow[];
  const scheduleDays = datesOnly(segRows.map((s) => ({ start: s.start_date, end: s.end_date }))).map((s) => ({ start_date: s.start, end_date: s.end }));
  const ownDays = [...(ownHoursByJobDay(segRows.map((s) => ({ ...s, job_id: id }))).get(id) ?? new Map<string, DayHours>()).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, h]) => ({ day, hours: h, words: `${dayWords(day)} ${hmWords(h.start)} – ${hmWords(h.end)}` }));
  const scheduleText: string | null = (() => {
    const segs = scheduleDays;
    // The crew reads the whole block, start AND end ("10:00 AM – 12:00 PM"), never just a start. On
    // several days those are its hours on each of them ("10:00 AM – 12:00 PM each day"): a 10–12 job
    // and a full day must not read the same.
    const startTime = !j.scheduled_start || block.allDay
      ? null
      : `${hmWords(block.startHm)} – ${hmWords(block.endHm)}${block.multiDay ? " each day" : ""}`;
    const days = segs.length
      ? segs
          .map((sg) => (sg.start_date === sg.end_date ? formatDate(sg.start_date) : `${formatDate(sg.start_date)} – ${formatDate(sg.end_date)}`))
          .join(" · ")
      : j.scheduled_start
        ? j.scheduled_end && formatDateTz(j.scheduled_end, tz) !== formatDateTz(j.scheduled_start, tz)
          ? `${formatDateTz(j.scheduled_start, tz)} – ${formatDateTz(j.scheduled_end, tz)}`
          : formatDateTz(j.scheduled_start, tz)
        : null;
    if (!days) return null;
    const line = startTime ? `${days} · ${startTime}` : days;
    // A day that keeps its own hours (0370) says them, for the crew as for the office.
    return ownDays.length ? `${line} · ${ownDays.map((o) => `${o.words}`).join(" · ")}` : line;
  })();

  // Costing. laborCost = what we PAY (pay rate); billableLabor = what we CHARGE
  // (bill rate) — the latter feeds the estimate-vs-actual draw tracking.
  // laborCost (what we PAY) via the shared helper — identical math to /analytics.
  //
  // BUILD TIME IS A DIRECT COST, WHOEVER WORKED IT (Erik, 2026-10-01: "build time, including my build
  // time is considered COGS, so it would be considered a direct cost and should be counted that way").
  // So laborCostForJob now costs the owner's hours too, at the cost rate HE SETS - never his bill rate,
  // which is what made every hour of his net exactly $0 before 0286, and never a wage: he is still not
  // on payroll. `laborCost` is the whole of what this job's labour cost; `ownerCost` is his share of it
  // and `crewLabor` below is the rest, so the rows still say whose time was whose.
  //
  // UNTIL HE SETS THE RATE NOTHING MOVES. uncostedOwnerHours comes back instead, the tile says so in
  // words, and this job's profit reads exactly what it read yesterday.
  const {
    hours: laborHours,
    cost: laborCost,
    ownerHours,
    ownerCost,
    uncostedOwnerHours,
  } = laborCostForJob(entries ?? [], id);
  const crewHours = Math.max(0, Math.round((laborHours - ownerHours) * 100) / 100);
  const crewLabor = Math.round((laborCost - ownerCost) * 100) / 100;
  // WHOSE HOURS THOSE ARE, BY THE SAME TEST THAT COSTED THEM (isOwnerShift). This asked
  // `e?.profiles?.paid_by_draw === true` by hand, which is only HALF of isOwnerShift - it misses the
  // `|| e?.paid_by_draw === true` branch - so on a row carrying the flag at top level the cost above
  // was non-zero while this list came back empty, and the tile printed a cost it could not attribute to
  // anybody. One expression, in the owner module, so the two can never disagree again.
  const ownersOnJob = ((entries ?? []) as any[])
    .filter((e: any) => isOwnerShift(e) && e.profile_id)
    .map((e: any) => ({ id: String(e.profile_id), name: e.profiles?.full_name ?? null }));
  const ownerVoice = ownerRegister(ownersOnJob, user?.id ?? null);
  // Materials, via the ONE shared rule (livePurchaseOrders): a draft/cancelled PO isn't a
  // cost, and a PO whose supplier bill has arrived is SUPERSEDED by that bill (bills.po_id,
  // migration 0142) — so one CED delivery entered as both a PO and the supplier's invoice
  // is costed once, at the invoiced amount, here and on /analytics and on the draw.
  const materialCost = livePurchaseOrders((pos ?? []) as any[], (bills ?? []) as any[]).reduce(
    (s: number, p: any) => s + Number(p.total ?? 0),
    0,
  );
  /**
   * JOB COST IS THE WHOLE RECEIPT, ON PURPOSE - and it is written down here because the codebase
   * now does both things and, until this line, said neither (review of the fix wave, 2026-09-20).
   *
   * `billableBillCost` nets a receipt down for the figures about what a CUSTOMER pays: work to
   * date, unbilled work, the draw. This one is what the job COST the company, and the company did
   * pay for the Kettle Chips and for the whole box of wire nuts, whoever ends up using them. So
   * the full amount stands here, and the gap between the two numbers is real rather than a bug.
   *
   * THE SHELF IS THE ONE EXCEPTION, AND IT IS NOT A NETTING (Shop Stock, 0303). What went on the
   * shelf from this job's tickets was bought for the van, not for this job, so its cost comes off
   * here and lands on whichever job takes the pieces, at what they cost: job material cost =
   * tickets - off_shelf + from_shelf (src/lib/job-cost.ts, the same view /analytics and Nort
   * read). With nothing on the shelf, that is the tickets' total to the cent, as it always was.
   */
  const shelf = await shelfNetP;
  if (shelf.error) throw shelf.error;
  // A takes read that fails is logged, and the list says so in its place (never an empty list:
  // it is the list the sheet sends people to before tapping Take It again). The button still works.
  const takes = await takesP;
  if (takes.error) reportError("jobs.page.stockTakes", takes.error, { jobId: id });
  const jobMaterials = splitJobMaterialCost(
    (bills ?? []).reduce((s: number, b: any) => s + Number(b.amount ?? 0), 0),
    shelf.byJob.get(id),
  );
  const billsCost = jobMaterials.total;
  // Billable work to date + the progress rollups — via the extracted computeJobProgress
  // SSOT (the exact rollup the draw modal / print report use: estimate = accepted contract
  // via contractTotalFromQuotes, invoiced = non-void non-draft, collected = non-void
  // amount_paid, materials marked up per row like importCosts). One rule change there
  // reaches this hub automatically.
  const materialMarkup = getOrgSettings((org as any)?.settings).material_markup_percent;
  const defaultLaborRate = getOrgSettings((org as any)?.settings).default_labor_rate;
  // timeclock_job_codes=false must hide EVERY code picker (cn-v517) — including the
  // Time tab's add/edit modals here, not just the /timecards mounts.
  const jobCodesEnabled = getOrgSettings((org as any)?.settings).timeclock_job_codes;
  // THE SWITCH BOARD (0352): which of this company's features are on, and whether the viewer is the
  // one person who can turn a switch back on (the Off line's Turn On). A switch hides DOORS on this
  // page (New Estimate, New PO, Took From Stock, the Inspector...), never a read: every money figure
  // above (open POs, payment milestones, the shelf) is computed exactly as it was.
  const switches = { features: getOrgSettings((org as any)?.settings).features, isOwner: (meRow as any)?.role === "owner" };
  const on = (k: FeatureKey) => featureOn(switches.features, k);
  const laborReadFailed = laborRows === null || jobLevelRate === undefined;
  const billableLabor = laborRows
    ? computeJobLaborBilling(laborRows.jobEntries, defaultLaborRate, jobLevelRate ?? null, laborRows.nonBillableCodes).total
    : 0;
  const progress = computeJobProgress({
    billingTypeRaw: (j as any).billing_type,
    quotes: (quotes ?? []) as any,
    invoices: (invoices ?? []) as any,
    billableLabor,
    pos: (pos ?? []) as any,
    bills: (bills ?? []) as any,
    markupPercent: materialMarkup,
    tmWork: tmWork === "failed" ? null : tmWork,
    stockTakes: jobStock?.takes ?? [],
  });
  // Staff read the takes; null for staff means the read failed (a database without the shelf reads
  // as no takes, never null). Never a smaller number in silence.
  const stockReadFailed = viewerIsStaff && jobStock === null;
  // null = a total that could not be read: the modal says so instead of showing a number. A T&M
  // total is tmWork's; a fixed-price one counts the takes, so a lost stock read can't be totalled.
  const workedToDate: number | null =
    tmWork === "failed" || ((stockReadFailed || laborReadFailed) && progress.billingType !== "tm") ? null : progress.workToDate;
  const stockShortsWords = jobStock
    ? stockShortsSentence(jobStock.shorts)
    : stockReadFailed
      ? "The pieces taken from stock couldn't be read just now, so any taken past stock aren't named here. Reload to try again."
      : null;
  const totalMiles = (entries ?? []).reduce((s: number, e: any) => s + Number(e.miles ?? 0), 0);
  // Revenue = CASH COLLECTED on this job (Erik's rule): the amount actually paid
  // on the job's non-void invoices, net of refunds — NOT the sum of invoice/quote
  // totals (which double-counts a progress invoice + the final). The tile says
  // "Collected" because that is what the figure is: it used to be labelled
  // "Invoiced" or "Estimated" by whether any invoice existed, over a cash number.
  // Estimate base = the ACCEPTED contract (progress.estimate). Same value under two
  // names: `quoted` feeds the draw UI, `contractTotal` the payment schedule.
  const quoted = progress.estimate;
  const contractTotal = progress.estimate;
  // Billed-to-date for progress payments = invoices actually SENT to the customer
  // (non-void, non-draft — a draft draw isn't a real bill): progress.invoiced.
  const billedToDate = progress.invoiced;
  const collected = progress.collected;
  // HOISTED so two cards can ask the same question and get the same answer. The action dock has
  // always computed this; the payment-schedule card needs it too, because "Set Up Schedule" was
  // being offered on a job whose draws have already gone out, where the server can only refuse
  // (2026-09-18 dead-end sweep). Computed once, so the two surfaces cannot drift apart.
  const isDrawBilled = (invoices ?? []).some(
    (i: any) => isDrawKind(i.invoice_kind) && i.status !== "void",
  );
  // THE OVERVIEW'S ONE FIGURE ON A JOB BILLED BY ITS CONTRACT (W1-19): Left To Bill, from the same
  // figures above (the contract, what went out on sent bills) or the schedule's own status, the one
  // PaymentScheduleCard shows. Staff only (the card is never mounted for a tech).
  const scheduleView = (paymentMilestones ?? []).length ? scheduleStatus((paymentMilestones ?? []) as Milestone[], contractTotal) : null;
  const leftView = leftToBill(progress, scheduleView);
  const draftInvoice =
    ((invoices ?? []) as any[]).find((i) => openDraft && i.id === openDraft.id) ?? ((invoices ?? []) as any[]).find((i) => i.status === "draft") ?? null;
  // THE JOB'S NEW INVOICE, ONE SET OF FACTS (W1-24, W1-19): the Invoices tab's button and the Left To
  // Bill card's are the same button with the same props, so the two can never answer differently.
  // Every prop is a fact this page already read; what one tap does is lib/actuals-draw newInvoiceRoute.
  const newInvoiceProps = {
    jobId: j.id as string,
    billingType: (j as any).billing_type ?? "fixed",
    estimate: quoted,
    // hasEstimate, drawBilled, scheduleActive, billsActuals, wholeEstimate and changeOrdersToBill, derived
    // once from this page's own reads (lib/actuals-draw newInvoicePageFacts).
    ...newInvoicePageFacts({
      billingType: (j as any).billing_type ?? "fixed",
      estimate: quoted,
      quotes: (quotes ?? []) as any[],
      invoices: (invoices ?? []) as any[],
      milestoneCount: ((paymentMilestones as any) ?? []).length,
      // Approved change orders: Bill The Change Orders once the estimate's bill is out.
      changeOrders: (changeOrders ?? []) as { status?: string | null; amount?: number | null }[],
    }),
    worked: workedToDate,
    billed: billedToDate,
    paid: collected,
    openDraft: openDraft ? { id: openDraft.id, number: openDraft.number, refreshable: openDraft.refreshable } : null,
    // The Overview card's own figures (the same door, so the sheet and the card agree).
    unbilled:
      unbilled && unbilled.schemaReady
        ? {
            hours: unbilled.hours,
            billsCount: unbilled.billsCount,
            stockCount: unbilled.stockCount,
            returnsCount: unbilled.returnsCount,
            total: unbilled.total,
            laborAmount: unbilled.laborAmount,
            billsBilled: unbilled.billsBilled,
            stockBilled: unbilled.stockBilled,
          }
        : null,
    lumpToNet,
    depositPercent: getOrgSettings((org as any)?.settings).deposit_percent,
    // Pieces taken past the stock: said BEFORE a bill is built (the sheet says it above Save).
    stockShortsWords,
    salesTax: on("sales_tax"),
  };
  const jobRefunds = (refundRows ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
  const revenue = Math.max(0, collected - jobRefunds);
  // Profit excludes mileage on PURPOSE so this hub and /analytics show the SAME number
  // for the same job: mileage is a per-entry value (a split shift keeps its miles whole on one
  // piece, never apportioned across jobs), and /analytics doesn't carry it. Mileage
  // is surfaced below as MILES ONLY — no app-computed dollars (mileage pay is a human-typed
  // settlement on /payroll, never rate×miles). If mileage dollars are ever folded back in,
  // they must be added to BOTH surfaces.
  //
  // PETTY CASH TOO: /analytics and Nort (computeJobProfitRows) have subtracted the job's petty cash
  // since audit v800, and this hub did not, so the three disagreed on the same job. Now all three
  // are collected − all labour − materials − bills − petty cash. ALL labour, not crew labour:
  // laborCostForJob costs the owner's own on-site hours too (0373), and the subtraction below takes the
  // whole of it, so a formula naming only the crew is short by his build time.
  const pettyCost = ((pettyRows ?? []) as any[])
    .filter((pc: any) => pc?.kind !== "replenish")
    .reduce((s: number, pc: any) => s + (Number(pc?.amount) || 0), 0);
  const profit = revenue - laborCost - materialCost - billsCost - pettyCost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  // What the job left the owner for each hour he put into it. Only when both halves are real: no
  // owner hours means no such rate, and nothing collected yet means the job has not paid anything.
  const perOwnerHour = ownerHours > 0 && revenue > 0 ? profit / ownerHours : null;

  // ONE signing call for the whole tab, not one per document (2026-09-08 phone-lag sweep).
  // Organize notes filed to a job are documents rows with NO file (file_url null); the helper
  // skips them rather than sending a null path, which storage-js rethrows as a TypeError and
  // used to crash the whole RSC render.
  //
  // A TECH IS HANDED NO COST PAPER (audit v994, HB-2): chosen from an allow-list before anything
  // is signed, so a receipt's picture, its signed URL and its name never reach a tech's page data.
  const visibleDocRows = documentsForViewer((docRows ?? []) as any[], viewerIsStaff);
  // The task photos ride the same one signing call (a task photo is almost always one of these
  // job photos already; a walk-through photo is not, and gets signed here too). Never a paper the
  // allow-list above kept from this viewer: a task pointing at one gets no URL (HB-2 holds).
  const keptFromViewer = new Set(
    ((docRows ?? []) as any[]).map((d: any) => d.file_url).filter((p: string | null) => p && !visibleDocRows.some((v: any) => v.file_url === p)),
  );
  const taskPhotoPaths = jobTasks.rows
    .flatMap((t) => [t.photo_path, t.done_photo_path])
    .filter((p): p is string => !!p && !keptFromViewer.has(p));
  // JOB PHOTOS, NOT BILLS (Erik, 2026-09-27; lib/job-photos). The links say which paper made which
  // bill. A tech is handed none: his pictures sort by their category alone, the same set he saw
  // before, and he has no bills to carry a door. A lost read (null) claims nothing about any paper.
  const paperTies: PaperTie[] | null = !viewerIsStaff ? [] : tieErr ? null : ((tieRows ?? []) as PaperTie[]);
  if (viewerIsStaff && tieErr) reportError("jobs.[id].paperTies", tieErr, { jobId: id });
  // A bill's receipt that is not one of this job's documents rides the same one signing call.
  const offJobPapers = viewerIsStaff ? papersOffThisJob(paperTies, visibleDocRows, liveBillIds) : [];
  const docUrls = await signDocumentUrls(supabase, [
    ...visibleDocRows.map((d: any) => d.file_url),
    ...taskPhotoPaths,
    ...offJobPapers.map((t) => t.file_url),
  ]);
  const docs = visibleDocRows.map((d: any) => ({
    ...d,
    signedUrl: (d.file_url && docUrls.get(d.file_url)) || null,
  }));
  // The Photos tab's grid and fold, each bill's own paper, and the receipts on no bill.
  const paperSort = sortJobPapers(docs, paperTies, liveBillIds);
  const billById = new Map(((bills ?? []) as any[]).map((b: any) => [String(b.id), b]));
  const billWords = (billId: string) => {
    const b = billById.get(billId);
    return `the ${b?.supplier || "supplier"} bill${b?.bill_number ? ` #${b.bill_number}` : ""}`;
  };
  const papersByBill = billPapers(paperSort.byBill, offJobPapers, docUrls, (billId) => billById.get(billId)?.supplier || "Receipt");
  const billOfPaper: Record<string, string> = Object.fromEntries(
    Object.entries(paperSort.byBill).flatMap(([billId, ds]) => ds.map((d: any) => [String(d.id), billWords(billId)])),
  );
  // Each task's photo: the signed URL, or "removed" once the photo was deleted from the job, or
  // "unavailable" when it is still the job's but couldn't be signed just now (lib/job-tasks taskPhoto).
  const jobFiles = new Set(((docRows ?? []) as any[]).map((d: any) => d.file_url).filter(Boolean) as string[]);
  const taskPhotos: TaskPhotos = Object.fromEntries(
    jobTasks.rows
      .filter((t) => t.photo_path || t.done_photo_path)
      .map((t) => [t.id, { task: taskPhoto(t.photo_path, docUrls, jobFiles), done: taskPhoto(t.done_photo_path, docUrls, jobFiles) }]),
  );
  // THE JOB'S MATERIALS LIST AS A CHECKLIST (Erik, 2026-09-27): the Materials chip counts only what's
  // still to buy, and the same open lines are ONE live task on the job's Tasks ("Buy Materials · N
  // Open"), read from the list, never copied into the tasks table. Both from lib/materials-checklist,
  // so the chip, the row and the list can't disagree.
  const buy = buyMaterials((canonicalItems ?? []) as { purchased?: boolean; is_tool?: boolean }[]);
  const materialsOpen = openToBuyCount((canonicalItems ?? []) as { purchased?: boolean; is_tool?: boolean }[]);
  // A tasks read that failed has no count at all (the card says it couldn't read them), never the
  // Buy Materials row alone passed off as the job's open tasks.
  const openTaskCount = jobTasks.failed ? undefined : jobTaskTally(jobTasks.rows, buy).open;
  // The Costs chip: Not Billed Yet rows + unrecorded papers naming this job + the job's own receipts
  // on no bill yet. Every one is a ROW the tab draws, so the number can be checked against the tab
  // (fada712a: J-013 had 1 bill and said 3). The hours not billed yet are NOT a count here: they are
  // said in words on the tab ("Also not billed yet: Xh of time") beside the door that bills them, and
  // a "1" that is no row could never be found. The loose receipts are the Receipts & Papers fold's own
  // "N Not On A Bill Yet" (the same paperSort.loose it is handed below); they are the job's documents,
  // never supplier_invoices, so they can't double a paperView.
  // J-013 (0b742620, 2026-09-29): one live bill, no papers, and the chip said 3. The chip counts only
  // the pile ids the tab draws (a bill, an order, a take from stock — lib/job-cost-groups
  // openRowsDrawn); an id nothing on the tab stands behind is reported, never counted.
  const openDrawn = costGroups
    ? openRowsDrawn(costGroups, [...((bills ?? []) as any[]).map((b) => String(b.id)), ...((pos ?? []) as any[]).map((p) => String(p.id))])
    : { drawn: [], phantom: [] };
  if (openDrawn.phantom.length > 0) {
    reportError("jobs.[id].costsChip", new Error("Not Billed Yet holds ids no row on the Costs tab draws"), {
      jobId: id,
      phantom: openDrawn.phantom.join(","),
      billed: String(((bills ?? []) as any[]).length),
    });
  }
  const costsOpen =
    openDrawn.drawn.length +
    (paperViews ?? []).filter((p) => !p.waitingOnCredit).length +
    (viewerIsStaff && paperSort.loose ? paperSort.loose.length : 0);
  const taskListProps = {
    materials: buy,
    jobId: j.id as string,
    orgId: j.org_id as string,
    tasks: jobTasks.rows,
    photos: taskPhotos,
    viewerId: user?.id ?? null,
    viewerIsStaff,
    tz,
    nowIso: new Date().toISOString(),
    stamps: jobTasks.stamps,
    failed: jobTasks.failed,
  };

  // WHICH PHOTOS THE CUSTOMER SEES (0300's job_shared_photos): the office's own table, read only
  // for the office (a tech's Photos tab has no Show Customer control, and RLS would give it no rows
  // anyway). null = the table isn't on this database yet, so the control stays hidden rather than
  // offering a switch that can only fail.
  //
  // 0326: the same rows now hold every paper shown (plans, circuit maps, drawings too), with a soft
  // remove. `portalPapers` tells the Costs tab's document list which papers are up, so each row can
  // say "On The Portal" or offer Show On Portal (null before 0326: no control).
  // staleSharedIds: of the photos shown, the ones whose file changed after they were shown, which
  // the customer's page has quietly stopped showing (audit v994 PL4, 0323); the tile says so.
  let sharedPhotoIds: string[] | null = null;
  let portalPapers: Record<string, "shown" | "replaced"> | null = null;
  let staleSharedIds: string[] = [];
  // Does the Customer Page tab hold anything: a paper shown, a stretch or a pick, live. Only read
  // where the tab is the office's and switched on; a failed read counts as holding.
  let customerPageHolds = true;
  // Customer Portal off (the switch board): no Show Customer / Show On Portal, so no read for them.
  if (viewerIsStaff && on("customer_portal")) {
    const liveCount = (table: "job_stretches" | "job_picks") =>
      supabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("job_id", id)
        .is("removed_at", null)
        .then(
          (r: { count: number | null; error: unknown }) => (r.error ? null : (r.count ?? 0)),
          () => null,
        );
    const [{ data: shared, error: sharedErr }, stale, stretchCount, pickCount] = await Promise.all([
      supabase.from("job_shared_documents").select("document_id, replaces_document_id").eq("job_id", id).is("removed_at", null),
      staleSharedPhotoIds(supabase, id),
      liveCount("job_stretches"),
      liveCount("job_picks"),
    ]);
    customerPageHolds = !!sharedErr || stretchCount === null || pickCount === null || (shared ?? []).length + stretchCount + pickCount > 0;
    if (!sharedErr) {
      const live = (shared ?? []) as { document_id: string; replaces_document_id: string | null }[];
      const replaced = new Set(live.map((r) => r.replaces_document_id).filter(Boolean));
      // What the customer actually sees: a paper a newer one replaces is not on their page.
      const shownIds = live.map((r) => r.document_id).filter((d) => !replaced.has(d));
      sharedPhotoIds = shownIds;
      portalPapers = Object.fromEntries(live.map((r) => [r.document_id, replaced.has(r.document_id) ? "replaced" : "shown"]));
      staleSharedIds = stale.filter((d) => shownIds.includes(d));
    }
  }

  const empty = (label: string) => (
    <p className="px-1 py-6 text-center text-sm text-slate-400">No {label} yet.</p>
  );

  // THE FIRST PIECE OF A SPLIT SAYS SO TOO. It keeps the shift's id and carries no split_from or
  // split_how of its own (its children point at it), so on this page it read as an unexplained short
  // day. One read: which of these entries have pieces cut from them, and whether any was rebuilt
  // from an old split by 0289. The pieces may sit on other jobs, which is exactly why this is asked.
  const entryIds = ((entries ?? []) as { id: string }[]).map((e) => e.id);
  const splitParents = new Map<string, { converted: boolean }>();
  if (entryIds.length) {
    const { data: kids } = await supabase
      .from("time_entries")
      .select("split_from, split_how")
      .in("split_from", entryIds);
    for (const k of (kids ?? []) as { split_from: string | null; split_how: string | null }[]) {
      if (!k.split_from) continue;
      const cur = splitParents.get(k.split_from) ?? { converted: false };
      splitParents.set(k.split_from, { converted: cur.converted || k.split_how === "converted" });
    }
  }

  // The punches with no job near this job, started above beside the other reads.
  const nearPunches = await nearPunchesP;

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
    /** 0288: the first entry of the shift this piece was cut from, and how it was cut. */
    split_from?: string | null;
    split_how?: string | null;
    rate_override?: number | null;
    // The payroll locks aren't pay data — they drive the edit modal's
    // "paid period" banner, which every role should see before a blocked save.
    paid_at?: string | null;
    mileage_paid_at?: string | null;
    /** 0168: where the time came from; the office's editor says it in words (sourceLine). */
    source?: string | null;
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
        split_from: e.split_from ?? null,
        split_how: e.split_how ?? null,
        paid_at: e.paid_at ?? null,
        mileage_paid_at: e.mileage_paid_at ?? null,
      }));

  const tabs = [
    {
      id: "job",
      label: "Overview",
      content: (
        <div className="space-y-4">
          {/* ONE FIGURE AND ONE BUTTON LEAD (W1-19). A job billed by its WORK (every Time & Material
              job, and for the office a fixed-price job with no live estimate: importsActuals, New
              Invoice's own rule) leads with the running total (Erik: "a running total of open time
              and materials on the overview"): "Open $X" and the door that bills it. A job billed by
              its CONTRACT (a live fixed-price estimate, or any payment schedule) leads with Left To
              Bill and the job's own New Invoice or Request Next Payment. Both are money, so the
              office's only; a tech's card is hours only on a job that bills its actuals (unbilledView
              is projected above) and nothing on one billed by its contract. */}
          {viewerIsStaff ? (
            importsActuals ? (
              <UnbilledCard jobId={j.id} customerId={j.customer_id ?? null} view={unbilledView} viewerIsStaff={viewerIsStaff} openDraft={openDraft} lumpToNet={lumpToNet} drawBilled={isDrawBilled} />
            ) : (
              <LeftToBillCard
                jobId={j.id}
                view={leftView}
                estimates={contractEstimates((quotes ?? []) as any[])}
                sent={((invoices ?? []) as any[])
                  .filter((i) => i.status !== "void" && i.status !== "draft")
                  .map((i) => ({ id: String(i.id), number: i.invoice_number ?? null, total: Number(i.total) || 0 }))}
                draft={draftInvoice ? { id: String(draftInvoice.id), number: draftInvoice.invoice_number ?? null, total: Number(draftInvoice.total) || 0 } : null}
                rows={(scheduleView?.rows ?? []).map((r) => ({
                  label: r.label,
                  percent: r.percent ?? null,
                  dollars: r.dollars,
                  billed: r.billed,
                  next: scheduleView?.next?.index === r.index,
                }))}
                isTm={(j as any).billing_type === "tm"}
                openDraft={openDraft ? { id: openDraft.id, number: openDraft.number, refreshable: openDraft.refreshable } : null}
                newInvoice={newInvoiceProps}
              />
            )
          ) : (
            billsActuals && (
              <UnbilledCard jobId={j.id} customerId={j.customer_id ?? null} view={unbilledView} viewerIsStaff={viewerIsStaff} openDraft={openDraft} lumpToNet={lumpToNet} drawBilled={isDrawBilled} />
            )
          )}
          {/* THE JOB'S TASKS, WHOLE, RIGHT HERE (Erik, report b7f23be0: "show the tasks here,
              additional steps are unnecessary"). "Tasks: 7 of 12 done", every open task, the Add
              line and the Done fold — the same list the Tasks chip opens, not a three-row summary
              of it with a "+2 more" line. The same card for the crew (no prices on a task). */}
          <JobTaskList {...taskListProps} />
          <Card>
            <CardContent className="space-y-4 py-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Customer</div>
                  <div className="mt-1 flex items-center gap-2">
                    {j.customers ? (
                      <>
                        {/* The customer's door (it left Manage, W1-17): a 44px link, like every tap target. */}
                        <Link href={`/crm/${j.customers.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-slate-900 hover:text-brand">
                          {j.customers.name}
                        </Link>
                        {/* Editing the customer is a staff write; a tech gets the name and the phone. */}
                        {viewerIsStaff && <EditCustomerButton customer={j.customers as Customer} />}
                      </>
                    ) : (
                      <span className="text-sm text-slate-400">—</span>
                    )}
                  </div>
                  {/* A LIGHTER INFO CARD (W1-19): the number, read, not a second call button. The
                      dock's Call is the one door that dials it. */}
                  {j.customers?.phone && <div className="mt-0.5 text-xs text-slate-500">{j.customers.phone}</div>}
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Address</div>
                  {/* One plain line (W1-19): "123 Main · Truckee, CA 96161". The dock's Navigate is
                      the one door that drives there. */}
                  <div className="mt-1 text-sm text-slate-700">
                    {j.address
                      ? [[j.address, unitLine(j.unit)].filter(Boolean).join(", "), formatCityStateZip(j.city, j.state, j.zip)].filter(Boolean).join(" · ")
                      : "—"}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Scheduled</div>
                  <div className="mt-1">
                    {viewerIsStaff ? (
                      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                        <JobScheduleControl
                          id={j.id}
                          segments={scheduleDays}
                          ownDays={ownDays.map((o) => o.words)}
                          block={block}
                          workDay={workDay}
                          plannedMinutes={j.planned_minutes ?? null}
                        />
                        {/* OFFER DATES, beside the dates it fills (W1-17: out of Manage, not cut). Only
                            while the job can still be scheduled. */}
                        {schedulable && (
                          <ProposeDatesButton
                            jobId={j.id}
                            customerPhone={j.customers?.phone ?? null}
                            pending={(pendingProposal as any) ?? null}
                            dayStart={workDay.start}
                          />
                        )}
                      </div>
                    ) : (
                      <span className={scheduleText ? "text-sm text-slate-700" : "text-sm text-slate-400"}>
                        {scheduleText ?? "Not scheduled yet."}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {/* TWO BOXES, NEVER ONE (W1-21, Erik's answer): the Description is the scope and prints on
                  the customer's invoice; the Notes are the company's own (gate codes, access) and never
                  reach a customer's paper. Each its own column, each saying which it is. A tech reads
                  both (the Notes only when there are some) and is pointed at the Materials tab once —
                  Brian typed a materials note into the Description, which only staff can save. */}
              <JobTextBox jobId={j.id} field="description" value={j.description ?? null} viewerIsStaff={viewerIsStaff} />
              <JobTextBox jobId={j.id} field="notes" value={(j as any).notes ?? null} viewerIsStaff={viewerIsStaff} />
            </CardContent>
          </Card>

          {/* THE CREW (W1-22): the office puts people on and takes them off right here (setJobCrew,
              the one crew writer, which rings the bell for someone new); the crew reads the chips. */}
          <JobCrewCard
            jobId={j.id}
            crew={((j.assigned_to ?? []) as string[])
              .map((pid) => ((staff ?? []) as any[]).find((s) => s.id === pid))
              .filter(Boolean)
              .map((s: any) => ({ id: String(s.id), full_name: s.full_name ?? null }))}
            team={
              viewerIsStaff
                ? ((techs ?? []) as any[]).filter((t) => t.active !== false).map((t) => ({ id: String(t.id), full_name: t.full_name ?? null }))
                : []
            }
            viewerIsStaff={viewerIsStaff}
          />

          {/* SUBS & CONTACTS: the list is job information a tech needs (who the sub is, the
              inspector's number); linking and unlinking are staff writes (job_contacts). The
              office gets the editor, the crew gets the same rows with tap-to-call. The whole
              customer book (allCustomers) is read for staff only, so neither contactOptions here
              nor the dock's Edit Job modal ever serializes it to a tech's page — this comment
              used to make that promise while the dock still handed the book to every viewer. */}
          {viewerIsStaff ? (
            <JobContacts jobId={j.id} contacts={jobContacts} options={contactOptions} />
          ) : (
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
                <HardHat className="h-4 w-4 text-slate-400" /> Subs &amp; contacts
              </div>
              {jobContacts.length === 0 ? (
                <p className="py-3 text-center text-xs text-slate-400">No subs or extra contacts on this job.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {jobContacts.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm">
                      <Link href={`/crm/${c.customer_id}`} className="font-medium text-slate-800 hover:text-brand">
                        {c.name}
                      </Link>
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {c.role}
                      </span>
                      {c.phone && (
                        <a href={`tel:${c.phone}`} className="flex min-h-[44px] items-center gap-1 text-slate-600 hover:text-brand">
                          <Phone className="h-3.5 w-3.5 text-slate-400" /> {c.phone}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
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
      // THE ONE TOTAL BADGE (Erik, 2026-09-27, minutes after "all badges only show whats open":
      // "keep the badge for total job photos"). Every other chip counts only what's open; Photos
      // keeps how many job-site photos the job has (tests/badges-show-open names the exception):
      // the grid only, never the Plans & Other Papers fold under it, a receipt or a bill.
      id: "photos",
      // Holds a job-site photo or a plan (office only: for the crew Photos is a pinned chip).
      holds: !!docsErr || paperSort.photos.length > 0 || paperSort.pictures.length > 0,
      label: "Photos",
      count: paperSort.photos.length,
      content: (
        <Card>
          <CardContent className="py-5">
            <JobPhotos
              orgId={j.org_id}
              jobId={j.id}
              docs={paperSort.photos}
              pictures={paperSort.pictures}
              costsNote={viewerIsStaff && paperSort.moneyPictures > 0}
              sharedIds={sharedPhotoIds}
              staleIds={staleSharedIds}
              viewerId={user?.id ?? null}
              viewerIsStaff={viewerIsStaff}
            />
          </CardContent>
        </Card>
      ),
    },
    // WHAT THE CUSTOMER SEES ON THIS JOB (office only): the link to their page, the stretches of
    // work, the picks. Live, so it loads when the tab opens rather than on every hub load.
    // Customer Portal off: the tab has no chip and opens from a link under the Off line
    // (arrangeJobTabs); inside it, the doors out to the customer's page aren't drawn.
    ...(viewerIsStaff
      ? [
          {
            id: "customer",
            holds: customerPageHolds,
            label: "Customer Page",
            content: <JobCustomerPage jobId={j.id} orgId={j.org_id} customerName={j.customers?.name ?? null} portalOn={on("customer_portal")} />,
          },
        ]
      : []),
    // THE TASKS CHIP (Erik, 2026-09-26: "put it on the bottom bar next to overview"): pinned right
    // after Overview for the office and the crew, its count the open tasks. The Overview draws the
    // same whole list (b7f23be0), so this tab is the one-tap door from the job's OTHER tabs and the
    // place a task's own link lands (/tasks rows, My Day, a bell: lib/task-href) — never a view that
    // holds a row the Overview hides. To-Do Extras doesn't reach it (a job's list has no priority or
    // subtasks); that switch is the Reminders' now.
    {
      id: "tasks",
      label: "Tasks",
      count: openTaskCount,
      content: <JobTaskList {...taskListProps} />,
    },
    {
      id: "permits",
      holds: !!permitsErr || (permits ?? []).length > 0,
      label: "Permits",
      // Permits still in motion (not passed, not closed): a failed inspection counts most of all.
      count: countOpen((permits ?? []) as { status?: string | null }[], (p) => isOpenPermit(p.status)),
      content: (
        <Card>
          <CardContent className="py-5">
            {/* PERMITS: a tech needs the permit number, the inspection date and the city's
                portal link on site; adding, editing and deleting are staff writes, and the
                fee is a money figure. Same rows, read-only, fee omitted. */}
            {viewerIsStaff ? (
              <JobPermits jobId={j.id} permits={(permits ?? []) as any} canAdd={on("permits")} />
            ) : (
              <div>
                <div className="mb-3 text-sm text-slate-500">
                  {(permits ?? []).length} permit{(permits ?? []).length === 1 ? "" : "s"}
                </div>
                {(permits ?? []).length === 0 ? (
                  <p className="py-4 text-center text-sm text-slate-400">No permits on this job yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {(permits ?? []).map((p: any) => (
                      <li key={p.id} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex items-start gap-3">
                          <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                              <span className="font-medium text-slate-900">{p.type}</span>
                              {p.permit_number && <span className="font-mono text-xs text-slate-500">#{p.permit_number}</span>}
                              {p.authority && <span className="text-xs text-slate-400">· {p.authority}</span>}
                              {p.portal_url && (
                                <a
                                  href={p.portal_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100"
                                >
                                  Check with City ↗
                                </a>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                              {p.applied_date && <span>Applied {formatDate(p.applied_date)}</span>}
                              {p.inspection_date && <span>Inspection {formatDate(p.inspection_date)}</span>}
                              {p.inspector && <span>· {p.inspector}</span>}
                            </div>
                            {p.notes && <div className="mt-1 whitespace-pre-wrap text-xs text-slate-500">{p.notes}</div>}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <Badge tone={permitStatusTone(p.status)}>{String(p.status).replace("_", " ")}</Badge>
                            <Badge tone={permitResultTone(p.inspection_result)}>{p.inspection_result}</Badge>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ),
    },
    {
      // THE PANEL (Panel plan, phase 2): the job's own circuit list, loaded when the tab opens.
      id: "panel",
      holds: panelHolds,
      label: "Panel",
      // Suggested circuits waiting on a Keep or a Not This (the read above), never the kept ones.
      count: panelCount,
      content: <JobPanelLoader jobId={j.id} />,
    },
    {
      id: "time",
      label: "Time",
      // No badge: the number of shifts on a job is a total. The time not billed yet is said on the
      // Overview's running total and the Costs tab, where the door that bills it is.
      content: (
        <Card className="overflow-hidden">
          {/* ONE CLOCK ON A JOB (W1-20). The tab's own Clock In left: the dock's TIME button at the top
              of the job is the one clock (GPS, Switch, backdating, the long-shift guard, the on-hold
              toast), always there whatever tab is open. What stays on this line is the total and the
              office's Add Time Entry. THE ROW STILL WRAPS (Erik, from the phone: "can't see the bottom
              of the list", Add Time Entry sheared off at 402px): every Button is whitespace-nowrap, so
              flex-wrap lets the button drop to its own line instead of off the card's overflow-hidden
              edge; nothing here is allowed to be a half-visible tap target. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-100 px-5 py-3 text-sm">
            <span className="font-semibold text-slate-900">Time on this job · {formatDuration(laborHours)}</span>
            <div className="flex flex-wrap items-center gap-2">
              {/* The office's one add-hours form (timecards/add-time-entry), with this job said, not
                  picked. Its Day starts on the company's today; miles, rate and notes are on the
                  shift's editor, one tap from the toast after a save. */}
              {viewerIsStaff && (
                <AddTimeEntry
                  isStaff={viewerIsStaff}
                  fixedJob={{ id: j.id, label: jobLabel(j) }}
                  members={((techs ?? []) as any[]).filter((t) => t.active !== false).map((t) => ({ id: String(t.id), full_name: t.full_name ?? null }))}
                  jobs={[]}
                  jobCodes={(jobCodes ?? []) as any}
                  jobCodesEnabled={jobCodesEnabled}
                  tz={tz}
                  viewerId={user?.id}
                  companyTimeCode={null}
                  workDayEnd={workDay.end}
                />
              )}
            </div>
          </div>
          {/* Its crew's punches on no job around its days, each one tap onto this job: the hours
              the office would otherwise type again (office only; nothing to show, nothing shown). */}
          {viewerIsStaff && (
            <NoJobPunches
              jobId={j.id}
              jobLabel={jobLabel(j)}
              tz={tz}
              punches={nearPunches?.punches ?? []}
              capped={!!nearPunches?.capped}
              failed={nearPunches === null}
            />
          )}
          <ul className="divide-y divide-slate-100">
            {timeTabEntries.map((e) => {
              const h = e.status === "closed" && e.clock_out
                ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : null;
              return (
                <li key={e.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div>
                    <span className="text-slate-700">{formatDateTz(e.clock_in, tz)}</span>
                    <span className="ml-2 text-slate-500">{e.profiles?.full_name ?? "—"}</span>
                    {e.job_code && <Badge tone="slate" className="ml-2">{e.job_code}</Badge>}
                    {/* A piece of a split shift says so: the rest of that shift is on another job's
                        page, and a row that looks like a short day with no reason is a question. */}
                    {e.split_how === "converted" || splitParents.get(e.id)?.converted ? (
                      <Badge tone="blue" className="ml-2">Rebuilt From An Old Split</Badge>
                    ) : e.split_from || splitParents.has(e.id) ? (
                      <Badge tone="blue" className="ml-2">part of a split shift</Badge>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-slate-800">
                      {h != null
                        ? formatDuration(h)
                        : !e.clock_out
                          ? /* A running clock says since when, with the day when it began on an
                               earlier one; the office's Clock Out <Name> sits right beside it. */
                            `On The Clock Since ${
                              todayStrInTz(tz, new Date(e.clock_in)) === todayStrInTz(tz)
                                ? formatTime(e.clock_in, tz)
                                : `${new Date(e.clock_in).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" })}, ${formatTime(e.clock_in, tz)}`
                            }`
                          : "open"}
                    </span>
                    <EditEntryButton
                      entry={e}
                      jobCodes={(jobCodes ?? []) as any}
                      jobs={allJobs ?? []}
                      members={(techs ?? []) as any}
                      isStaff={viewerIsStaff}
                      jobCodesEnabled={jobCodesEnabled}
                      tz={tz}
                      rebuiltFromOldSplit={!!splitParents.get(e.id)?.converted}
                      workDayEnd={workDay.end}
                      viewerId={user?.id}
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
      // Any visit, past or ahead (a tech holds only the visits that are his: RLS).
      holds: !!jobApptsErr || (jobAppts ?? []).length > 0,
      label: "Appointments",
      // Visits still ahead (booked, or proposed and waiting on the customer), never past ones.
      count: countOpen((jobAppts ?? []) as { status?: string | null }[], (a) => isOpenAppointment(a.status)),
      content: (
        <div className="space-y-3">
          {/* Booking and editing are staff writes (appointments_write, 0227: "office only"), so
              both doors are staff-only here. The visits themselves stay — a tech needs to know
              when the inspector is coming. */}
          {viewerIsStaff && (
            <div className="flex justify-end">
              {/* Defaults matter: booked from the Miller job, it must land ON the Miller job. Without
                  these the component opened blank and the appointment was never linked back. */}
              <AppointmentButton jobs={apptJobOpts} customers={apptCustOpts} staff={apptStaffOpts} defaultJobId={job.id} defaultCustomerId={job.customer_id ?? undefined} />
            </div>
          )}
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
                      {/* A visit waiting for a day (0368) sorts last (ascending: nulls last) and says so. */}
                      <span className="text-slate-500">{a.starts_at ? formatDateTime(a.starts_at) : "Waiting For A Day"}</span>
                      {viewerIsStaff && <AppointmentButton jobs={apptJobOpts} customers={apptCustOpts} staff={apptStaffOpts} appointment={appt} />}
                    </div>
                  </li>
                );
              })}
              {/* 0227: a tech sees only the visits assigned to him, so "No appointments yet"
                  would be a claim about the job — the empty state says what HIS view holds. */}
              {(!jobAppts || jobAppts.length === 0) &&
                (viewerIsStaff ? (
                  empty("appointments")
                ) : (
                  <p className="px-1 py-6 text-center text-sm text-slate-400">None assigned to you yet.</p>
                ))}
            </ul>
          </Card>
        </div>
      ),
    },
    {
      id: "costs",
      label: "Costs",
      // WHAT'S OPEN ON THE COSTS TAB, never how many bills the job has (Erik, 2026-09-27: "all badges
      // only show whats open"): the Not Billed Yet pile (the Unbilled card's own verdict, so the chip
      // is the pile the tab leads with) plus the supplier papers naming this job that are in nobody's
      // books yet (Named On A Paper; one set aside waiting on a credit is decided, so not counted),
      // plus the job's own receipts on no bill yet (Receipts & Papers' "Not On A Bill Yet"). Every
      // one is a row on the tab; the hours not billed yet are said in words beside their door, never
      // a made-up 1. A fixed-price job has no Not Billed Yet pile, so only its unrecorded papers and
      // loose receipts count.
      count: costsOpen,
      content: (
        <div className="space-y-4">
          {/* THE ADD COST DOOR, camera first, at the top of the tab where the dock's Add Cost
              used to be a slot away (Erik: "combine costs with add cost on that upper button
              and get rid of it below… make it able to take a photo of a bill"). Snap the Bill
              runs the receipt reader per photo and the Supplier bills list below refreshes. */}
          <JobCostCapture orgId={j.org_id} jobId={j.id} billsTotal={billsCost} nortOn={on("nort")} />
          {/* OPEN FIRST (Erik, 2026-09-25: "in costs i need to know what is open more than i need
              to know all the totals because i think theres a bill missing from this but i cant
              even tell as they are all mixed together"). The bills lead: Not Billed Yet with the
              Overview card's own door, then Billed folded by invoice, then the supplier's papers
              that name this job and are in nobody's books. The totals follow. */}
          <Card>
            {!costGroups && (
              <div className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-slate-900">Supplier bills</div>
            )}
            <CardContent className="py-5">
              <JobBills
                jobId={j.id}
                bills={costBills as any}
                settledSaysUnread={settledSays.unread}
                pos={(pos ?? []) as any}
                groups={costGroups}
                groupsNote={costGroupsNote}
                alreadyBilled={alreadyBilledDoors}
                billedHours={hoursMarked}
                handsNote={handsNote}
                papers={papersByBill}
                openAside={
                  costGroups && unbilled ? (
                    <div className="space-y-2">
                      <UnbilledDoorButton jobId={j.id} work={unbilled} openDraft={openDraft} lumpToNet={lumpToNet} drawBilled={isDrawBilled} />
                      {/* What else the button bills, said, so its figure never reads as a typo
                          beside the bills' cost: the open time, and the markup on the bills. */}
                      {(unbilled.hours > 0 || ((unbilled.billsCount > 0 || unbilled.stockCount > 0) && unbilled.markupPct > 0)) && (
                        <p className="text-sm text-slate-500">
                          {[
                            unbilled.hours > 0
                              ? `Also not billed yet: ${formatDuration(unbilled.hours)} of time, ${formatCurrency(unbilled.laborAmount)}.`
                              : null,
                            (unbilled.billsCount > 0 || unbilled.stockCount > 0) && unbilled.markupPct > 0
                              ? `${unbilled.billsCount > 0 && unbilled.stockCount > 0 ? "Bills and pieces from stock go" : unbilled.stockCount > 0 ? "Pieces from stock go" : "Bills go"} on the invoice at +${unbilled.markupPct}%.`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        </p>
                      )}
                      {/* The open hours were charged by hand on a bill that went out: pick the line,
                          then the shifts (0357). Only when a sent bill could hold them. */}
                      {unbilled.hours > 0 && alreadyBilledCan.charge && (
                        <AlreadyBilledButton jobId={j.id} target={{ kind: "time", ids: [], what: "Those hours" }} label="Already Billed: The Hours" />
                      )}
                      {/* Pieces taken past the shelf with no roll behind them: not in the pile and
                          not on the next bill until settled. Said here too, never silent. */}
                      {unbilled.stockShortsWords && <p className="text-sm text-amber-700">{unbilled.stockShortsWords}</p>}
                    </div>
                  ) : null
                }
              />
            </CardContent>
          </Card>
          <JobPaperList jobId={j.id} papers={paperViews} />
          {/* RECEIPTS & PAPERS, right under the bills (Erik, 2026-09-27: bills and job photos kept
              separate). The job's filing cabinet, folded: every paper that isn't on the Photos tab,
              each saying which bill it made, and a receipt on no bill says so and holds the fold
              open. Receipt pictures left the Photos grid for their bills; this is where any a bill
              doesn't hold still show. Record As Cost is the retry, as before. The plans door points
              at the Customer Page tab: Customer Portal's (the switch board). */}
          <Card>
            <JobDocuments
              orgId={j.org_id}
              jobId={j.id}
              docs={docs}
              portalPapers={portalPapers}
              plansDoor={viewerIsStaff && on("customer_portal")}
              nortOn={on("nort")}
              photoTabIds={Array.from(paperSort.photoTabIds)}
              billOf={billOfPaper}
              looseIds={paperSort.loose ? paperSort.loose.map((d: any) => String(d.id)) : null}
              tieNote={paperTies ? null : "Couldn't check which papers made which bill just now. Reload to try again."}
              // A loose receipt's Already On A Bill → Tie It (d1ff7c5a): the job's live bills, said
              // the way the rows say them ("the CED bill #8802-…"). The office only.
              bills={viewerIsStaff ? liveBillIds.map((id) => ({ id, label: billWords(id) })) : null}
            />
          </Card>
          {/* THE ORDERS, ONLY WHEN THERE ARE SOME (W1-23): a job with no purchase order draws no
              empty card (New PO stays on the Materials tab, off the job's one list). With the
              switch off, a job that has POs keeps listing them under the Off line. They count in
              cost either way. */}
          {(pos ?? []).length > 0 && (
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                <span className="text-sm font-semibold text-slate-900">Material purchase orders</span>
                {on("purchase_orders") && <NewPoButton jobs={thisJobOpt} lists={lists ?? []} defaultJobId={j.id} />}
              </div>
              <FeatureOffLine feature="purchase_orders" features={switches.features} isOwner={switches.isOwner} className="mx-5 mt-3" />
              <ul className="divide-y divide-slate-100">
                {(pos ?? []).map((p: any) => (
                  <li key={p.id}>
                    <Link href={`/purchasing/${p.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
                      <span>{p.po_number} · {p.vendor || "No vendor"}</span>
                      <span className="text-slate-700">{formatCurrency(p.total)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {/* PROFIT IN ONE LINE (W1-23), last, so what's open leads the tab. The figures are the
              ones this page always worked out (collected − all labour − live orders − bills − petty
              cash, the same as /analytics); the rows wait in its Why? fold. ALL labour: the owner's own
              build time is in it too (0373), which is why this no longer says crew labour. */}
          <ProfitLine
            collected={revenue}
            crewLabor={crewLabor}
            crewHours={crewHours}
            ownerHours={ownerHours}
            ownerCost={ownerCost}
            uncostedOwnerHours={uncostedOwnerHours}
            ownerHoursLabel={ownerVoice.hoursLabel}
            ownerWho={ownerVoice.viewerIsOwner ? "you" : ownerVoice.who}
            materialsAndBills={Math.round((materialCost + billsCost) * 100) / 100}
            shelfTouched={jobMaterials.shelfTouched}
            tickets={jobMaterials.tickets}
            fromStock={jobMaterials.fromStock}
            pettyCash={pettyCost}
            miles={totalMiles}
            profit={profit}
            margin={margin}
            perOwnerHour={perOwnerHour}
            perHourPhrase={ownerVoice.perHourPhrase}
          />
        </div>
      ),
    },
    {
      id: "materials",
      label: "Materials",
      // What's still to buy, never the list's size (Erik: "the badge should only show whats open to
      // be purchased"). 0 = no badge.
      count: materialsOpen,
      content: (
        <div className="space-y-3">
          {/* Hit Materials and THE list is right there (Erik, 7/14) — no
              list-of-lists, nothing to create or open. It is a checklist: what's
              left to buy on top, checked lines folded into Bought (N) inside the
              editor; the pick-list print and PO seed ride on top of the SAME list. */}
          {/* The pick-list print and the PO seed are office doors (a PO is money; the print
              carries est_cost) — staff only. */}
          {viewerIsStaff && canonicalList && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Link
                href={`/print/pdf-preview?doc=material-list&id=${canonicalList.id}&back=/jobs/${j.id}?tab=materials`}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <ListChecks className="h-4 w-4 shrink-0" /> Print Pick List
              </Link>
              {on("purchase_orders") && (
                <NewPoButton
                  jobs={thisJobOpt}
                  lists={[{ id: canonicalList.id, name: canonicalList.name }]}
                  defaultJobId={j.id}
                  defaultListId={canonicalList.id}
                />
              )}
            </div>
          )}
          {/* ONE LIST, THE SAME EDITOR FOR EVERYONE (Erik, 2026-09-11): "techs should have easy
              access to the same materials list per job (just one, the same one) and honestly we
              probably won't ever be putting prices in those lines anyway." So the crew gets the
              editor the office gets — add, edit, remove, tick purchased — and the SAME lazy
              ensureJobMaterialList on the first add when the job has no list yet (never a second
              list; the tab IS the list). What stays out of a tech's hands and eyes is the money:
              viewerIsStaff=false hides est_cost / vendor / is_tool / the total inside the editor,
              and a DB trigger pins those columns, so the UI is a convenience, not the boundary.
              This replaces the read-only <ul> a tech used to get. */}
          {/* TOOK FROM STOCK (Phase 3): one button, the same for the crew and the office, and under
              it who took what off the shelf for this job, with Undo until an invoice bills it. It
              counts on the job the moment it is tapped (Erik's decision 3). No price, for anyone. */}
          {/* Shop Stock off (the switch board): no Took From Stock button, but the takes already on
              this job stay listed with their Undo. */}
          <TookFromStock jobId={j.id} takes={takes.takes} viewerIsStaff={viewerIsStaff} readFailed={!!takes.error} canTake={on("shop_stock")} />
          <ItemEditor
            listId={canonicalList?.id ?? null}
            jobId={j.id}
            items={(canonicalItems ?? []) as any}
            viewerIsStaff={viewerIsStaff}
          />
          {/* BELOW the editor, for a tech: the "need it fast" door — a line on this list plus a
              bell + push to the boss's phone (requestMaterials), for the ask that can't wait
              ("I'm short for the far wall, can someone run it out?"). Never a second task: the
              live Buy Materials row on Tasks already counts the line. */}
          {!viewerIsStaff && <NeedMaterials jobId={j.id} />}
          {/* The list-of-lists is an office concern (which take-off is canonical); for the crew
              the tab IS the list, so the door stays staff-only. */}
          {viewerIsStaff && (jobLists ?? []).length > 1 && (
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
      holds: !!quotesErr || (quotes ?? []).length > 0,
      label: "Estimates",
      // Estimates still owed a move: a draft to send, or sent and waiting on the customer.
      count: countOpen((quotes ?? []) as { status?: string | null }[], (q) => isOpenQuote(q.status)),
      content: (
        <div className="space-y-3">
          {on("estimates") && (
            <div className="flex justify-end">
              <Link
                href={`/quotes/new?customer=${j.customer_id ?? ""}&job=${j.id}`}
                className="btn-gloss inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[rgb(var(--glass-ink))] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[rgb(var(--glass-ink))]/90"
              >
                <Plus className="h-4 w-4 shrink-0" /> New Estimate
              </Link>
            </div>
          )}
          <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(quotes ?? []).map((q: any) => (
              <li key={q.id}>
                <Link href={`/quotes/${q.id}`} className="flex items-center justify-between px-5 py-3 text-sm hover:bg-slate-50">
                  <span className="font-medium text-slate-900">
                    {q.quote_number}
                    {/* THE FIXED CHIP (W1-25): fixed-price rows only; Time & Material wears nothing. */}
                    {isFixedPrice(q) && <span className={FIXED_PILL_CLASS}>Fixed</span>}
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
      holds: !!invoicesErr || (invoices ?? []).length > 0,
      label: "Invoices",
      // Invoices still owed: a draft not sent, or sent with a balance. Paid and void never badge.
      count: countOpen((invoices ?? []) as any[], isOpenInvoice),
      content: (
        <div className="space-y-3">
          {/* Lead with the INVOICES (this is the Invoices tab) — the contract / payment
              schedule / lien cards live below, since they're supporting deal-to-cash context. */}
          {/* ONE NEW INVOICE (W1-24). The Progress Payment hub beside it is gone: its draw builder is
              the New Invoice sheet (Deposit / Part Of The Estimate / Bill The Work So Far), and its
              Record a Payment left this tab for each open bill's Get Paid below. Every prop is a fact
              this page already read; what one tap does is lib/actuals-draw newInvoiceRoute. Staff only
              (a tech never sees this tab, and never a price). */}
          {viewerIsStaff && (
            <div className="flex justify-end">
              {/* The page's facts, computed once (newInvoiceProps): the Overview's Left To Bill card
                  mounts the same button with the same props, opened on Part Of The Estimate. */}
              <NewInvoiceButton {...newInvoiceProps} />
            </div>
          )}
          <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {(invoices ?? []).map((iv: any) => (
              <li key={iv.id}>
                {/* The billing board's amount (components/invoice-amount): "$D due of $T" with what
                    is paid beneath. This row used to print the bare TOTAL, so a bill with $6,000
                    paid on it looked the same here as one with nothing paid, and a different size
                    than the same invoice on /billing. */}
                <Link href={`/billing/${iv.id}`} className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-slate-50">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-900">{iv.invoice_number}</span>
                    <InvoiceAmountDetail total={iv.total} paid={iv.amount_paid} status={iv.status} />
                  </span>
                  <span className="flex shrink-0 items-center gap-3"><InvoiceAmount total={iv.total} paid={iv.amount_paid} status={iv.status} /><Badge tone={statusTone(iv.status)}>{iv.status}</Badge></span>
                </Link>
                {/* GET PAID, ON THE BILL IT PAYS (W1-24). Record a Payment left this tab with the
                    Progress Payment hub: money is taken on its invoice, whose Get Paid is one sheet
                    (card first, then every other way). Its own line, so the row never squeezes. */}
                {iv.status !== "void" && invoiceBalance(iv.total, iv.amount_paid) > 0.005 && (
                  <div className="-mt-2 flex justify-end px-3 pb-1">
                    <Link href={`/billing/${iv.id}`} className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand hover:underline">
                      Get Paid
                    </Link>
                  </div>
                )}
              </li>
            ))}
            {(!invoices || invoices.length === 0) && empty("invoices")}
          </ul>
          </Card>
          {/* CONTRACTS & LIEN RIGHTS OFF (the switch board): the three cards below are its doors, so a
              job with none of them shows none. A job that has a schedule, a contract or a lien record
              keeps its card under the Off line: milestones bill draws, and a sent contract is live. */}
          {!on("contracts") && ((paymentMilestones ?? []).length > 0 || (contractRows ?? []).length > 0 || !!lienRecord || !!insuranceClaim) && (
            <FeatureOffLine feature="contracts" features={switches.features} isOwner={switches.isOwner} />
          )}
          {(on("contracts") || (paymentMilestones ?? []).length > 0) && (
            <PaymentScheduleCard
              jobId={j.id}
              billingType={(j as any).billing_type ?? "fixed"}
              contractTotal={contractTotal}
              depositPercent={getOrgSettings((org as any)?.settings).deposit_percent}
              milestones={(paymentMilestones as any) ?? []}
              // Without this the gate inside the card is dead code: it defaults to false meaning
              // "no draws", so Set Up Schedule kept being offered on a job whose draws have already
              // been billed, where the server can only refuse.
              drawsBilled={isDrawBilled}
            />
          )}
          {(on("contracts") || (contractRows ?? []).length > 0) && (
            <ContractCard jobId={j.id} contract={((contractRows as any) ?? [])[0] ?? null} />
          )}
          {(on("contracts") || !!lienRecord || !!insuranceClaim) && (
            <LienInsuranceCard
              jobId={j.id}
              lien={(lienRecord as any) ?? null}
              insurance={(insuranceClaim as any) ?? null}
              /* ONE LAW TWO CLOCKS (audit v921): the card ran its own `new Date()` in the BROWSER,
                 so after 5 PM Pacific it counted from the UTC day — a 20-day preliminary-notice
                 deadline read "past due" an evening early, and one day short of the Needs-action
                 feeder, which has always used the org's day. The org's today, from here. */
              today={todayStrInTz(tz)}
              defaults={{
                ownerName: (j.customers as any)?.name ?? undefined,
                ownerAddress: formatFullAddress((j.customers as any)?.address, (j.customers as any)?.city, (j.customers as any)?.state, (j.customers as any)?.zip) || undefined,
                // ACCEPTED-only, matching what the notice itself prints (audit 8): this prefilled
                // the sum of every quote, so a job with two unaccepted revisions handed staff a
                // doubled figure to serve on a legal notice, one Save away from being sworn to.
                estimatedAmount: acceptedQuoteTotal((quotes ?? []) as any),
              }}
            />
          )}
        </div>
      ),
    },
    {
      id: "change-orders",
      holds: !!changeOrdersErr || (changeOrders ?? []).length > 0,
      label: "Change Orders",
      // Change orders waiting on their answer (pending).
      count: countOpen((changeOrders ?? []) as { status?: string | null }[], (c) => isOpenChangeOrder(c.status)),
      content: (
        <div className="space-y-3">
          {on("estimates") && (
            <div className="flex justify-end">
              <NewChangeOrderButton jobs={thisJobOpt} />
            </div>
          )}
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
      holds: !!workOrdersErr || (workOrders ?? []).length > 0,
      label: "Work Orders",
      // Work orders still to do (not complete, not cancelled).
      count: countOpen((workOrders ?? []) as { status?: string | null }[], (w) => isOpenWorkOrder(w.status)),
      content: (
        <div className="space-y-3">
          {/* Issuing a work order is a staff write; the list of them is job information. */}
          {viewerIsStaff && on("estimates") && (
            <div className="flex justify-end">
              <NewWorkOrderButton jobs={thisJobOpt} techs={techs ?? []} defaultJob={j.id} autoOpen={false} />
            </div>
          )}
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
      {/* THE J-NUMBER ONCE (W1-17): here in the breadcrumb, and nowhere else in the header. The Jobs
          crumb is the All Jobs door (it left Manage). 44px crumbs, like every tap target. */}
      <div className="mb-2 flex items-center gap-1.5 text-sm text-slate-500">
        <Link href="/planner" aria-label="Home" className="inline-flex min-h-11 min-w-11 items-center justify-center hover:text-slate-800">
          <Home className="h-4 w-4" />
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
        <Link href="/jobs" className="inline-flex min-h-11 items-center px-1 hover:text-slate-800">Jobs</Link>
        <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
        <span className="font-medium text-slate-700">{j.job_number}</span>
      </div>

      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-900">{j.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
          {/* THE STATUS BADGE IS THE STATUS CONTROL (W1-17): the office taps it to change the status
              or put the job on hold (why, and the day it comes back); a held job says its reason and
              day here, with Snooze. The crew reads the same pill. The day (0366) is shown only when
              the database has the column (select * carries it then), never a guessed one. */}
          <JobStatusControl
            id={j.id}
            status={j.status}
            holdReason={(j as any).hold_reason ?? null}
            holdUntil={"hold_until" in j ? ((j as any).hold_until ?? null) : undefined}
            holdBy={(j as any).hold_by ? (((techs ?? []) as any[]).find((t) => t.id === (j as any).hold_by)?.full_name ?? null) : null}
            todayStr={todayStrInTz(tz)}
            viewerIsStaff={viewerIsStaff}
          />
          {/* Done & paid — the critical path's last step, on the record itself. Staff only, and
              NOT on a job billed with progress payments (Connected North Phase 1): the comment
              always said so and the condition never did, so INV-078's job carried a Pay Now whose
              server answer was a refusal. There the money is taken on the draw itself, from its
              invoice page (which asks before it sends a draft). settleUp re-checks server-side. */}
          {viewerIsStaff && j.status !== "cancelled" && !isDrawBilled && (
            <SettleUpButton
              source="job"
              id={j.id}
              compact
              cardEnabled={canAcceptPayments(connectStateFromOrg((org ?? {}) as any))}
              methods={getOrgSettings((org as any)?.settings).payment_methods}
              venmoConfigured={Boolean(getOrgSettings((org as any)?.settings).venmo_handle?.trim())}
              textReady={smsReadiness(org as { settings?: unknown } | null).ready}
            />
          )}
          {/* The Inspector — every note, photo and intake answer from any entrance point, one tap
              away. An access point, not a wall. */}
          {/* Leads & Walk-Throughs off (the switch board): no blank walk-through is started from here,
              but a job that has a visit keeps the door to its notes and photos (openJobInspector
              opens that visit first and creates nothing). */}
          {viewerIsStaff && (on("leads") || (jobAppts ?? []).some((a: any) => a.status !== "cancelled")) && <OpenInspectorButton jobId={j.id} />}
          {/* Provenance backlink → THE STORY, not /leads?focus= — that door resurrected the lead
              as a lead, live convert menu and all. Erik: "a lead not being a lead anymore doesnt
              include putting it back." The origin lives on in the first chapter below. */}
          {(j as any).inquiry && (
            <Link href={`/jobs/${j.id}?tab=job#activity`} className="inline-flex min-h-11 items-center text-brand hover:underline">
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

      {/* The action dock — one sticky glass bar: TIME (the only filled button, the job's one
          clock) · Photo · Call · Navigate · Manage ⋯ (the office's Edit Job, Finish Job, Delete
          Job; a tech's dock has no Manage). Add Cost is the Costs tab's header, one chip away. */}
      <JobActionDock
        job={j}
        taskPhotos={jobTasks.stamps}
        viewerIsStaff={viewerIsStaff}
        tz={tz}
        openEntry={openEntry}
        techs={techs ?? []}
        defaultProfileId={user?.id ?? ""}
        jobAddress={navTarget}
        customerPhone={j.customers?.phone ?? null}
        /* On T&M the estimate is a guide, never the bill: Finish builds the bill from the actuals
           there, so the modal never says the estimate's lines copy over. Every other job keeps the
           prop it always had (any quote row), so its Finish toggles start where they did. */
        hasQuote={(j as any).billing_type === "tm" ? false : (quotes ?? []).length > 0}
        defaultSendInvoice={getOrgSettings((org as any)?.settings).auto_send_invoice_on_complete}
        isDrawBilled={isDrawBilled}
        /* The book feeds the Edit Job modal, a staff door — a tech's dock never carries it. */
        customers={viewerIsStaff ? allCustomers ?? [] : []}
        /* Job Codes off: no code picker is left to limit, so Edit Job draws no template select
           (updateJob only writes code_template_id when the field is sent: the stored one stays). */
        templates={on("job_codes") ? ((codeTemplates ?? []) as { id: string; name: string }[]) : []}
      />

      {/* THE STRIP FOLLOWS THE URL (cn-v945). <Tabs urlSync> re-syncs its active tab whenever
          ?tab= changes, so an in-page <Link href="?tab=materials"> (the tech's "Add them on the
          Materials tab", the "← from lead" backlink) lands on the linked tab every time, and a
          server refresh after a strip tap (any action's revalidatePath) leaves the tab tree
          mounted — the alternative, keying <Tabs> on the linked tab, would remount the whole
          tree on that refresh (client state gone, for staff too) and do nothing on a second
          click of the same link. The staffOnly tabs are dropped HERE, before they're passed, so the money tabs' content
          never serializes to a tech; <Tabs> filters once more on the client.
          look="tiles": the role's pinned chips stay put, the rest ride the More chip. */}
      <Tabs
        tabs={arrangeJobTabs(tabs, viewerIsStaff, switches).filter((t) => !t.staffOnly || viewerIsStaff)}
        viewerIsStaff={viewerIsStaff}
        urlSync
        look="tiles"
      />
    </div>
  );
}
