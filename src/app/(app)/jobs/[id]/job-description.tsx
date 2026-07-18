"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { updateJobDescription } from "../actions";

/** Inline-editable job description right on the Overview tab — a quick free-text
 *  field for scope/context, always visible, saved in place. */
export function JobDescription({ jobId, description }: { jobId: string; description: string | null }) {
  const [value, setValue] = useState(description ?? "");
  // Local baseline (not the prop): the server trims on save, so comparing the
  // typed value against the revalidated prop could read as forever-dirty.
  const [savedValue, setSavedValue] = useState(description ?? "");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = value !== savedValue;

  function save() {
    setDone(false);
    setError(null);
    start(async () => {
      const res = await updateJobDescription(jobId, value);
      if (!res.ok) {
        // Stay dirty on failure so the Save affordance can't vanish over unsaved text.
        setError(res.error ?? "Could not save.");
        return;
      }
      setSavedValue(value);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    });
  }

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Description</div>
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="What's this job? Scope, context, anything worth noting…"
        className="mt-1 min-h-[72px]"
      />
      <div className="mt-2 flex items-center gap-2">
        {/* Save only appears once there's something to save — the dirty pattern
            the other inline editors use (e.g. the circuit schedule card). */}
        {(dirty || pending) && (
          <Button size="sm" onClick={save} disabled={pending || !dirty}>
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        )}
        {done && !dirty && !pending && (
          <span className="flex items-center gap-1 text-xs font-medium text-green-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
        {dirty && !pending && <span className="text-xs text-slate-400">Unsaved</span>}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}
