"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Upload, Loader2, ImageOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { prepareImageForUpload } from "@/lib/image-prep";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

type Photo = { url: string; caption?: string };

/** The public homepage editor — headline, tagline, highlights, and the HERO image. The hero is now
 *  a visual picker (preview + upload + pick-from-portfolio) instead of a raw URL field, so restoring
 *  or swapping the top image is one click. `portfolio`/`orgId` power the picker + upload. */
export function SplashSettings({ settings, portfolio = [], orgId }: { settings: OrgSettings; portfolio?: Photo[]; orgId?: string }) {
  const [headline, setHeadline] = useState(settings.splash_headline);
  const [tagline, setTagline] = useState(settings.splash_tagline);
  const [bg, setBg] = useState(settings.splash_bg_url);
  const [bullets, setBullets] = useState(settings.splash_bullets);
  const [credentials, setCredentials] = useState(settings.splash_credentials);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function save() {
    setDone(false);
    start(async () => {
      await updateOrgSettings({ splash_headline: headline, splash_tagline: tagline, splash_bg_url: bg, splash_bullets: bullets, splash_credentials: credentials }, orgId);
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  async function onHeroFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = (e.target.files ?? [])[0];
    if (!f || !f.type.startsWith("image/") || !orgId) return;
    setError(null);
    setUploading(true);
    try {
      const file = await prepareImageForUpload(f);
      const ext = file.type === "image/png" ? "png" : "jpg";
      const path = `${orgId}/hero-${Date.now()}.${ext}`;
      const supabase = createClient();
      const { error: upErr } = await supabase.storage.from("branding").upload(path, file, { upsert: true, cacheControl: "3600" });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("branding").getPublicUrl(path);
      setBg(data.publicUrl); // still needs Save to publish — keeps one clear commit point
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Controls the top of your homepage — the hero image and the headline over it.</p>

      {/* HERO IMAGE picker */}
      <div>
        <Label>Hero image (top of the page)</Label>
        <div className="mt-1 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
          {bg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bg} alt="Current hero" className="aspect-[16/7] w-full object-cover" />
          ) : (
            <div className="flex aspect-[16/7] w-full items-center justify-center text-sm text-slate-400">
              <ImageOff className="mr-2 h-4 w-4" /> No hero image — a clean branded gradient shows instead.
            </div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onHeroFile} />
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? "Uploading…" : "Upload hero"}
          </Button>
          {bg && (
            <Button type="button" variant="outline" size="sm" onClick={() => setBg("")} className="text-slate-500">
              Clear
            </Button>
          )}
        </div>
        {portfolio.length > 0 && (
          <div className="mt-2">
            <p className="mb-1 text-xs text-slate-400">Or pick from your portfolio photos:</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {portfolio.filter((p) => p.url).map((p) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => setBg(p.url)}
                  title={p.caption || "Use as hero"}
                  className={`relative h-14 w-20 shrink-0 overflow-hidden rounded-md border-2 ${bg === p.url ? "border-brand" : "border-transparent hover:border-slate-300"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={p.caption || ""} className="h-full w-full object-cover" />
                  {bg === p.url && <span className="absolute right-0.5 top-0.5 rounded-full bg-brand p-0.5 text-white"><Check className="h-3 w-3" /></span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div>
        <Label htmlFor="sp-headline">Headline</Label>
        <Input id="sp-headline" value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="e.g. High-End Custom Lighting" />
      </div>
      <div>
        <Label htmlFor="sp-tagline">Tagline</Label>
        <Input id="sp-tagline" value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="e.g. Design & fabrication for distinctive spaces" />
      </div>
      <div>
        <Label htmlFor="sp-bullets">Highlights (one per line)</Label>
        <Textarea id="sp-bullets" rows={3} value={bullets} onChange={(e) => setBullets(e.target.value)} placeholder={"All phases of electrical infrastructure\nComplex troubleshooting\nCustom lighting design & fabrication"} />
      </div>
      <div>
        <Label htmlFor="sp-cred">Below-contact lines (one per line)</Label>
        <Textarea id="sp-cred" rows={3} value={credentials} onChange={(e) => setCredentials(e.target.value)} placeholder={"Serving Tahoe · Truckee · Sierra Valley, CA\nLicensed · Bonded · Insured\nCA C-10 License #1156091"} />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending || uploading}>{pending ? "Saving…" : "Save Homepage"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
