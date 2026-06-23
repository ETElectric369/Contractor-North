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
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const dirty = value !== (description ?? "");

  function save() {
    setDone(false);
    start(async () => {
      await updateJobDescription(jobId, value);
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
        <Button size="sm" onClick={save} disabled={pending || !dirty}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : done ? <Check className="h-3.5 w-3.5" /> : null}
          {done ? "Saved" : "Save"}
        </Button>
        {dirty && !pending && <span className="text-xs text-slate-400">Unsaved</span>}
      </div>
    </div>
  );
}
