import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, formatDateTimeTz } from "@/lib/tz";
import { Badge } from "@/components/ui/badge";
import { NavLink } from "@/components/nav-link";
import { InspectionCapture, type CapturePhoto } from "./inspection-capture";

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

  const [{ data: appt }, { data: org }] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, org_id, type, title, status, starts_at, location, notes, customer_id, inquiry_id, capture, customers(name), inquiries(name, phone)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
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

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href={dayStr ? `/schedule?view=day&date=${dayStr}` : "/schedule"}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4 shrink-0" /> Back to Schedule
      </Link>

      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="blue" className={a.type === "inspection" ? "bg-teal-100 text-teal-800" : undefined}>
            {a.type}
          </Badge>
          {a.status === "proposed" && <Badge tone="amber">pending pick</Badge>}
          {a.status === "completed" && <Badge tone="green">done</Badge>}
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
