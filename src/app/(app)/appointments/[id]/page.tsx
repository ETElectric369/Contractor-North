import { notFound } from "next/navigation";
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
import { InspectionCapture, type CapturePhoto } from "./inspection-capture";
import { MarkCompleteButton } from "./mark-complete-button";

export const dynamic = "force-dynamic";

/**
 * The appointment CAPTURE surface — where an inspection walk-through gets its
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

  const [{ data: appt }, { data: org }, picker] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, org_id, type, title, status, starts_at, ends_at, job_id, assigned_to, location, notes, customer_id, inquiry_id, capture, customers(name), inquiries(name, phone)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    // Jobs/customers/staff option lists for the Edit-details modal (the same
    // SSOT helper the schedule's picker uses).
    getSchedulePickerOptions(supabase),
  ]);
  if (!appt) notFound();

  const tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
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
      <BackLink fallback={dayStr ? `/schedule?view=day&date=${dayStr}` : "/schedule"} fallbackLabel="Back to Schedule" />

      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="blue" className={isInspectionType(a.type) ? "bg-teal-100 text-teal-800" : undefined}>
            {appointmentTypeLabel(a.type)}
          </Badge>
          {a.status === "proposed" && <Badge tone="amber">pending pick</Badge>}
          {a.status === "completed" && <Badge tone="green">done</Badge>}
          {/* Status affordance: flips scheduled/proposed → completed so the Inspections
              tab's buckets work (a captured walk-through stops reading as "upcoming"). */}
          {(a.status === "scheduled" || a.status === "proposed") && (
            <MarkCompleteButton
              id={a.id}
              label={isInspectionType(a.type) ? "Mark inspection complete" : "Mark complete"}
            />
          )}
          {/* Edit details — the shared appointment modal, prefilled (Erik 7/15:
              "need a way to edit inspection/appointment details"). */}
          <AppointmentButton
            jobs={picker.jobOpts}
            customers={picker.custOpts}
            staff={picker.staffOpts}
            appointment={apptValue}
            editLabel="Edit Details"
            afterDeleteHref={dayStr ? `/schedule?view=day&date=${dayStr}` : "/schedule"}
          />
        </div>
        <h1 className="mt-2 text-xl font-bold text-slate-900">{a.title}</h1>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-slate-500">
          {a.starts_at && <span>{formatDateTimeTz(a.starts_at, tz)}</span>}
          {who && <span>· {who}</span>}
          {a.location && (
            <NavLink address={a.location} className="inline-flex items-center gap-0.5 text-brand hover:underline">
              <MapPin className="h-3.5 w-3.5" /> {a.location}
            </NavLink>
          )}
        </div>
        {a.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{a.notes}</p>}
      </div>

      <InspectionCapture
        appointmentId={a.id}
        orgId={a.org_id}
        inquiryId={a.inquiry_id ?? null}
        initial={{
          notes: capture.notes ?? "",
          measurements: capture.measurements ?? "",
          materials: capture.materials ?? "",
        }}
        initialPhotos={photos}
      />
    </div>
  );
}
