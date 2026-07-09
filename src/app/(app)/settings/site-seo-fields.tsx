"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

/**
 * The on-page SEO + showcase fields not covered by the splash/portfolio/reviews editors: the
 * Google Business Profile link (the local-SEO anchor), service area, the signature-specialty
 * showcase, Instagram, and the site theme. Shared by the staff Settings page and the external
 * collaborator's /content workspace (orgId names which site for a collaborator).
 */
export function SiteSeoFields({ settings, orgId }: { settings: OrgSettings; orgId?: string }) {
  const [gbp, setGbp] = useState(settings.google_business_url ?? "");
  const [area, setArea] = useState(settings.service_area ?? "");
  const [ig, setIg] = useState(settings.social_instagram ?? "");
  const [theme, setTheme] = useState<OrgSettings["site_theme"]>(settings.site_theme ?? "classic");
  const [specHead, setSpecHead] = useState(settings.specialty_headline ?? "");
  const [specBlurb, setSpecBlurb] = useState(settings.specialty_blurb ?? "");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    setDone(false);
    start(async () => {
      const res = await updateOrgSettings(
        {
          google_business_url: gbp.trim(),
          service_area: area.trim(),
          social_instagram: ig.replace(/^@/, "").trim(),
          site_theme: theme,
          specialty_headline: specHead.trim(),
          specialty_blurb: specBlurb.trim(),
        },
        orgId,
      );
      if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="seo-gbp">Google Business Profile link</Label>
        <Input id="seo-gbp" value={gbp} onChange={(e) => setGbp(e.target.value)} placeholder="Paste the Google Maps link to your listing" />
        <p className="mt-1 text-xs text-slate-400">The local-SEO anchor — it ties this site to your Google listing so they rank as one business.</p>
      </div>
      <div>
        <Label htmlFor="seo-area">Service area</Label>
        <Input id="seo-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Truckee & North Tahoe" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="seo-ig">Instagram handle</Label>
          <Input id="seo-ig" value={ig} onChange={(e) => setIg(e.target.value)} placeholder="handle (no @)" />
        </div>
        <div>
          <Label htmlFor="seo-theme">Site theme</Label>
          <Select id="seo-theme" value={theme} onChange={(e) => setTheme(e.target.value as OrgSettings["site_theme"])}>
            <option value="classic">Classic — full-bleed photo hero</option>
            <option value="bold">Bold — brand color block</option>
            <option value="minimal">Minimal — light & editorial</option>
          </Select>
        </div>
      </div>
      <div className="border-t border-slate-100 pt-3">
        <Label htmlFor="seo-spec-head">Signature specialty — headline</Label>
        <Input id="seo-spec-head" value={specHead} onChange={(e) => setSpecHead(e.target.value)} placeholder="e.g. Custom Lighting Design & Fabrication (blank = hide the showcase)" />
        <Label htmlFor="seo-spec-blurb" className="mt-2">Specialty — blurb</Label>
        <Textarea id="seo-spec-blurb" rows={2} value={specBlurb} onChange={(e) => setSpecBlurb(e.target.value)} placeholder="One or two sentences on the thing you most want to be known for." />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
