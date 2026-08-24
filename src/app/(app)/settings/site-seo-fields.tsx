"use client";

import { useState, useTransition } from "react";
import { Check, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { classifyMapUrl, type OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

/**
 * The on-page SEO + showcase fields not covered by the splash/portfolio/reviews editors: the
 * Google Business Profile link (the local-SEO anchor), service area, the signature-specialty
 * showcase, Instagram, and the site theme. Shared by the staff Settings page and the external
 * collaborator's /content workspace (orgId names which site for a collaborator).
 */
export function SiteSeoFields({ settings, orgId }: { settings: OrgSettings; orgId?: string }) {
  const [gbp, setGbp] = useState(settings.google_business_url ?? "");
  const [reviewUrl, setReviewUrl] = useState(settings.google_review_url ?? "");
  const [sab, setSab] = useState(settings.service_area_business === true);
  const gbpVerdict = classifyMapUrl(gbp);
  const [area, setArea] = useState(settings.service_area ?? "");
  const [pubAddr, setPubAddr] = useState(settings.public_address ?? "");
  const [pubCity, setPubCity] = useState(settings.public_city ?? "");
  const [pubState, setPubState] = useState(settings.public_state ?? "");
  const [pubZip, setPubZip] = useState(settings.public_zip ?? "");
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
    reviewUrl: settings.google_review_url ?? "",
    sab: settings.service_area_business === true,
    area: settings.service_area ?? "",
    pubAddr: settings.public_address ?? "",
    pubCity: settings.public_city ?? "",
    pubState: settings.public_state ?? "",
    pubZip: settings.public_zip ?? "",
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
        reviewUrl: reviewUrl.trim(),
        sab,
        area: area.trim(),
        pubAddr: pubAddr.trim(),
        pubCity: pubCity.trim(),
        pubState: pubState.trim().toUpperCase().slice(0, 2),
        pubZip: pubZip.trim(),
        ig: ig.replace(/^@/, "").trim(),
        theme,
        specHead: specHead.trim(),
        specBlurb: specBlurb.trim(),
      };
      const patch: Record<string, unknown> = {};
      if (next.gbp !== saved.gbp) patch.google_business_url = next.gbp;
      if (next.reviewUrl !== saved.reviewUrl) patch.google_review_url = next.reviewUrl;
      if (next.sab !== saved.sab) patch.service_area_business = next.sab;
      if (next.area !== saved.area) patch.service_area = next.area;
      if (next.pubCity !== saved.pubCity) patch.public_city = next.pubCity;
      if (next.pubState !== saved.pubState) patch.public_state = next.pubState;
      if (next.pubAddr !== saved.pubAddr) patch.public_address = next.pubAddr;
      if (next.pubZip !== saved.pubZip) patch.public_zip = next.pubZip;
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
        {gbpVerdict === "ok" && (
          <p className="mt-1 flex items-start gap-1 text-xs font-medium text-green-700">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Linked, with map coordinates — this feeds Google&apos;s structured data on every page.
          </p>
        )}
        {gbpVerdict === "no-coords" && (
          <p className="mt-1 flex items-start gap-1 text-xs font-medium text-green-700">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Linked. For the stronger signal, paste the full Maps link instead of the short one — it
            carries your pin&apos;s coordinates.
          </p>
        )}
        {gbpVerdict === "personalized-search" && (
          <p className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            That&apos;s a Google <em>search</em> link, not your listing — Google can&apos;t match it to your
            business, so no coordinates are published. Open your listing in Google Maps → Share →
            Copy link. (A link containing <code>authuser=</code> is personal to you and shows a
            stale page to customers.)
          </p>
        )}
        {gbpVerdict === "not-google" && (
          <p className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            That doesn&apos;t look like a Google link. Open your listing in Google Maps → Share → Copy link.
          </p>
        )}
        {gbpVerdict === "empty" && (
          <p className="mt-1 text-xs text-slate-400">The local-SEO anchor — it ties this site to your Google listing so they rank as one business.</p>
        )}
      </div>

      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={sab}
          onChange={(e) => setSab(e.target.checked)}
        />
        <span className="text-sm">
          <span className="font-medium text-slate-800">We serve an area, not a storefront</span>
          <span className="mt-0.5 block text-xs text-slate-500">
            Tick this if your Google listing is set up as a service-area business — the kind that hides your address
            because customers don&apos;t come to you. We&apos;ll publish your service area to Google and stop
            publishing map coordinates, which otherwise pin you to wherever your listing used to sit (often the
            house). Your listing link still binds this site to your profile either way.
          </span>
        </span>
      </label>

      <div>
        <Label htmlFor="seo-review">Google review link (optional)</Label>
        <Input
          id="seo-review"
          value={reviewUrl}
          onChange={(e) => setReviewUrl(e.target.value)}
          placeholder="https://g.page/r/…/review"
        />
        <p className="mt-1 text-xs text-slate-500">
          Where your &ldquo;Review us on Google&rdquo; button sends people. The Business Profile link above opens your
          LISTING — the customer still has to find the review box. Google gives you a direct one: Business Profile
          &rarr; <span className="font-medium">Ask for reviews</span> &rarr; copy the link (it looks like
          g.page/r/…/review). Leave this empty and the button keeps using the profile link.
        </p>
      </div>
      <div>
        <Label htmlFor="seo-area">Service area</Label>
        <Input id="seo-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Truckee & North Tahoe" />
      </div>
      {/* Staff-only (collaborators can't write these keys). Whether to publish an address, and how
          much of one, is the OWNER'S decision — a shop or a yard is worth listing in full; a truck
          run out of the house is not. These fields are the only source for anything public, and
          the business address in Settings → Company is never published at any level of detail. */}
      {!orgId && (
        <div className="space-y-3 rounded-lg border border-slate-200 p-3">
          <div>
            <Label htmlFor="seo-pub-addr">Public address (optional)</Label>
            <Input id="seo-pub-addr" value={pubAddr} onChange={(e) => setPubAddr(e.target.value)} placeholder="e.g. 1200 Donner Pass Rd — leave blank if you work out of your home" />
            <p className="mt-1 text-xs text-slate-500">
              Fill this in <strong>only</strong> if you have a shop, yard or office you want customers
              to find. Publishing a full address helps local search when the address is real and matches
              your Google listing. Leave it blank and only the city and state below are published.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label htmlFor="seo-pub-city">Public city</Label>
              <Input id="seo-pub-city" value={pubCity} onChange={(e) => setPubCity(e.target.value)} placeholder="Match your Google Business Profile" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:col-span-1">
              <div>
                <Label htmlFor="seo-pub-state">State</Label>
                <Input id="seo-pub-state" value={pubState} onChange={(e) => setPubState(e.target.value)} placeholder="CA" maxLength={2} />
              </div>
              <div>
                <Label htmlFor="seo-pub-zip">ZIP</Label>
                <Input id="seo-pub-zip" value={pubZip} onChange={(e) => setPubZip(e.target.value)} placeholder="96161" maxLength={10} />
              </div>
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Only what you type here is published. Your business address in Settings &rarr; Company is
            used for invoices and stays private — it is never a fallback for any of these.
          </p>
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
