"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { setPublicHandle, setCustomDomain, updateOrgSettings } from "./actions";

const THEMES: { id: OrgSettings["site_theme"]; label: string; blurb: string; swatch: string }[] = [
  { id: "classic", label: "Classic", blurb: "Photo hero, dark overlay", swatch: "bg-gradient-to-br from-slate-600 to-slate-900" },
  { id: "bold", label: "Bold", blurb: "Brand color block", swatch: "bg-brand" },
  { id: "minimal", label: "Minimal", blurb: "Light & airy", swatch: "border border-slate-200 bg-gradient-to-b from-slate-100 to-white" },
];

/**
 * The "your website address" editor. The handle gives every org a free
 * <handle>.<sitesDomain> subdomain that's live immediately (no DNS). A custom domain is
 * optional — they enter it here and point its DNS at us. Headline/services/hero live in the
 * Splash editor; colour/logo in Company details. This piece names + publishes the site.
 */
export function WebsiteSettings({
  settings, siteUrl, sitesDomain,
}: {
  settings: OrgSettings; siteUrl: string; sitesDomain: string;
}) {
  const [handle, setHandle] = useState(settings.public_handle ?? "");
  const [area, setArea] = useState(settings.service_area ?? "");
  const [ig, setIg] = useState(settings.social_instagram ?? "");
  const [domain, setDomain] = useState(settings.custom_domain ?? "");
  const [gbp, setGbp] = useState(settings.google_business_url ?? "");
  const [calendly, setCalendly] = useState(settings.calendly_url ?? "");
  const [theme, setTheme] = useState<OrgSettings["site_theme"]>(settings.site_theme ?? "classic");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last-SAVED values — the diff baseline. Two screens (this one + the SEO/specialty fields) edit
  // the same settings keys, so each save sends ONLY the keys changed here; sending the whole form
  // would overwrite the other screen's saves with this form's stale copies.
  const [saved, setSaved] = useState({
    handle: settings.public_handle ?? "",
    domain: settings.custom_domain ?? "",
    area: settings.service_area ?? "",
    ig: settings.social_instagram ?? "",
    gbp: settings.google_business_url ?? "",
    calendly: settings.calendly_url ?? "",
    theme: settings.site_theme ?? "classic",
  });

  const base = (siteUrl || "https://contractor-north.vercel.app").replace(/\/$/, "");
  const subUrl = handle ? `https://${handle}.${sitesDomain}` : "";

  function save() {
    setError(null);
    setDone(false);
    const cal = calendly.trim();
    if (cal && !/^https:\/\//i.test(cal)) {
      setError("The scheduling link needs to be a full https:// URL.");
      return;
    }
    start(async () => {
      // Advance the baseline per successful step, so a mid-save failure never re-sends (or worse,
      // silently skips) what already landed.
      let baseSaved = saved;
      const record = (patch: Partial<typeof saved>) => { baseSaved = { ...baseSaved, ...patch }; setSaved(baseSaved); };
      if (handle.trim() !== baseSaved.handle) {
        const h = await setPublicHandle(handle);
        if (!h.ok) { setError(h.error ?? "Couldn't save the address."); return; }
        setHandle(h.handle ?? "");
        record({ handle: h.handle ?? "" });
      }
      if (domain.trim() !== baseSaved.domain) {
        // Custom domain has its own guarded, uniqueness-checked setter (not the passthrough).
        const cd = await setCustomDomain(domain);
        if (!cd.ok) { setError(cd.error ?? "Couldn't save the domain."); return; }
        setDomain(cd.domain ?? "");
        record({ domain: cd.domain ?? "" });
      }
      const next = { area: area.trim(), ig: ig.replace(/^@/, "").trim(), gbp: gbp.trim(), calendly: cal, theme };
      const patch: Record<string, unknown> = {};
      if (next.area !== baseSaved.area) patch.service_area = next.area;
      if (next.ig !== baseSaved.ig) patch.social_instagram = next.ig;
      if (next.theme !== baseSaved.theme) patch.site_theme = next.theme;
      if (next.gbp !== baseSaved.gbp) patch.google_business_url = next.gbp;
      if (next.calendly !== baseSaved.calendly) patch.calendly_url = next.calendly;
      if (Object.keys(patch).length) {
        const res = await updateOrgSettings(patch);
        if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
        record(next);
      }
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Your public website — a full marketing page with your work, services, and an estimate button.
      </p>

      {handle && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Globe className="h-4 w-4 text-slate-400" />
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Live at</span>
            <code className="break-all text-sm font-medium text-slate-800">{subUrl.replace("https://", "")}</code>
            <a href={subUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
              View <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <p className="break-all text-xs text-slate-400">Also at {base}/site/{handle}</p>
        </div>
      )}

      <div>
        <Label htmlFor="ws-handle">Web address</Label>
        <div className="flex items-center gap-1.5">
          <Input id="ws-handle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="your-company" className="max-w-[200px]" />
          <span className="text-sm text-slate-400">.{sitesDomain}</span>
        </div>
        <p className="mt-1 text-xs text-slate-400">Your free address — live immediately, no setup.</p>
      </div>

      <div>
        <Label htmlFor="ws-domain">Custom domain (optional)</Label>
        <Input id="ws-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourcompany.com" />
        <p className="mt-1 text-xs text-slate-400">Have your own domain? Enter it here, then point its DNS to us and we&apos;ll connect it.</p>
      </div>

      <div>
        <Label htmlFor="ws-area">Service area</Label>
        <Input id="ws-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Truckee & North Tahoe" />
        <p className="mt-1 text-xs text-slate-400">Shown in the hero, trust bar, and footer.</p>
      </div>

      <div>
        <Label htmlFor="ws-gbp">Google Business Profile</Label>
        <Input id="ws-gbp" value={gbp} onChange={(e) => setGbp(e.target.value)} placeholder="https://maps.google.com/…  (your Google Maps listing)" />
        {gbp.trim() !== "" ? (
          <p className="mt-1 flex items-start gap-1 text-xs font-medium text-green-700">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Linked to your Google Business Profile — this feeds Google&apos;s structured data on every page.
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-400">
            Paste your Google Maps listing link. This ties your website to your Google listing for local
            search — the biggest lever for showing up in the map results when someone nearby searches for you.
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="ws-calendly">Scheduling link (Calendly)</Label>
        <Input id="ws-calendly" value={calendly} onChange={(e) => setCalendly(e.target.value)} placeholder="https://calendly.com/yourcompany/site-visit" />
        <p className="mt-1 text-xs text-slate-400">
          Optional. If you use Calendly (or similar), the public &quot;schedule your site visit&quot; buttons open it.
          Leave blank to use the built-in request flow — the customer asks for a visit, your office is
          pinged, and you text them a few time options.
        </p>
      </div>

      <div>
        <Label htmlFor="ws-ig">Instagram handle</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-400">@</span>
          <Input id="ws-ig" value={ig} onChange={(e) => setIg(e.target.value)} placeholder="yourcompany" className="max-w-[220px]" />
        </div>
        <p className="mt-1 text-xs text-slate-400">Leave blank to hide the Instagram link.</p>
      </div>

      <div>
        <Label>Site style</Label>
        <div className="mt-1 grid gap-2 sm:grid-cols-3">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              aria-pressed={theme === t.id}
              className={`rounded-lg border p-3 text-left transition ${theme === t.id ? "border-brand ring-1 ring-brand" : "border-slate-200 hover:border-slate-300"}`}
            >
              <span className={`mb-2 block h-10 rounded ${t.swatch}`} />
              <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                {t.label}
                {theme === t.id && <Check className="h-3.5 w-3.5 text-brand" />}
              </span>
              <span className="mt-0.5 block text-xs text-slate-400">{t.blurb}</span>
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-400">Same content, different look — so your site stands out.</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save website"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
