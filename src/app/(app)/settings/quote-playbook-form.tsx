"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import type { OrgSettings } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";

/** Free-text quoting playbook — injected into AI quote drafts and the assistant. */
export function QuotePlaybookForm({ settings }: { settings: OrgSettings }) {
  const [text, setText] = useState(settings.quote_playbook ?? "");
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <p className="text-sm text-slate-500">
        Teach the AI how <em>you</em> quote: labor rates, markup, wire/material habits,
        what you include and exclude. Every AI estimate draft and assistant answer follows this.
      </p>
      <Textarea
        rows={14}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"e.g.\n• Lead electrician $150/hr, apprentice $75/hr — quote whole-crew hours\n• Materials marked up 25%\n• Buy full 500 ft wire rolls; leftover is shop stock\n• Size feeders for voltage drop, not just ampacity\n• Standard exclusions: permits, sales tax, equipment rental"}
      />
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save playbook"}</Button>
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
