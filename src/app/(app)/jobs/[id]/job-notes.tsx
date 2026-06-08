"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { updateJobNotes } from "../actions";

export function JobNotes({ jobId, notes }: { jobId: string; notes: string | null }) {
  const [value, setValue] = useState(notes ?? "");
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  function save() {
    setDone(false);
    start(async () => {
      await updateJobNotes(jobId, value);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    });
  }

  return (
    <div>
      <Textarea
        rows={4}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Running notes for this job — site details, access, customer preferences, follow-ups…"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save notes"}
        </Button>
        {done && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
