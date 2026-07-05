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
  const [theme, setTheme] = useState<OrgSettings["site_theme"]>(settings.site_theme ?? "classic");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = (siteUrl || "https://contractor-north.vercel.app").replace(/\/$/, "");
  const subUrl = handle ? `https://${handle}.${sitesDomain}` : "";

  function save() {
    setError(null);
    setDone(false);
    start(async () => {
      const h = await setPublicHandle(handle);
      if (!h.ok) { setError(h.error ?? "Couldn't save the address."); return; }
      setHandle(h.handle ?? "");
      // Custom domain has its own guarded, uniqueness-checked setter (not the passthrough).
      const cd = await setCustomDomain(domain);
      if (!cd.ok) { setError(cd.error ?? "Couldn't save the domain."); return; }
      setDomain(cd.domain ?? "");
      const res = await updateOrgSettings({ service_area: area.trim(), social_instagram: ig.replace(/^@/, "").trim(), site_theme: theme });
      if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
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
