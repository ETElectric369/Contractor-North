import { notFound } from "next/navigation";
import { Phone, Mail, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { InquiryForm } from "./inquiry-form";

export const dynamic = "force-dynamic";

export default async function InquirePage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_org", { p_org: org });
  const o = (data ?? null) as any;
  if (!o || !o.name) notFound();

  const brand = o.brand_color || "#0b57c4";

  return (
    <div
      className="min-h-screen px-4 py-10"
      style={{ background: `linear-gradient(160deg, ${brand}22, ${brand}05 60%, #f8fafc)` }}
    >
      <div className="mx-auto grid max-w-4xl items-center gap-8 md:grid-cols-2 md:py-16">
        <div>
          {o.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.logo_url} alt={o.name} className="mb-4 h-14 w-auto" />
          ) : null}
          <div className="inline-block rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white" style={{ backgroundColor: brand }}>
            New website coming soon
          </div>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-slate-900">{o.name}</h1>
          <p className="mt-3 text-lg text-slate-600">
            We're building our new site — but we're open for business and taking new jobs now.
            Send a request and we'll get right back to you.
          </p>
          <div className="mt-5 space-y-1.5 text-sm text-slate-600">
            {o.phone && (
              <a href={`tel:${o.phone}`} className="flex items-center gap-2 hover:text-slate-900">
                <Phone className="h-4 w-4" style={{ color: brand }} /> {o.phone}
              </a>
            )}
            {o.email && (
              <a href={`mailto:${o.email}`} className="flex items-center gap-2 hover:text-slate-900">
                <Mail className="h-4 w-4" style={{ color: brand }} /> {o.email}
              </a>
            )}
            {(o.city || o.state) && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4" style={{ color: brand }} /> {[o.city, o.state].filter(Boolean).join(", ")}
              </div>
            )}
          </div>
        </div>

        <InquiryForm org={org} brandColor={brand} />
      </div>

      <p className="mt-10 text-center text-xs text-slate-400">Powered by Contractor North</p>
    </div>
  );
}
