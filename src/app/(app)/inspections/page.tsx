import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardCheck, FileText, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isStaffRole } from "@/lib/actions/perms";
import { getOrgSettings } from "@/lib/org-settings";
import { formatDateTimeTz } from "@/lib/tz";
import { getSchedulePickerOptions } from "@/lib/schedule-options";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { INSPECTION_TYPES, appointmentTypeLabel } from "@/lib/statuses";
import { bucketInspections, hasCaptureData } from "@/lib/inspections";
import { AppointmentButton } from "../appointments/appointment-button";
import { NewInspectionButton } from "../appointments/new-inspection-button";

export const dynamic = "force-dynamic";

/**
 * Sales → Inspections: appointments of the inspection types, bucketed as OPEN WORK FIRST
 * (Erik's design 2026-07-14 — an inspection IS an appointment type, one platform):
 *   • "To write up" — the visit happened but its inquiry/job has no estimate yet; each row's
 *     next step is one button: Create estimate (capture prefills the estimator scope).
 *   • "Upcoming & proposed" — the calendar-shaped rest, by date/status.
 * Completed-and-written-up + cancelled FILE AWAY behind ?view=completed, exactly like the
 * estimates file-away pattern. Rows link to the appointment's capture surface.
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

  const [{ data: apptData }, { data: quoteLinks }, { data: org }, pickers] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, type, title, status, starts_at, location, capture, inquiry_id, job_id, customers(name), inquiries(name)",
      )
      .in("type", [...INSPECTION_TYPES])
      .order("starts_at", { ascending: false })
      .limit(500),
    // Which inquiries/jobs already have an estimate — the "written up" signal.
    supabase.from("quotes").select("inquiry_id, job_id").or("inquiry_id.not.is.null,job_id.not.is.null"),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    getSchedulePickerOptions(supabase),
  ]);

  const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
  const rows = (apptData ?? []) as any[];
  const estimateInquiryIds = new Set<string>(
    (quoteLinks ?? []).map((q: any) => q.inquiry_id).filter(Boolean),
  );
  const estimateJobIds = new Set<string>((quoteLinks ?? []).map((q: any) => q.job_id).filter(Boolean));
  const { toWriteUp, upcoming, filed } = bucketInspections(rows, estimateInquiryIds, estimateJobIds);

  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm font-medium ${
      active
        ? "border-brand bg-brand-light/40 text-brand-dark"
        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
    }`;

  return (
    <div>
      <PageHeader
        title="Inspections"
        description="Site visits and final inspections — capture the walk-through, then write it up into an estimate."
      >
        {/* The shared two-mode affordance: Inspect now (one tap → capture) or the EXISTING
            appointment flow (Set a Time | Propose Times), preset to the inspection type. */}
        <NewInspectionButton
          schedule={
            <AppointmentButton
              jobs={pickers.jobOpts}
              customers={pickers.custOpts}
              staff={pickers.staffOpts}
              defaultType="inspection"
              buttonLabel="Schedule inspection"
            />
          }
        />
      </PageHeader>

      {/* Open work is the default view; settled paperwork files away (estimates pattern). */}
      <div className="mb-4 flex gap-2">
        <Link href="/inspections" className={pill(!showCompleted)}>
          Open
        </Link>
        <Link href="/inspections?view=completed" className={pill(showCompleted)}>
          Completed
        </Link>
      </div>

      {showCompleted ? (
        filed.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title="Nothing filed away yet"
            description="Inspections land here once they're written up into an estimate (or cancelled)."
          />
        ) : (
          <Section title="Completed & written up" rows={filed} tz={tz} />
        )
      ) : toWriteUp.length === 0 && upcoming.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No open inspections"
          description="Start one from a lead, schedule one, or tap Inspect now when you're already onsite."
        >
          <NewInspectionButton />
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {toWriteUp.length > 0 && (
            <Section title={`To write up (${toWriteUp.length})`} rows={toWriteUp} tz={tz} writeUp />
          )}
          {upcoming.length > 0 && <Section title="Upcoming & proposed" rows={upcoming} tz={tz} />}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  tz,
  writeUp = false,
}: {
  title: string;
  rows: any[];
  tz: string;
  writeUp?: boolean;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-700">{title}</h2>
      <Card>
        <ul className="divide-y divide-slate-100">
          {rows.map((a) => (
            <InspectionRow key={a.id} a={a} tz={tz} writeUp={writeUp} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function InspectionRow({ a, tz, writeUp }: { a: any; tz: string; writeUp: boolean }) {
  const who = a.customers?.name ?? a.inquiries?.name ?? null;
  // NEXT-STEP: the capture prefills the estimator scope; the inquiry keeps the lead threading
  // (quotes/new also recovers it from the capture appointment when absent).
  const estimateHref = `/quotes/new?capture=${a.id}${a.inquiry_id ? `&inquiry=${a.inquiry_id}` : ""}`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Link href={`/appointments/${a.id}`} className="group block">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-slate-900 group-hover:text-brand">{a.title}</span>
            {a.type === "final_inspection" && <Badge tone="indigo">{appointmentTypeLabel(a.type)}</Badge>}
            {a.status === "proposed" && <Badge tone="amber">pending pick</Badge>}
            {a.status === "completed" && <Badge tone="green">done</Badge>}
            {a.status === "cancelled" && <Badge tone="slate">cancelled</Badge>}
            {writeUp && !hasCaptureData(a.capture) && <Badge tone="slate">no field notes</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-slate-500">
            {a.starts_at && <span>{formatDateTimeTz(a.starts_at, tz)}</span>}
            {who && <span>· {who}</span>}
            {a.location && (
              <span className="inline-flex items-center gap-0.5">
                <MapPin className="h-3.5 w-3.5 shrink-0" /> {a.location}
              </span>
            )}
          </div>
        </Link>
      </div>
      {writeUp && (
        <Link href={estimateHref} className="shrink-0">
          <Button size="sm">
            <FileText className="h-4 w-4" /> Create estimate
          </Button>
        </Link>
      )}
    </li>
  );
}
