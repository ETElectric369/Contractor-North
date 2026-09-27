"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { orgTrade } from "@/lib/org-trade";
import { updateOrgSettings } from "./actions";

/** Free-text quoting playbook — injected into AI quote drafts and the assistant. */
export function QuotePlaybookForm({ settings }: { settings: OrgSettings }) {
  const [text, setText] = useState(settings.quote_playbook ?? "");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalog = settings.estimating_mode === "catalog";
  const electrical = orgTrade(settings).key === "electrical";

  function save() {
    setError(null);
    setDone(false);
    start(async () => {
      const res = await updateOrgSettings({ quote_playbook: text });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    });
  }

  return (
    <div className="space-y-3">
      {/* WHAT THE ESTIMATOR REALLY DOES, for THIS company (the chat route's estimating method): a
          catalog shop prices from its own list and never goes to the web, and only electrical
          work is sized by the NEC. This card told a deck builder in catalog mode about
          web-researched prices and NEC-calculated sizes. */}
      <p className="text-sm text-slate-500">
        {catalog ? (
          <>
            The AI already handles the <strong>numbers</strong>: labor at your rate (Settings → rates),
            materials and work from <em>your own</em> price list and kits, and quantities from the
            customer&apos;s measurements.
          </>
        ) : (
          <>
            The AI already handles the <strong>numbers</strong> automatically: labor at your rate (Settings →
            rates), materials at <em>current</em> web-researched prices + your buffer, and exact{" "}
            {electrical ? "NEC-calculated" : "calculated"} sizes/quantities.
          </>
        )}{" "}
        Use this box ONLY for your company&apos;s habits, inclusions/exclusions, wording,
        and special cases it can&apos;t know — <strong>don&apos;t put rates or markup here</strong> (those
        live in Settings and will override anything stale you type below).
      </p>
      <Textarea
        rows={12}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"e.g.\n• Always include a 1-year workmanship warranty line\n• Standard exclusions: permits, sales tax, equipment rental\n• What you always include, and what you never do\n• Round each estimate up to the nearest $25\n• Note a deposit due to schedule"}
      />
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save Playbook"}</Button>
        {done && (
          <span className="flex items-center gap-1 text-sm font-medium text-green-600">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
