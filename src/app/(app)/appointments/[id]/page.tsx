import { notFound } from "next/navigation";
import { SettleUpButton } from "@/components/settle-up-button";
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
import { MarkCompleteButton } from "./mark-complete-button";
import { DeleteEmptyInspectionButton } from "./delete-empty-button";
import { hasCaptureData } from "@/lib/inspections";
import { ApptQuickActions } from "../appointment-status";
import { IntakeFiles } from "../../leads/intake-files";
import { intakePaths } from "@/lib/playbook/uploads";
import { parsePlanBrief } from "@/lib/plan-brief";

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
  // Who's looking — stamped onto anything the inspection sheet queues offline, so a shared phone
  // can never file one person's work under another's name.
  const { data: { user: viewer } } = await supabase.auth.getUser();
  const viewerId = viewer?.id ?? null;

  const [{ data: appt }, { data: org }, picker, sheets, inspection, priceBook] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, org_id, type, title, status, starts_at, ends_at, job_id, assigned_to, location, notes, customer_id, inquiry_id, capture, customers(name), inquiries(name, phone, intake)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    // Jobs/customers/staff option lists for the Edit-details modal (the same
    // SSOT helper the schedule's picker uses).
    getSchedulePickerOptions(supabase),
    // The org's inspection sheets + this appointment's answers (0165). BOTH are read tolerantly:
    // a deploy lands before its migration, and a select naming a column that doesn't exist yet
    // fails the entire query rather than degrading. Pre-migration, the sheet is simply absent and
    // the rest of the page — notes, photos, edit, mark-complete — still works.
    // Per-trade questions are DATA (deck questions for the deck company, panel questions for the
    // electrician), which is what keeps a typed inspection from needing a code module per trade.
    tolerateMissingColumns<InspectionTemplate[]>(() =>
      supabase.from("forms").select("id, name, schema, playbook").eq("is_inspection", true).order("name"),
    ),
    tolerateMissingColumns<{ inspection_template_id: string | null; inspection_answers: unknown }>(() =>
      supabase.from("appointments").select("inspection_template_id, inspection_answers").eq("id", id).maybeSingle(),
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
  ]);
  if (!appt) notFound();

  const orgSettings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const tz = orgSettings.timezone;
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
          {/* A cancelled appointment showed NO chip at all, so the page looked identical to a
              live one — which is half of why "can't cancel inspection" reads as broken. */}
          {a.status === "cancelled" && <Badge tone="slate">cancelled</Badge>}
          {/* Status affordance: flips scheduled/proposed → completed so the Inspections
              tab's buckets work (a captured walk-through stops reading as "upcoming"). */}
          {/* THE MONEY DOOR — but not on an inspection. Erik: "i dont need a pay now button on
              the inspection page." An inspection's money path IS the estimate; Pay now there was
              noise. It stays on the visit types where work happens and money changes hands on the
              spot (a legacy service_call/job appointment — new ones become real jobs at booking,
              and pay from the job page). */}
          {a.status !== "cancelled" && !isInspectionType(a.type) && (
            <SettleUpButton
              source="appointment"
              id={a.id}
              methods={orgSettings.payment_methods}
              venmoConfigured={Boolean(orgSettings.venmo_handle?.trim())}
            />
          )}
          {(a.status === "scheduled" || a.status === "proposed") && (
            <MarkCompleteButton
              id={a.id}
              label={isInspectionType(a.type) ? "Mark inspection complete" : "Mark complete"}
            />
          )}
          {/* DELETE, for a visit that never happened. Erik cancelled one at 01:08 and made
              another at 01:10 because the ✗ he tapped said "Cancel" and left the row on his
              screen. Offered ONLY when nothing was captured — see delete-empty-button.tsx for
              why a walk-through with real data stays behind Edit Details. */}
          {!hasCaptureData(a.capture) &&
            !(inspection?.inspection_answers && JSON.stringify(inspection.inspection_answers) !== "{}") && (
              <DeleteEmptyInspectionButton
                id={a.id}
                afterHref={dayStr ? `/schedule?view=day&date=${dayStr}` : "/schedule"}
              />
            )}
          {/* CANCEL — the filed bug. This page offered only "Mark complete" (a lie, if it never
              happened) and Delete (which destroys the capture and photos with it). The verb
              already existed and was wired up on the calendar row only; it belongs here too. */}
          {(a.status === "scheduled" || a.status === "proposed") && (
            <ApptQuickActions id={a.id} status={a.status} title={a.title ?? "this appointment"} />
          )}
          {/* Postponed-indefinitely is a real answer: back to the waiting board, date cleared,
              everything else kept. Only shown while a date exists to clear. */}
          {(a.status === "scheduled" || a.status === "proposed") && a.starts_at && (
            <UnscheduleButton id={a.id} />
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
        {/* What the customer attached at intake — the plans this walk-through prices from. The
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
      <Inspector
        appointmentId={a.id}
        orgId={a.org_id}
        userId={viewerId}
        templates={sheets ?? []}
        priceBook={(priceBook ?? []).map((p) => ({
          code: p.code,
          description: p.description ?? "",
          unit: p.unit ?? "EA",
          price: Number(p.buy_price ?? 0),
        }))}
        initialTemplateId={inspection?.inspection_template_id ?? null}
        initialAnswers={(inspection?.inspection_answers ?? {}) as never}
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
        estimateHref={`/quotes/new?capture=${a.id}${a.inquiry_id ? `&inquiry=${a.inquiry_id}` : ""}`}
        // The linked lead's preliminary plan report — parsed server-side so the card is in the
        // initial HTML (Zone A must not grow after mount). Ready briefs only; the lead row owns
        // the pending/failed lifecycle.
        planBrief={
          a.inquiry_id
            ? (() => {
                const b = parsePlanBrief((a.inquiries as { intake?: unknown } | null)?.intake);
                return b?.status === "ready" ? b : null;
              })()
            : null
        }
      />
    </div>
  );
}
