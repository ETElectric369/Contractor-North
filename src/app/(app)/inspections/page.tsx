import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardCheck, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { getOrgSettings } from "@/lib/org-settings";
import { formatDateTimeTz } from "@/lib/tz";
import { getSchedulePickerOptions } from "@/lib/schedule-options";
import { PageHeader, EmptyState } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { fillSlots } from "@/lib/lang-words";
import { currentLangFor } from "@/lib/current-lang";
import type { Lang } from "@/lib/locale";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ESTIMATE_VISIT_TYPES, appointmentTypeLabel, visitTitle } from "@/lib/statuses";
import { bucketInspections, filedUnder, inspectionLabel, inspectionRowTags, type FiledUnder } from "@/lib/inspections";
import { MissedDoors } from "./missed-doors";
import { AppointmentButton } from "../appointments/appointment-button";
import { NewInspectionButton } from "../appointments/new-inspection-button";
import { featureOn } from "@/lib/features";

export const dynamic = "force-dynamic";

/**
 * Sales → Inspections (the route never moved; lib/statuses holds the one word):
 * appointments of the inspection types, bucketed as OPEN WORK FIRST
 * (Erik's design 2026-07-14 — an inspection IS an appointment type, one platform):
 *   • "To write up" — the visit happened but its inquiry/job has no estimate yet; each row's
 *     next step is one button: Create estimate (capture prefills the estimator scope).
 *   • "Upcoming & proposed" — the calendar-shaped rest, by date/status.
 * Everything settled FILES AWAY behind ?view=completed, exactly like the estimates file-away
 * pattern, under three headings: Completed & written up, Lost, Cancelled (lib/inspections
 * filedUnder). Rows link to the appointment's capture surface.
 */
export default async function InspectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const showCompleted = view === "completed";
  const supabase = await createClient();

  // Office-only surface (mirrors /schedule): techs get My Day, not a half-empty sales tab.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !isStaffRole(me.role)) redirect("/planner");
  // The reader's language, read ONCE (current-lang caches per request) and handed to every row.
  const lang = await currentLangFor(user?.id);
  const t = translator(lang);

  const [{ data: apptData }, { data: quoteLinks }, { data: org }, pickers] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, type, title, status, starts_at, location, capture, inquiry_id, job_id, outcome, customers(name), inquiries(name)",
      )
      .in("type", [...ESTIMATE_VISIT_TYPES])
      // A visit waiting for a day (no start, 0368) sorts last, never first: Postgres puts nulls
      // first in a descending sort unless told.
      .order("starts_at", { ascending: false, nullsFirst: false })
      .limit(500),
    // Which inquiries/jobs already have an estimate — the "written up" signal. Ids too:
    // a lead-less Inspect-now write-up is matched via capture.quote_id (no inquiry/job link).
    supabase.from("quotes").select("id, inquiry_id, job_id"),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    getSchedulePickerOptions(supabase),
  ]);

  const orgS = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const tz = orgS.timezone;
  // THE SWITCH BOARD (0352), from the settings and role already read. Inspections are part of
  // Leads: off, this list still opens from a link, under the Off line, with no new-inspection doors.
  // Estimates off: no Create Estimate on a row.
  const sw = { features: orgS.features, isOwner: me.role === "owner" };
  const leadsOn = featureOn(sw.features, "leads");
  const estimateDoor = featureOn(sw.features, "estimates");
  const rows = (apptData ?? []) as any[];
  const estimateInquiryIds = new Set<string>(
    (quoteLinks ?? []).map((q: any) => q.inquiry_id).filter(Boolean),
  );
  const estimateJobIds = new Set<string>((quoteLinks ?? []).map((q: any) => q.job_id).filter(Boolean));
  const estimateQuoteIds = new Set<string>((quoteLinks ?? []).map((q: any) => q.id).filter(Boolean));
  // Same four endings as the inbox (0205) — this list and Needs-action must never disagree
  // about what is outstanding, which is why they share bucketInspections.
  const { data: billedJobs } = await supabase
    .from("invoices")
    .select("job_id")
    .not("job_id", "is", null)
    .not("status", "in", "(draft,void)")
    .limit(5000);
  const { toWriteUp, upcoming, missed, filed } = bucketInspections(
    rows,
    estimateInquiryIds,
    estimateJobIds,
    new Date(),
    estimateQuoteIds,
    new Set(((billedJobs ?? []) as { job_id: string }[]).map((r) => r.job_id).filter(Boolean)),
    tz, // "before today" is the company's midnight (the Didn't Happen? group)
  );
  // THE FILED PILE, EACH ROW UNDER ONE HEADING (lib/inspections filedUnder: the OUTCOME first,
  // whatever the status). One pass, so no row can be drawn twice or fall between two filters; each
  // group keeps the pile's order (newest first).
  const filedBy: Record<FiledUnder, typeof filed> = { completed: [], lost: [], cancelled: [] };
  for (const r of filed) filedBy[filedUnder(r)].push(r);

  // 44px targets, like every tap in the app (the pill still reads as a pill).
  const pill = (active: boolean) =>
    `inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
      active
        ? "border-brand bg-brand-light/40 text-brand-dark"
        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
    }`;

  // The EXISTING appointment flow (Set a Time | Propose Times) preset to the inspection
  // type — shared by the header AND the empty state. The empty state used to mount a bare
  // <NewInspectionButton />, whose fallback links the generic /schedule create modal
  // (type defaults to "appointment"), so a trusting tap made a record that never appears here.
  const scheduleInspection = (
    <AppointmentButton
      jobs={pickers.jobOpts}
      customers={pickers.custOpts}
      staff={pickers.staffOpts}
      defaultType="inspection"
      buttonLabel={t("ip_btn_bookAnInspection")}
    />
  );

  return (
    <div>
      <PageHeader title={t("nv_page_inspections")} description={t("nv_desc_inspections")}>
        {/* The shared two-mode affordance: Start an Inspection (one tap → capture) or the EXISTING
            appointment flow (Set a Time | Propose Times), preset to the inspection type. */}
        {leadsOn && <NewInspectionButton schedule={scheduleInspection} />}
      </PageHeader>

      {/* Open work is the default view; settled paperwork files away (estimates pattern). */}
      <div className="mb-4 flex gap-2">
        <Link href="/inspections" className={pill(!showCompleted)}>
          {t("ip_btn_open")}
        </Link>
        <Link href="/inspections?view=completed" className={pill(showCompleted)}>
          {t("ip_btn_completed")}
        </Link>
      </div>

      {showCompleted ? (
        filed.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title={t("ip_nothingFiledTitle")}
            description={t("ip_nothingFiledDesc")}
          />
        ) : (
          // A CANCELLED VISIT IS NOT COMPLETED WORK. Both land in `filed` (correctly — they are
          // both settled), but rendering them under one heading reading "Completed & written up"
          // told Erik an inspection he cancelled had been written up into an estimate. Same
          // rows, honest headings.
          // AND NEITHER IS A LOST ONE (cn-v1158). The split was on status alone, so a visit that
          // never happened and was answered Lost in the Didn't Happen? group (still scheduled,
          // nothing on it) was filed as "Completed & written up". A visit that did not become work
          // is LOST, everywhere: the third heading sits between the two, and which heading a row is
          // under is ONE rule, by outcome first (filedUnder). A group with no rows draws no heading.
          <div className="space-y-6">
            {filedBy.completed.length > 0 && <Section title={t("ip_completedWrittenUp")} rows={filedBy.completed} tz={tz} lang={lang} t={t} />}
            {filedBy.lost.length > 0 && <Section title={t("ip_lost")} rows={filedBy.lost} tz={tz} lang={lang} t={t} />}
            {filedBy.cancelled.length > 0 && <Section title={t("ip_cancelled")} rows={filedBy.cancelled} tz={tz} lang={lang} t={t} />}
          </div>
        )
      ) : toWriteUp.length === 0 && upcoming.length === 0 && missed.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={t("ip_noOpenInspections")}
          description={leadsOn ? t("ip_emptyDescLeadsOn") : t("ip_emptyDescLeadsOff")}
        >
          {leadsOn && <NewInspectionButton schedule={scheduleInspection} />}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {toWriteUp.length > 0 && (
            <Section title={fillSlots(t("ip_toWriteUp"), { n: toWriteUp.length })} rows={toWriteUp} tz={tz} lang={lang} t={t} writeUp estimateDoor={estimateDoor} />
          )}
          {missed.length > 0 && <Section title={t("ip_missed")} rows={missed} tz={tz} lang={lang} t={t} missed />}
          {upcoming.length > 0 && <Section title={t("ip_upcomingProposed")} rows={upcoming} tz={tz} lang={lang} t={t} />}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  tz,
  lang,
  t,
  writeUp = false,
  estimateDoor = true,
  missed = false,
}: {
  title: string;
  rows: any[];
  tz: string;
  lang: Lang;
  t: (key: string) => string;
  writeUp?: boolean;
  estimateDoor?: boolean;
  missed?: boolean;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-700">{title}</h2>
      <Card>
        <ul className="divide-y divide-slate-100">
          {rows.map((a) => (
            <InspectionRow key={a.id} a={a} tz={tz} lang={lang} t={t} writeUp={writeUp} estimateDoor={estimateDoor} missed={missed} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function InspectionRow({
  a,
  tz,
  lang,
  t,
  writeUp,
  estimateDoor,
  missed = false,
}: {
  a: any;
  tz: string;
  lang: Lang;
  t: (key: string) => string;
  writeUp: boolean;
  estimateDoor: boolean;
  missed?: boolean;
}) {
  const who = a.customers?.name ?? a.inquiries?.name ?? null;
  // EVERY ROW SAYS WHAT IT IS FOR (lib/inspections inspectionLabel): a real title stays, with who,
  // where and when under it; a bare "Inspection" gives way to who and where, the day under it.
  const label = inspectionLabel({
    title: visitTitle(a.title),
    typeLabel: appointmentTypeLabel(a.type, lang, t),
    customer: who,
    street: a.location ?? null,
    day: a.starts_at ? formatDateTimeTz(a.starts_at, tz, lang) : t("ip_waitingForADay"),
  });
  // NEXT-STEP: the capture prefills the estimator scope; the inquiry keeps the lead threading
  // (quotes/new also recovers it from the capture appointment when absent).
  const estimateHref = `/quotes/new?capture=${a.id}${a.inquiry_id ? `&inquiry=${a.inquiry_id}` : ""}`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link href={`/appointments/${a.id}`} className="group block">
          <div className="flex flex-wrap items-center gap-2">
            {/* visitTitle: a row titled during the three days the visit was a Walk-Through still
                SAYS that word, and this is the page Erik was reading when he reported the split. */}
            <span className="truncate font-medium text-slate-900 group-hover:text-brand">{label.title}</span>
            {/* ONE rule for the tags (lib/inspections inspectionRowTags) — this row draws the open
                piles AND the filed pile, and a tag written inline here rode into the wrong one: a
                green "Done" pill on every row of "To write up" (8592392b). No tag is written here. */}
            {inspectionRowTags(a, writeUp, lang, t).map((tag) => (
              <Badge key={tag.label} tone={tag.tone}>
                {tag.label}
              </Badge>
            ))}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-sm text-slate-500">
            <span>{label.subtitle}</span>
          </div>
        </Link>
      </div>
      {missed && <MissedDoors id={a.id} />}
      {writeUp && estimateDoor && (
        <Link href={estimateHref} className="shrink-0">
          <Button>
            <FileText className="h-4 w-4" /> {t("ip_btn_createEstimate")}
          </Button>
        </Link>
      )}
    </li>
  );
}
