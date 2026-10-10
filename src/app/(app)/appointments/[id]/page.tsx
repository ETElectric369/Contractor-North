import { notFound } from "next/navigation";
import { SettleUpButton } from "@/components/settle-up-button";
import { smsReadiness } from "@/lib/sms";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { UnscheduleButton } from "../unschedule-button";
import { Inspector, type CapturePhoto, type InspectionTemplate } from "./inspector";
import { MapPin } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, formatDateTimeTz } from "@/lib/tz";
import { Badge } from "@/components/ui/badge";
import { NavLink } from "@/components/nav-link";
import { appointmentTypeLabel, isInspectionType } from "@/lib/statuses";
import { getSchedulePickerOptions } from "@/lib/schedule-options";
import { AppointmentButton, type ApptValue } from "../appointment-button";
import { tolerateMissingColumns } from "@/lib/inspection/schema";
import { firstThatWorks } from "@/lib/kit-line";
import { kitsWithoutMoney, taskKitSelectRungs, taskKitsFrom } from "@/lib/estimate/task-kits";
import { MarkCompleteButton } from "./mark-complete-button";
import { MarkDoneRow, PutBackRow, WontHappenRow } from "./visit-header-actions";
import { ACTIONS_ROW_CLS, SectionActionsMenu } from "@/components/section-actions-menu";
import type { NavTree } from "@/lib/nav-tree";
import { wontHappenVerdict } from "@/lib/appointments/wont-happen";
import { captureQuoteId, hasCaptureData } from "@/lib/inspections";
import { isLiveQuote } from "@/lib/invoice-import-rule";
import { isDecidableVisitType } from "@/lib/statuses";
import { VisitEnding, type VisitEstimate } from "./visit-ending";
import { IntakeFiles } from "../../leads/intake-files";
import { intakePaths } from "@/lib/playbook/uploads";
import { playbookForForm } from "@/lib/playbook/parse";
import { intakeAnswerLines } from "@/lib/inquiries/carry-intake-answers";
import { parsePlanBrief } from "@/lib/plan-brief";
import { isStaffRole } from "@/lib/actions/perms";
import { jobShort, visitIsOver } from "@/lib/appointments/visit-start";
import { loadLinkInstead } from "@/lib/appointments/visit-start-read";
import { VisitStartCard } from "./visit-start-card";
import { jobNameFrom, jobWho, visitStreetOf } from "@/lib/job-name";
import { FeatureOffLine } from "@/components/feature-off-line";
import { featureOn } from "@/lib/features";
import {
  INSPECTION_UNREAD,
  answersWithoutPrices,
  isMissingRpc,
  readViaView,
  sheetsWithoutMoney,
  inspectionAccess,
} from "@/lib/inspection/inspection-access";

export const dynamic = "force-dynamic";

/** The visit's ⋯ (W2-11): every row is a composed child (they each own a toast or a modal), so the
 *  tree itself is empty — the detail pages' one Actions door, last on the header row. */
const VISIT_ACTIONS_MENU: NavTree = { center: { label: "Actions", icon: "more" }, nodes: [] };

/** The table read's pre-0165 shape (the column isn't there yet): the one failure the page still
 *  reads as "no sheet", as tolerateMissingColumns always did. */
function tolerableBefore0165(e: unknown): boolean {
  return String((e as { code?: string } | null)?.code ?? "") === "42703";
}

/**
 * The appointment CAPTURE surface — where an inspection gets its
 * field notes, measurements, materials list, and photos, saved onto
 * appointments.capture and read by /quotes/new?capture=<id> to prefill the
 * estimator scope (like importing labor into an invoice). Linked from the
 * Schedule day view for type='inspection' rows; works for any appointment.
 * Org-scoped by RLS — a cross-org id is a clean 404.
 */
export default async function AppointmentCapturePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  // Who's looking — stamped onto anything the inspection sheet queues offline, so a shared phone
  // can never file one person's work under another's name.
  const { data: { user: viewer } } = await supabase.auth.getUser();
  const viewerId = viewer?.id ?? null;

  const [{ data: appt }, { data: org }, picker, sheetsRead, answersRead, priceBook, taskKitsRead, intakeRead, { data: meRow }, { data: openRow }, { data: lastClosedRow }] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        // `message` rides along (PROJECTION LAW): it is the flattened copy of the customer's own
        // answers that the booking doors paste into `notes`, and the only way this page can tell
        // "the office wrote this note" from "this paragraph IS the intake summary, shown properly
        // below" is to have the original to compare against.
        // jobs(...) is the linked job the top card names ("Clock In On J-055"), and its status is
        // whether a visit that is over still offers a clock on it (a finished job does not); the lead's
        // customer_id is who "Link To J-055 Instead" looks for when the visit has no customer.
        "id, org_id, type, title, status, starts_at, ends_at, job_id, assigned_to, location, unit, city, state, zip, notes, customer_id, inquiry_id, capture, outcome, outcome_at, customers(name, company_name, type), inquiries(name, company_name, type, phone, message, intake, customer_id), jobs(id, job_number, name, status)",
      )
      .eq("id", id)
      .maybeSingle(),
    // phone: the crew's "Call The Office" door on a visit with no job yet.
    supabase.from("organizations").select("settings, phone, stripe_account_id, stripe_account_status, stripe_charges_enabled").limit(1).maybeSingle(),
    // Jobs/customers/staff option lists for the Edit-details modal (the same
    // SSOT helper the schedule's picker uses).
    getSchedulePickerOptions(supabase),
    // The org's inspection sheets + this appointment's answers (0165), THROUGH THE VIEWS 0366 made
    // (LEAK-0227): the answers from appointment_answers (the office gets them as stored, anyone else
    // without a price) and the sheets from form_playbooks (anyone but the office gets no note and no
    // dollar figure). readViaView asks the table as before only while a view isn't on the database
    // yet, and returns any other failure as a failure: the page then says it couldn't read the
    // inspection instead of drawing an empty one (whose first keystroke would save the emptiness).
    // Per-trade questions are DATA (deck questions for the deck company, panel questions for the
    // electrician), which is what keeps a typed inspection from needing a code module per trade.
    readViaView<InspectionTemplate[]>(supabase, "sheets", (from) =>
      from.select("id, name, schema, playbook").eq("is_inspection", true).order("name"),
    ),
    readViaView<{ inspection_template_id: string | null; inspection_answers: unknown }>(supabase, "answers", (from) =>
      from.select("inspection_template_id, inspection_answers").eq("id", id).maybeSingle(),
    ),
    // THE PRICE BOOK, for any `scopes` question in the playbook — the picker offers the org's own
    // codes in the org's own words, which is what makes it a scope picker rather than a text box.
    // Read tolerantly and unconditionally: it's a small table, and branching the query on whether
    // the playbook happens to contain a scopes need would break the moment somebody adds one.
    tolerateMissingColumns<{ code: string; description: string | null; unit: string | null; buy_price: number | null }[]>(
      () =>
        supabase
          .from("price_list_items")
          .select("code, description, unit, buy_price")
          .eq("archived", false)
          .order("code"),
    ),
    // THE TASK KITS (0386, W4), for a task's kit picker: by name, with their lines. Every money
    // field is dropped before they reach the browser (kitsWithoutMoney): the preview reads names
    // and counts, and a crew lead fills the visit in without ever seeing a price. Tolerant rungs,
    // as the kits queries everywhere: a deploy lands before its migration.
    firstThatWorks(taskKitSelectRungs().map((sel) => () => supabase.from("kits").select(sel).order("name"))),
    // THE FORM THE CUSTOMER FILLED IN. Its playbook is the only place the LABELS for
    // `intake.intake_answers` exist — the answers themselves are a bag of keys, and `q_mst1drw8`
    // is not a question. Through form_playbooks like the sheets (0366), org-scoped; an org with no
    // public door simply has none and the card below never renders.
    readViaView<{ schema: unknown; playbook: unknown }>(supabase, "sheets", (from) =>
      from.select("schema, playbook").eq("is_public_intake", true).limit(1).maybeSingle(),
    ),
    // WHO IS LOOKING, and whether they are on the clock: the top card's four faces (start / ask the
    // office / clock in / you're on the clock here) and its Switch To This Job depend on both.
    // crew_lead: whether they fill in the inspection on a visit they are on (0356).
    supabase.from("profiles").select("role, crew_lead").eq("id", viewerId ?? "").maybeSingle(),
    supabase
      .from("time_entries")
      .select("id, job_id, job_code, clock_in, job:job_id(job_number, name)")
      .eq("profile_id", viewerId ?? "")
      .eq("status", "open")
      .maybeSingle(),
    // The end of the viewer's latest finished shift: the sheet's one-tap Visit Time start is not
    // offered when it would land inside hours already recorded (it could never be clocked out).
    supabase
      .from("time_entries")
      .select("clock_out")
      .eq("profile_id", viewerId ?? "")
      .not("clock_out", "is", null)
      .order("clock_out", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!appt) notFound();

  // A read that failed is said, never drawn as an empty sheet. The one failure that still reads as
  // "no sheet" is the table's own pre-0165 shape (no such column), exactly as before.
  const unread = (r: { error: unknown; via: "view" | "table" }) =>
    !!r.error && !(r.via === "table" && tolerableBefore0165(r.error));
  const inspectionUnread = unread(sheetsRead) || unread(answersRead);
  const sheets = sheetsRead.error ? null : sheetsRead.data;
  const inspection = answersRead.error ? null : answersRead.data;
  const intakeForm = intakeRead.error ? null : intakeRead.data;
  const intakeUnread = unread(intakeRead);

  const orgSettings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const tz = orgSettings.timezone;
  // THE SWITCH BOARD (0352). On an inspection the Inspector below is Leads & Inspections': off, it
  // shows only on a visit that already captured something, never as a blank sheet to start. Every
  // other visit (service, consult) keeps it: it is that page's only notes, photos and sheet surface.
  const estimatesOn = featureOn(orgSettings.features, "estimates");
  const isInspection = isInspectionType((appt as { type?: string | null }).type);
  const showInspector =
    featureOn(orgSettings.features, "leads") ||
    !isInspection ||
    hasCaptureData((appt as { capture?: unknown }).capture) ||
    Object.keys((inspection?.inspection_answers ?? {}) as Record<string, unknown>).length > 0;
  const a = appt as any;
  const capture = (a.capture ?? {}) as {
    notes?: string;
    measurements?: string;
    materials?: string;
    photos?: string[];
  };

  // Photos live as PATHS in the private documents bucket — sign them for display.
  // (Audit 2026-07-16: the whole capture round-trip is live in prod — write via
  // saveAppointmentCapture, photo paths persisted immediately on upload, read back
  // here signed, text fields prefill /quotes/new. Photos deliberately do NOT carry
  // into the quote prefill. Not a written-never-read column.)
  const paths = (Array.isArray(capture.photos) ? capture.photos : []).filter(
    (p): p is string => typeof p === "string" && !!p,
  );
  const photos: CapturePhoto[] = await Promise.all(
    paths.map(async (path) => {
      const { data } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
      return { path, url: data?.signedUrl ?? null };
    }),
  );

  const dayStr = a.starts_at ? todayStrInTz(tz, new Date(a.starts_at)) : "";
  const who = a.customers?.name ?? a.inquiries?.name ?? null;

  /* WHAT THE VISIT BECAME (cn-v1069). The estimate written up from it is linked INSIDE the capture
     (capture.quote_id, saveQuote's backlink); this page never read it, so a visit whose estimate was
     sent, declined or turned into a job still offered Start The Estimate as if nothing had happened.
     One read, RLS-scoped; a quote that can't be read is simply not there. */
  const behindQuoteId = captureQuoteId(a.capture);
  const quoteBehind = behindQuoteId
    ? ((await supabase.from("quotes").select("id, quote_number, status, job_id").eq("id", behindQuoteId).maybeSingle()).data as
        | { id: string; quote_number: string | null; status: string | null; job_id: string | null }
        | null)
    : null;
  const estimate: VisitEstimate | null = quoteBehind
    ? { id: quoteBehind.id, number: quoteBehind.quote_number, status: quoteBehind.status, live: isLiveQuote(quoteBehind.status) }
    : null;
  // The visits with a win or a loss to record (lib/statuses DECIDABLE_VISIT_TYPES): a meeting or an
  // Other visit too — never a work visit (its answer is the invoice) or a final inspection (the
  // authority's).
  const decidable = isDecidableVisitType(a.type);

  /* THE TOP CARD (Erik, 2026-09-25, Tom Goodman): "I just needed a job linked to that lead to start
     the clock, simple." What it needs: who is looking, their running clock, the linked job, and,
     for the office on a visit with no job, the one same-day job of this customer it could link to
     instead (the same read linkVisitInstead re-asks before it links). */
  const viewerIsStaff = isStaffRole((meRow as { role?: string } | null)?.role ?? "");
  const linkedJob = (Array.isArray(a.jobs) ? a.jobs[0] : a.jobs) as
    | { id: string; job_number: string | null; name: string | null; status: string | null }
    | null
    | undefined;
  const oe = openRow as
    | {
        id: string;
        job_id: string | null;
        job_code: string | null;
        clock_in: string;
        job: { job_number: string | null; name: string | null } | { job_number: string | null; name: string | null }[] | null;
      }
    | null;
  const oeJob = oe ? (Array.isArray(oe.job) ? oe.job[0] : oe.job) : null;
  const viewerOpenEntry = oe
    ? {
        id: oe.id,
        job_id: oe.job_id,
        label: oeJob ? jobShort(oeJob) : (oe.job_code ?? "").trim() || "no job",
        clock_in: oe.clock_in,
        // The two facts a switch's outcome is decided from, never the decision itself: whether the
        // punch has a PLACE (a job or a code) and when it started. Whether it moves whole or gets cut
        // turns on the punch's age (switch-window), so the card asks that on its own live clock — a
        // boolean settled here would still be promising "moves whole" half an hour after this render.
        job_code: (oe.job_code ?? "").trim() || null,
      }
    : null;
  /* WHO FILLS IN THE INSPECTION (0356; Erik, 2026-09-26: "crew leader yes tech no"). The office, as
     before; a crew lead who is ON this visit, through save_walkthrough_capture; everyone else reads.
     The probe is that function called with nothing to save: it writes nothing and answers whether
     they may. Before 0356 is applied it isn't there, so a crew lead gets the read-only inspection
     and a plain line, never a Save that can't work. */
  const viewerIsCrewLead = !!(meRow as { crew_lead?: boolean | null } | null)?.crew_lead;
  const onThisVisit = !!viewerId && a.assigned_to === viewerId;
  const crewProbe =
    showInspector && !viewerIsStaff && viewerIsCrewLead && onThisVisit
      ? await supabase.rpc("save_walkthrough_capture", { p_appointment: a.id })
      : null;
  const access = inspectionAccess({
    isStaff: viewerIsStaff,
    crewLead: viewerIsCrewLead,
    onThisVisit,
    rpcReady: !!crewProbe && !crewProbe.error,
  });
  const viewNote =
    crewProbe && isMissingRpc(crewProbe.error)
      ? "Crew leads can fill this in once the office finishes an update. Until then only the office can change it."
      : null;

  const linkInstead =
    viewerIsStaff && !a.job_id && a.status !== "cancelled"
      ? await loadLinkInstead(supabase, { ...a, inquiry_id: a.inquiry_id ?? null }, tz)
      : null;

  /* WON'T HAPPEN'S CONFIRM (W2-11) says which will happen, from the four facts the server asks again
     at the write (lib/appointments/wont-happen): anything captured, an estimate written from it, an
     invoice pointing at it, a pick-a-time link waiting. A read that fails counts as "something is
     there", so the confirm never promises a delete the server won't make. Staff, booked visits only. */
  const booked = a.status === "scheduled" || a.status === "proposed";
  const [invoicesOnIt, linksWaiting] =
    viewerIsStaff && booked
      ? await Promise.all([
          supabase.from("invoices").select("id", { count: "exact", head: true }).eq("appointment_id", a.id),
          supabase.from("schedule_proposals").select("id", { count: "exact", head: true }).eq("appointment_id", a.id).eq("status", "pending"),
        ])
      : [null, null];
  const wontHappenDeletes =
    viewerIsStaff &&
    booked &&
    wontHappenVerdict({
      capture: a.capture,
      answers: inspection?.inspection_answers ?? null,
      answersUnread: !!answersRead.error,
      invoiceCount: invoicesOnIt && !invoicesOnIt.error ? (invoicesOnIt.count ?? 0) : null,
      pendingLinks: linksWaiting && !linksWaiting.error ? (linksWaiting.count ?? 0) : null,
    }) === "delete";
  const scheduleDayHref = dayStr ? `/schedule?view=day&date=${dayStr}` : "/schedule";

  /* THE NAME START THE JOB WILL GIVE, resolved the way createJobFromAppointment resolves it (the
     visit's card, else the lead's card, else the lead; the lead's own spelling still only-who), so
     the name this page promises is the name the job gets. A lead that got its card after the visit
     was booked has it on inquiries.customer_id only. */
  const leadCardId = !a.customer_id && !a.job_id && a.status !== "cancelled" ? (a.inquiries?.customer_id ?? null) : null;
  const leadCard = leadCardId
    ? ((await supabase.from("customers").select("name, company_name, type").eq("id", leadCardId).maybeSingle()).data ?? null)
    : null;
  const previewWho = jobWho([a.customer_id ? a.customers : leadCard, a.inquiries ?? null]);
  const previewJobName = jobNameFrom({
    sourceWords: a.title,
    customer: previewWho.customer,
    aliases: previewWho.aliases,
    street: visitStreetOf(a.location, a),
    unit: (a as { unit?: string | null }).unit ?? null,
    todayStr: todayStrInTz(tz),
  });

  /**
   * WHAT THE CUSTOMER ALREADY TOLD US ONLINE — on the inspection, as answers, in their name.
   *
   * Erik, three reports off the Andy Colar lead: "the walk-through starts blank", "the intake
   * answers don't carry over", "they aren't on the lead at all". HIS WORDS ARE HIS, OLD WORD AND ALL
   * — he filed these on 2026-09-09, while the app itself still said Inspection everywhere, so this
   * is him calling it a walk-through of his own accord. Do not sweep a quote; it is the record.
   * The answers were never missing —
   * they are on `inquiries.intake.intake_answers`, and this page has been SELECTING them all along
   * to sign the uploaded files. Nothing read the rest.
   *
   * The pre-fill (carryForInquiry) matches by key, and only a question that exists on BOTH the
   * intake form and the inspection can match. Vivian Builders' intake asks 26 questions and their
   * inspection asks one, so his lead carried nothing at all — and the only trace of what the
   * customer said was the flattened paragraph pasted into the appointment's notes, sitting there
   * unattributed as if the office had typed it.
   *
   * So: the same answers, labelled with the questions they were asked under, marked as the
   * customer's own. Read-only on purpose — a person answering a web form is neither the contractor's
   * word ("take it as given") nor a machine's reading, and the estimator's provenance split has no
   * third bucket. He confirms it on site, and what he types on the sheet is his.
   */
  const lead = (a.inquiries ?? null) as
    | { name?: string | null; message?: string | null; intake?: { intake_answers?: unknown } | null }
    | null;
  const intakePlaybook = intakeForm ? playbookForForm(intakeForm) : null;
  // Anything already sitting on the sheet as an editable answer (the key DID match) is left to the
  // sheet — repeating it here would be asking him to confirm the same thing twice.
  const prefilled = new Set(
    Object.entries((inspection?.inspection_answers ?? {}) as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
      .map(([k]) => k),
  );
  const customerSaid = intakePlaybook
    ? intakeAnswerLines(intakePlaybook, lead?.intake?.intake_answers, prefilled)
    : [];
  // NOTHING SILENT: when the inspection asks none of what the customer answered, the pre-fill did
  // not fail quietly — it had nowhere to put anything, and the card says so rather than leaving him
  // to conclude the answers were lost.
  const sheetKeys = new Set((sheets ?? []).flatMap((s) => playbookForForm(s).needs.map((n) => n.key)));
  const sheetAsksNone =
    customerSaid.length > 0 && prefilled.size === 0 && customerSaid.every((l) => !sheetKeys.has(l.key));

  // The booking doors paste the lead's `message` — a flattened copy of exactly these answers — into
  // the appointment's notes. Now that the answers render AS answers, printing that paragraph above
  // them is the same ten lines twice. Strip it only when it is still there verbatim; a note somebody
  // has edited, or one carrying an office remark as well, is left exactly as written.
  const leadMessage = String(lead?.message ?? "").trim();
  const notesRaw = String(a.notes ?? "");
  const notesShown =
    customerSaid.length > 0 && leadMessage && notesRaw.includes(leadMessage)
      ? notesRaw.split(leadMessage).join("").replace(/\n{3,}/g, "\n\n").trim()
      : notesRaw;

  // The full edit modal (same one the schedule day view opens via the pencil) —
  // title/time/type/assignee/location are editable HERE too, not just capture fields.
  const apptValue: ApptValue = {
    id: a.id,
    type: a.type,
    title: a.title,
    starts_at: a.starts_at,
    ends_at: a.ends_at ?? null,
    job_id: a.job_id ?? null,
    customer_id: a.customer_id ?? null,
    location: a.location ?? null,
    notes: a.notes ?? null,
    assigned_to: a.assigned_to ?? null,
  };

  return (
    <div className="mx-auto max-w-2xl">
      {viewerIsStaff ? (
        <BackLink fallback={dayStr ? `/schedule?view=day&date=${dayStr}` : "/schedule"} fallbackLabel="Back To Schedule" />
      ) : (
        <BackLink fallback="/planner" fallbackLabel="Back To My Day" />
      )}

      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="blue" className={isInspectionType(a.type) ? "bg-teal-100 text-teal-800" : undefined}>
            {appointmentTypeLabel(a.type)}
          </Badge>
          {a.status === "proposed" && <Badge tone="amber">pending pick</Badge>}
          {a.status === "completed" && <Badge tone="green">done</Badge>}
          {/* A cancelled appointment showed NO chip at all, so the page looked identical to a
              live one — which is half of why "can't cancel inspection" reads as broken. */}
          {a.status === "cancelled" && <Badge tone="slate">cancelled</Badge>}
          {/* AT MOST ONE MAIN BUTTON, THEN ⋯ (W2-11). The row used to carry up to seven controls
              (Get Paid, a small "mark complete", Delete, a bare ✓ and ✗, Clear The Date, Edit
              Details). THE OFFICE'S VERBS all save through requireStaff, and Get Paid puts money
              in front of a tech: a tech gets the badges and the page, not the doors (Wave 0). */}
          {/* THE MONEY DOOR — a work visit that is still on. Not on an inspection: Erik, "i dont
              need a pay now button on the inspection page." An inspection's money path IS the
              estimate. It stays on the visit types where work happens and money changes hands on
              the spot (a legacy service_call/job appointment — new ones become real jobs at
              booking, and pay from the job page). */}
          {viewerIsStaff && a.status !== "cancelled" && !isInspection && (
            <SettleUpButton
              source="appointment"
              id={a.id}
              cardEnabled={canAcceptPayments(connectStateFromOrg((org ?? {}) as any))}
              methods={orgSettings.payment_methods}
              venmoConfigured={Boolean(orgSettings.venmo_handle?.trim())}
              textReady={smsReadiness(org as { settings?: unknown } | null).ready}
            />
          )}
          {/* A booked inspection's main button: done, so the Inspections tab moves it to
              To write up. A completed inspection has none: the Inspector's Start The Estimate
              is its next step. A cancelled visit has none either. */}
          {viewerIsStaff && isInspection && booked && (
            <MarkCompleteButton id={a.id} label="Mark Inspection Done" />
          )}
          {/* ⋯ ACTIONS, last on the row. Edit Details… is never rendered conditionally inside the
              open panel (its modal would unmount mid-edit); its footer Delete stays the deliberate
              way to remove a visit that has captured data. WON'T HAPPEN replaces the ✗ Cancel and
              the top-row Delete: it deletes only a visit with nothing on it, and otherwise marks
              it Cancelled with an Undo (lib/appointments/wont-happen). */}
          {viewerIsStaff && (
            <SectionActionsMenu tree={VISIT_ACTIONS_MENU}>
              {!isInspection && booked && <MarkDoneRow id={a.id} />}
              <AppointmentButton
                jobs={picker.jobOpts}
                customers={picker.custOpts}
                staff={picker.staffOpts}
                appointment={apptValue}
                rowLabel="Edit Details…"
                triggerClassName={ACTIONS_ROW_CLS}
                afterDeleteHref={scheduleDayHref}
              />
              {/* Postponed-indefinitely is a real answer: back to the waiting board, date cleared,
                  everything else kept. Only while a date exists to clear. */}
              {booked && a.starts_at && <UnscheduleButton id={a.id} menuItem />}
              {a.status === "cancelled" && <PutBackRow id={a.id} />}
              {booked && <WontHappenRow id={a.id} deletes={wontHappenDeletes} afterHref={scheduleDayHref} />}
            </SectionActionsMenu>
          )}
        </div>
        <h1 className="mt-2 text-xl font-bold text-slate-900">{a.title}</h1>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-slate-500">
          {/* A visit with its date cleared waits on the schedule's rail (0368): said, never blank. */}
          {a.starts_at ? <span>{formatDateTimeTz(a.starts_at, tz)}</span> : <span>Waiting For A Day</span>}
          {who && <span>· {who}</span>}
          {a.location && (
            <NavLink address={a.location} className="inline-flex items-center gap-0.5 text-brand hover:underline">
              <MapPin className="h-3.5 w-3.5" /> {a.location}
            </NavLink>
          )}
        </div>
        {/* START THE WORK, FIRST. The visit that turns into a job and a running clock is one tap
            here; the Inspector and the estimator are still below for the visits that need them. */}
        {a.status !== "cancelled" && (
          <div className="my-4">
            <VisitStartCard
              appointmentId={a.id}
              tz={tz}
              isStaff={viewerIsStaff}
              job={
                a.job_id
                  ? {
                      id: a.job_id,
                      job_number: linkedJob?.job_number ?? null,
                      name: linkedJob?.name ?? null,
                      status: linkedJob?.status ?? null,
                    }
                  : null
              }
              visitOver={visitIsOver(a, tz)}
              openEntry={viewerOpenEntry}
              linkInstead={
                linkInstead
                  ? {
                      id: linkInstead.id,
                      job_number: linkInstead.job_number,
                      name: linkInstead.name,
                      status: linkInstead.status,
                      customer: who,
                    }
                  : null
              }
              preview={{
                // The same one namer the Start The Job door uses (lib/job-name): the street number
                // and name ("12 Elm St #56" with a unit), else "Rita Moss · <the visit's words>",
                // never its "Site inspection:" tag.
                name: previewJobName,
                customer: who,
                address: a.location ?? null,
                scheduledStart: a.starts_at ?? null,
              }}
              officePhone={(org as { phone?: string | null } | null)?.phone ?? null}
              lastClockOut={(lastClosedRow as { clock_out?: string | null } | null)?.clock_out ?? null}
            />
          </div>
        )}
        {/* HOW IT ENDED (cn-v1069): the estimate it became, the outcome with its day, and for the office on
            a completed estimate visit nobody has decided, the two honest endings. */}
        <VisitEnding
          appointmentId={a.id}
          isStaff={viewerIsStaff}
          decidable={decidable}
          status={a.status ?? null}
          estimate={estimate}
          outcome={(a as { outcome?: string | null }).outcome ?? null}
          outcomeAt={(a as { outcome_at?: string | null }).outcome_at ?? null}
          job={linkedJob ? { id: linkedJob.id, job_number: linkedJob.job_number, name: linkedJob.name } : null}
          tz={tz}
          seed={a.location ?? who ?? ""}
        />
        {notesShown && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{notesShown}</p>}
        {/* The customer's own answers, as answers. See the block above for why this is read-only
            and why it is attributed out loud. */}
        {a.inquiry_id && customerSaid.length > 0 && (
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              What the customer told us online
            </p>
            <dl className="mt-1.5 space-y-1">
              {customerSaid.map((l) => (
                <div key={l.key} className="flex flex-wrap gap-x-2 text-sm">
                  <dt className="shrink-0 text-slate-500">{l.label}</dt>
                  <dd className="font-medium text-slate-800">{l.value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-slate-400">
              Their words, not a finding — confirm on site.
              {sheetAsksNone
                ? " None of these matched a question on your inspection sheet, so none of them could fill it in."
                : ""}
            </p>
          </div>
        )}
        {/* The website form's questions couldn't be read: said, not a card that silently isn't there. */}
        {a.inquiry_id && lead?.intake && intakeUnread && (
          <p className="mt-2 text-xs text-slate-500">Couldn&apos;t read the website form&apos;s questions just now, so the customer&apos;s answers aren&apos;t shown. Reload to try again.</p>
        )}
        {/* What the customer attached at intake — the plans this inspection prices from. The
            lead leaves the inbox once it converts, so every linked surface carries its files. */}
        {a.inquiry_id && (
          <IntakeFiles inquiryId={a.inquiry_id} paths={intakePaths((a.inquiries as { intake?: unknown } | null)?.intake)} />
        )}
      </div>

      {/* ONE SURFACE. This used to be two components stacked — a three-textarea capture card and,
          below it, a separate typed question sheet with its own Save button and placeholders that
          referred to "the questions above" while the questions were below. Erik: "it should all be
          one smart thing that starts with the appointed questions and fragments from those first".
          Nothing was dropped in the merge: the prose boxes, the photos and the typed sheet are all
          still here, reordered so the ask comes first and everything captured reads as one list. */}
      {/* The inspection and the estimate, for the visits that need them. Under their own heading
          so the page reads: start the work (above), or walk it through and price it (here).
          THE SWITCH BOARD (0352): the inspection is Leads', so with Leads off it shows only on a
          visit that already holds one (under the Off line); Estimates off drops Start The Estimate. */}
      {showInspector && (
        <>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{viewerIsStaff && estimatesOn ? "Inspection Or Estimate" : "Inspection"}</h2>
          {isInspection && (
            <FeatureOffLine feature="leads" features={orgSettings.features} isOwner={(meRow as { role?: string } | null)?.role === "owner"} />
          )}
          {/* An inspection read that failed is SAID, and nothing is drawn that could save over it:
              an empty sheet's first keystroke would autosave the emptiness over the real answers. */}
          {inspectionUnread ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{INSPECTION_UNREAD}</p>
          ) : (
          <Inspector
            appointmentId={a.id}
            orgId={a.org_id}
            userId={viewerId}
            // A written why line is where the answer lands in the PRICE and a note is the owner's own
            // voice: the office gets the sheets as written; anyone else gets them with every note
            // dropped and every why without its dollar figures (the row goes to the browser whole).
            templates={viewerIsStaff ? (sheets ?? []) : sheetsWithoutMoney(sheets ?? [])}
            // The office fills in and prices; a crew lead on this visit fills in (0356); anyone else
            // reads. The price book carries buy prices: only the office gets it.
            access={access}
            viewNote={viewNote}
            priceBook={(viewerIsStaff ? (priceBook ?? []) : []).map((p) => ({
              code: p.code,
              description: p.description ?? "",
              unit: p.unit ?? "EA",
              price: Number(p.buy_price ?? 0),
            }))}
            taskKits={kitsWithoutMoney(taskKitsFrom(taskKitsRead.data))}
            initialTemplateId={inspection?.inspection_template_id ?? null}
            // A scope pick stores its price: the office's answers go as they are; nobody else's page
            // carries one (and a crew lead's save can't change a priced answer anyway: 0356).
            initialAnswers={
              (viewerIsStaff
                ? (inspection?.inspection_answers ?? {})
                : answersWithoutPrices(inspection?.inspection_answers as Record<string, unknown> | null)) as never
            }
            initialCapture={capture}
            initialPhotos={photos}
            initialLocation={a.location ?? ""}
            linked={
              a.inquiry_id && a.inquiries?.name
                ? { kind: "lead" as const, name: a.inquiries.name }
                : a.customer_id && a.customers?.name
                  ? { kind: "customer" as const, name: a.customers.name }
                  : a.job_id
                    ? { kind: "job" as const, name: "This job" }
                    : null
            }
            // Pricing is the office's: nobody else is handed the door to the estimator.
            estimateHref={viewerIsStaff && estimatesOn ? `/quotes/new?capture=${a.id}${a.inquiry_id ? `&inquiry=${a.inquiry_id}` : ""}` : null}
            // The estimate already written up from this visit: its door reads Open The Estimate while
            // it stands; a declined or expired one hands Start The Estimate back (cn-v1069).
            estimate={estimate}
            nortOn={featureOn(orgSettings.features, "nort")}
            buildOwn={featureOn(orgSettings.features, "safety_log")}
            // The linked lead's preliminary plan report — parsed server-side so the card is in the
            // initial HTML (Zone A must not grow after mount). Ready briefs only; the lead row owns
            // the pending/failed lifecycle.
            planBrief={
              a.inquiry_id
                ? (() => {
                    const b = parsePlanBrief((a.inquiries as { intake?: unknown } | null)?.intake);
                    if (b?.status !== "ready") return null;
                    return viewerIsStaff || !b.answers ? b : { ...b, answers: answersWithoutPrices(b.answers) };
                  })()
                : null
            }
          />
          )}
        </>
      )}
    </div>
  );
}
