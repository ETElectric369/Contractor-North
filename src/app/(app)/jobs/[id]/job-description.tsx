"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { updateJobDescription } from "../actions";

/** Inline-editable job description right on the Overview tab — a quick free-text
 *  field for scope/context, always visible, saved in place.
 *
 *  Staff edit it. A tech READS it (viewerIsStaff=false): the save behind this box is
 *  staff-only at the policy (jobs_write) AND the action (requireStaff), so rendering the
 *  textarea for him was a trap — Brian typed a materials note into it and watched Save
 *  refuse. The text stays (it's his scope), the form goes, and the one thing he was
 *  actually trying to do points at the door that works for him: the Materials tab,
 *  which is now his list too (cn-v945). */
export function JobDescription({
  jobId,
  description,
  viewerIsStaff = true,
}: {
  jobId: string;
  description: string | null;
  viewerIsStaff?: boolean;
}) {
  const [value, setValue] = useState(description ?? "");
  // Local baseline (not the prop): the server trims on save, so comparing the
  // typed value against the revalidated prop could read as forever-dirty.
  const [savedValue, setSavedValue] = useState(description ?? "");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = value !== savedValue;

  if (!viewerIsStaff) {
    return (
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Description</div>
        {description?.trim() ? (
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{description}</p>
        ) : (
          // The empty state is a sentence, not a form — nothing here invites typing.
          <p className="mt-1 text-sm text-slate-400">The office hasn&rsquo;t written one yet.</p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Need materials? Add them on the{" "}
          <Link href={`/jobs/${jobId}?tab=materials`} className="font-medium text-brand hover:underline">
            Materials Tab
          </Link>
          .
        </p>
      </div>
    );
  }

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
