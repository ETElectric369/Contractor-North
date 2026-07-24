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
  const [pubCity, setPubCity] = useState(settings.public_city ?? "");
  const [pubState, setPubState] = useState(settings.public_state ?? "");
  const [ig, setIg] = useState(settings.social_instagram ?? "");
  const [theme, setTheme] = useState<OrgSettings["site_theme"]>(settings.site_theme ?? "classic");
  const [specHead, setSpecHead] = useState(settings.specialty_headline ?? "");
  const [specBlurb, setSpecBlurb] = useState(settings.specialty_blurb ?? "");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last-SAVED values — the diff baseline. The Website panel edits several of these same keys, so
  // each save sends ONLY the keys changed here; sending the whole form would overwrite the other
  // panel's saves with this form's stale copies.
  const [saved, setSaved] = useState({
    gbp: settings.google_business_url ?? "",
    area: settings.service_area ?? "",
    pubCity: settings.public_city ?? "",
    pubState: settings.public_state ?? "",
    ig: settings.social_instagram ?? "",
    theme: settings.site_theme ?? "classic",
    specHead: settings.specialty_headline ?? "",
    specBlurb: settings.specialty_blurb ?? "",
  });

  function save() {
    setError(null);
    setDone(false);
    start(async () => {
      const next = {
        gbp: gbp.trim(),
        area: area.trim(),
        pubCity: pubCity.trim(),
        pubState: pubState.trim().toUpperCase().slice(0, 2),
        ig: ig.replace(/^@/, "").trim(),
        theme,
        specHead: specHead.trim(),
        specBlurb: specBlurb.trim(),
      };
      const patch: Record<string, unknown> = {};
      if (next.gbp !== saved.gbp) patch.google_business_url = next.gbp;
      if (next.area !== saved.area) patch.service_area = next.area;
      if (next.pubCity !== saved.pubCity) patch.public_city = next.pubCity;
      if (next.pubState !== saved.pubState) patch.public_state = next.pubState;
      if (next.ig !== saved.ig) patch.social_instagram = next.ig;
      if (next.theme !== saved.theme) patch.site_theme = next.theme;
      if (next.specHead !== saved.specHead) patch.specialty_headline = next.specHead;
      if (next.specBlurb !== saved.specBlurb) patch.specialty_blurb = next.specBlurb;
      if (Object.keys(patch).length) {
        const res = await updateOrgSettings(patch, orgId);
        if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
        setSaved(next);
      }
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="seo-gbp">Google Business Profile link</Label>
        <Input id="seo-gbp" value={gbp} onChange={(e) => setGbp(e.target.value)} placeholder="Paste the Google Maps link to your listing" />
        {gbp.trim() !== "" ? (
          <p className="mt-1 flex items-start gap-1 text-xs font-medium text-green-700">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Linked to your Google Business Profile — this feeds Google&apos;s structured data on every page.
          </p>
        ) : (
          <p className="mt-1 text-xs text-slate-400">The local-SEO anchor — it ties this site to your Google listing so they rank as one business.</p>
        )}
      </div>
      <div>
        <Label htmlFor="seo-area">Service area</Label>
        <Input id="seo-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Truckee & North Tahoe" />
      </div>
      {/* Staff-only (collaborators can't write these keys): the PUBLIC address for search
          listings. Kept separate from the business address on purpose — that one never
          appears on the public site. */}
      {!orgId && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="seo-pub-city">Public city (search listings)</Label>
            <Input id="seo-pub-city" value={pubCity} onChange={(e) => setPubCity(e.target.value)} placeholder="Match your Google Business Profile" />
            <p className="mt-1 text-xs text-slate-400">
              Shown to search engines as your location. Your business address in Settings stays private. Blank = no city listed.
            </p>
          </div>
          <div>
            <Label htmlFor="seo-pub-state">Public state</Label>
            <Input id="seo-pub-state" value={pubState} onChange={(e) => setPubState(e.target.value)} placeholder="CA" maxLength={2} className="max-w-[6rem]" />
          </div>
        </div>
      )}
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
