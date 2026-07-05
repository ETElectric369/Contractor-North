"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { setPublicHandle, updateOrgSettings } from "./actions";

/**
 * The "your website address" editor: the public handle (its /site/<handle> URL, checked unique),
 * the service-area label, and the Instagram handle. Headline/tagline/services/hero live in the
 * Splash editor and colour/logo in Company details — this is the piece that names + publishes it.
 */
export function WebsiteSettings({ settings, siteUrl }: { settings: OrgSettings; siteUrl: string }) {
  const [handle, setHandle] = useState(settings.public_handle ?? "");
  const [area, setArea] = useState(settings.service_area ?? "");
  const [ig, setIg] = useState(settings.social_instagram ?? "");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = (siteUrl || "https://contractor-north.vercel.app").replace(/\/$/, "");
  const liveUrl = handle ? `${base}/site/${handle}` : "";

  function save() {
    setError(null);
    setDone(false);
    start(async () => {
      const h = await setPublicHandle(handle);
      if (!h.ok) { setError(h.error ?? "Couldn't save the address."); return; }
      setHandle(h.handle ?? "");
      const res = await updateOrgSettings({ service_area: area.trim(), social_instagram: ig.replace(/^@/, "").trim() });
      if (!res.ok) { setError(res.error ?? "Couldn't save."); return; }
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Your public website — a full marketing page with your work, services, and an estimate button.
        {handle ? " It's live at:" : " Pick an address to publish it."}
      </p>

      {handle && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <Globe className="h-4 w-4 text-slate-400" />
          <code className="break-all text-sm text-slate-700">{liveUrl}</code>
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
          >
            View your site <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      <div>
        <Label htmlFor="ws-handle">Web address</Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-400">{base}/site/</span>
          <Input
            id="ws-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="your-company"
            className="max-w-[220px]"
          />
        </div>
        <p className="mt-1 text-xs text-slate-400">Letters, numbers, and hyphens. This becomes your site&apos;s address.</p>
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

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save website"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
