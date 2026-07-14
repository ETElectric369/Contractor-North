import { notFound } from "next/navigation";
import { Phone, Mail, MapPin, Zap } from "lucide-react";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { accentHex, getOrgSettings } from "@/lib/org-settings";
import { InquiryForm } from "./inquiry-form";

export const dynamic = "force-dynamic";

export default async function InquirePage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams?: Promise<{ ref?: string }> }) {
  const { org } = await params;
  // Referral attribution ("Brian at the bar"): an employee's shared link carries ?ref={profile_id}.
  // Validated server-side in submit_inquiry (must be a profile in this org) — pass through as-is.
  const refRaw = (await searchParams)?.ref ?? "";
  const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(refRaw) ? refRaw : null;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_org", { p_org: org });
  const o = (data ?? null) as any;
  if (!o || !o.name) notFound();

  // The post-submit "schedule your site visit" hand-off: Calendly when the org
  // configured one, else North's built-in 3-slot /pick flow. The public_org RPC
  // doesn't carry settings, so read them with the service client (org id was
  // just validated above). https-only — anything else is treated as unset.
  const { data: orgRow } = await createServiceClient()
    .from("organizations")
    .select("settings")
    .eq("id", org)
    .maybeSingle();
  const rawCalendly = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).calendly_url;
  const calendlyUrl = /^https:\/\//i.test(rawCalendly) ? rawCalendly : "";

  const brand = accentHex((o as { glass_tint?: string } | null)?.glass_tint);
  const bg = o.splash_bg_url || "";
  const headline = o.splash_headline || o.name;
  const tagline = o.splash_tagline || "";
  const bullets = String(o.splash_bullets || "")
    .split("\n")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const credLines = String(o.splash_credentials || "")
    .split("\n")
    .map((s: string) => s.trim())
    .filter(Boolean);

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* Background */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={
          bg
            ? { backgroundImage: `url(${bg})` }
            : { background: `linear-gradient(160deg, ${brand}22, ${brand}05 60%, #f8fafc)` }
        }
      />
      {bg && (
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(90deg, rgba(2,6,23,.66), rgba(2,6,23,.18) 48%, rgba(2,6,23,.30))" }}
        />
      )}

      <div className="relative mx-auto grid min-h-screen max-w-5xl items-end gap-8 px-4 pb-[14vh] pt-[10vh] md:grid-cols-2">
        <div className={bg ? "text-white" : ""} style={bg ? { textShadow: "0 1px 6px rgba(0,0,0,.65)" } : undefined}>
          {!bg && o.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.logo_url} alt={o.name} className="mb-4 h-14 w-auto" />
          ) : null}
          <div className="inline-block rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white shadow" style={{ backgroundColor: brand }}>
            {o.name} · Now booking
          </div>
          <h1 className={`mt-3 text-2xl font-extrabold tracking-tight sm:text-3xl ${bg ? "text-white drop-shadow" : "text-slate-900"}`}>
            {headline}
          </h1>
          {tagline && (
            <p className={`mt-3 text-xl font-medium ${bg ? "text-slate-100" : "text-slate-700"}`}>{tagline}</p>
          )}
          {bullets.length === 0 && (
            <p className={`mt-3 text-base ${bg ? "text-slate-200" : "text-slate-600"}`}>
              Our new site is on the way — but we're open for business and taking new projects now.
              Send a request and we'll get right back to you.
            </p>
          )}
          {bullets.length > 0 && (
            <ul className="mt-4 space-y-2">
              {bullets.map((b: string, i: number) => (
                <li key={i} className={`flex items-center gap-2 text-base font-semibold ${bg ? "text-white" : "text-slate-800"}`}>
                  <Zap className="h-4 w-4 shrink-0" style={{ color: bg ? "#fde68a" : brand }} /> {b}
                </li>
              ))}
            </ul>
          )}
          <div className={`mt-5 space-y-1.5 text-sm ${bg ? "text-slate-100" : "text-slate-600"}`}>
            {o.phone && (
              <a href={`tel:${o.phone}`} className="flex items-center gap-2 hover:opacity-80">
                <Phone className="h-4 w-4" style={{ color: bg ? "#fff" : brand }} /> {o.phone}
              </a>
            )}
            {o.email && (
              <a href={`mailto:${o.email}`} className="flex items-center gap-2 hover:opacity-80">
                <Mail className="h-4 w-4" style={{ color: bg ? "#fff" : brand }} /> {o.email}
              </a>
            )}
            {(o.city || o.state) && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4" style={{ color: bg ? "#fff" : brand }} /> {[o.city, o.state].filter(Boolean).join(", ")}
              </div>
            )}
          </div>
          {credLines.length > 0 && (
            <ul className={`mt-3 space-y-1.5 text-sm ${bg ? "text-slate-100" : "text-slate-600"}`}>
              {credLines.map((line: string, i: number) => (
                <li key={i} className="flex items-center gap-2">
                  <Zap className="h-3.5 w-3.5 shrink-0" style={{ color: bg ? "#fde68a" : brand }} /> {line}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="w-full md:max-w-sm md:justify-self-end md:translate-x-4 lg:translate-x-10">
          <InquiryForm org={org} brandColor={brand} refId={ref} calendlyUrl={calendlyUrl} />
        </div>
      </div>

      <p className={`relative pb-6 text-center text-xs ${bg ? "text-slate-300" : "text-slate-400"}`}>Powered by Contractor North</p>
    </div>
  );
}
