"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { updateJobDescription, updateJobNotes } from "../actions";

/**
 * THE JOB'S TWO WORDS BOXES (W1-21, Erik 2026-09-27: "yes to all", job notes are TWO boxes). One
 * component, two fields, each stored in its own column and never copied into the other:
 *
 *   Description   jobs.description, the scope. It PRINTS on the customer's invoice: New Invoice
 *                 copies it onto the bill (createBlankInvoice's description).
 *   Notes         jobs.notes, the company's own: gate codes, access, the dog. Never on a customer's
 *                 paper; nothing that builds a customer document reads it.
 *
 * One plain line under each says which is which. Staff edit both in place (Save appears only once
 * something changed, then "Saved", the error in words on a refusal; both writers ask for the id back,
 * so a zero-row save is never called Saved). A job with no notes shows one 44px "Add A Note" that
 * opens the box.
 *
 * A tech READS: the save behind either box is staff-only at the policy (jobs_write) AND the action
 * (requireStaff), so a textarea for him was a trap (Brian typed a materials note into the Description
 * and watched Save refuse). His Description is the scope as text; his Notes show only when there are
 * some; and the one thing he was trying to do points at the door that works for him, the Materials
 * tab, said once (under the Description).
 */
export type JobTextField = "description" | "notes";

const WORDS: Record<JobTextField, { label: string; helper: string; placeholder: string }> = {
  description: {
    label: "Description",
    helper: "The scope. It prints on the customer's invoice.",
    placeholder: "What's this job? The scope, in the words the customer will read.",
  },
  notes: {
    label: "Notes",
    helper: "Only your company sees these. Never on a customer's paper.",
    placeholder: "Gate codes, access, where to park, the dog…",
  },
};

export function JobTextBox({
  jobId,
  field,
  value: initial,
  viewerIsStaff = true,
}: {
  jobId: string;
  field: JobTextField;
  value: string | null;
  viewerIsStaff?: boolean;
}) {
  const words = WORDS[field];
  const [value, setValue] = useState(initial ?? "");
  // Local baseline (not the prop): the server trims on save, so comparing the
  // typed value against the revalidated prop could read as forever-dirty.
  const [savedValue, setSavedValue] = useState(initial ?? "");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // An empty Notes box stays one "Add A Note" button until it is asked for.
  const [opened, setOpened] = useState(field === "description" || !!(initial ?? "").trim());
  const dirty = value !== savedValue;

  if (!viewerIsStaff) {
    const text = (initial ?? "").trim();
    if (field === "notes") {
      // Only when there are some: an empty box says nothing to the crew (it is not his to fill).
      if (!text) return null;
      return (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{words.label}</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{initial}</p>
        </div>
      );
    }
    return (
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{words.label}</div>
        {text ? (
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{initial}</p>
        ) : (
          // The empty state is a sentence, not a form — nothing here invites typing.
          <p className="mt-1 text-sm text-slate-400">The office hasn&rsquo;t written one yet.</p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Need materials? Add them on the{" "}
          <Link href={`/jobs/${jobId}?tab=materials`} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">
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
      const res = field === "notes" ? await updateJobNotes(jobId, value) : await updateJobDescription(jobId, value);
      if (!res.ok) {
        // Stay dirty on failure so the Save affordance can't vanish over unsaved text.
        setError(res.error ?? "That didn't save. Try again.");
        return;
      }
      setSavedValue(value);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    });
  }

  if (!opened) {
    return (
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{words.label}</div>
        <Button type="button" variant="outline" className="mt-1" onClick={() => setOpened(true)}>
          <Plus className="h-4 w-4" /> Add A Note
        </Button>
        <p className="mt-1 text-xs text-slate-500">{words.helper}</p>
      </div>
    );
  }

  const id = `job-${field}-${jobId}`;
  return (
    <div>
      <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-slate-400">
        {words.label}
      </label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={words.placeholder}
        autoFocus={field === "notes" && !(initial ?? "").trim()}
        className="mt-1 min-h-[72px]"
      />
      <p className="mt-1 text-xs text-slate-500">{words.helper}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* Save only appears once there's something to save — the dirty pattern
            the other inline editors use (e.g. the circuit schedule card). */}
        {(dirty || pending) && (
          <Button onClick={save} disabled={pending || !dirty}>
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
