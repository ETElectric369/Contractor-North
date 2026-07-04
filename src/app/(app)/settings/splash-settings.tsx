"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

export function SplashSettings({ settings }: { settings: OrgSettings }) {
  const [headline, setHeadline] = useState(settings.splash_headline);
  const [tagline, setTagline] = useState(settings.splash_tagline);
  const [bg, setBg] = useState(settings.splash_bg_url);
  const [bullets, setBullets] = useState(settings.splash_bullets);
  const [credentials, setCredentials] = useState(settings.splash_credentials);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  function save() {
    setDone(false);
    start(async () => {
      await updateOrgSettings({ splash_headline: headline, splash_tagline: tagline, splash_bg_url: bg, splash_bullets: bullets, splash_credentials: credentials });
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Controls the public inquiry / splash page (above).</p>
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
      <div>
        <Label htmlFor="sp-bg">Background image URL</Label>
        <Input id="sp-bg" value={bg} onChange={(e) => setBg(e.target.value)} placeholder="/et-electric-hero.jpg or https://…" />
        <p className="mt-1 text-xs text-slate-400">Leave blank for a clean branded gradient.</p>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save Splash"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
