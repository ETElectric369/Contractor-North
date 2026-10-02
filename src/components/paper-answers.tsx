"use client";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { BUSINESS_COST_BUCKETS } from "@/lib/business-cost-buckets";

/**
 * THE ANSWERS A PAPER CARD OPENS, SHARED (W1-31). A supplier's paper on Needs You and a receipt in
 * Snap Or Note's tray ask the same question the same way ("Put It On J-011", "Another Job", "Shop
 * Stock", "Business Cost"), so the two pickers behind those buttons are one component each:
 *
 *   · Another Job (Pick A Job when there is no job guess): the Closest jobs first, then Every Job
 *     still open, then the Completed Jobs in their own group (a late ticket for a finished job is
 *     still that job's cost), with its own Put It On J-0xx and Cancel. Nothing is ever selected
 *     for anyone.
 *   · Business Cost: a grid of 44px bucket buttons, the company's own buckets from
 *     BUSINESS_COST_BUCKETS, never a hard-coded list.
 *
 * Neither files anything by itself: the caller's answer does, in one tap, and says what it did.
 */

/** A job as a card's picker offers it. `label` is what a button says (the job number, or the name
 *  when there is no number); `status` tells a finished job apart. Never a price. */
export type PickJob = { id: string; label: string; name?: string | null; status?: string | null };

/** "in progress" and "in_progress" read "In Progress": every clickable is Title Case. */
export function titleCaseWords(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** A finished job: filed to by a person's own pick, listed under Completed Jobs, never first. */
export function isFinishedJob(status: string | null | undefined): boolean {
  return /^complete/i.test(String(status ?? "").replace(/_/g, " ").trim());
}

/** "J-011 · 13897 Honeysuckle · In Progress": the picker's line for one job. */
export function jobPickerLine(j: PickJob): string {
  const name = String(j.name ?? "").trim();
  return [j.label, name && name !== j.label ? name : null, titleCaseWords(j.status)].filter(Boolean).join(" · ");
}

/**
 * ANOTHER JOB. The picker and its own button. `closest` are the card's guesses (the matcher's, or
 * the paper's), first; the rest follow, open jobs before finished ones.
 */
export function JobPicker({
  ariaLabel,
  closest = [],
  jobs,
  value,
  onChange,
  onPut,
  onCancel,
  busy = false,
  verb = "Put It On",
  refusal = null,
}: {
  /** What the picker is asking, for a screen reader: "Which job was 8802-1106969 for?". */
  ariaLabel: string;
  closest?: PickJob[];
  jobs: PickJob[];
  /** The job picked so far ("" = none). Nothing is preselected, ever. */
  value: string;
  onChange: (jobId: string) => void;
  onPut: (job: PickJob) => void;
  onCancel: () => void;
  busy?: boolean;
  /** "Put It On" for a paper, "Put Photo On" for a job photo. */
  verb?: string;
  /** The sentence that stops this paper going on any job (the gate the server asks): the button is
   *  shut and says why. */
  refusal?: string | null;
}) {
  const firstIds = new Set<string>();
  const first = closest.filter((j) => !!j && !firstIds.has(j.id) && !!firstIds.add(j.id));
  const rest = jobs.filter((j) => !firstIds.has(j.id));
  const open = rest.filter((j) => !isFinishedJob(j.status));
  const done = rest.filter((j) => isFinishedJob(j.status));
  const chosen = jobs.find((j) => j.id === value) ?? first.find((j) => j.id === value) ?? null;
  return (
    <div className="mt-2 space-y-2">
      <Select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} className="min-h-11">
        <option value="">— Pick The Job —</option>
        {first.length > 0 && (
          <optgroup label="Closest">
            {first.map((j) => (
              <option key={j.id} value={j.id}>
                {jobPickerLine(j)}
              </option>
            ))}
          </optgroup>
        )}
        {open.length > 0 && (
          <optgroup label="Every Job">
            {open.map((j) => (
              <option key={j.id} value={j.id}>
                {jobPickerLine(j)}
              </option>
            ))}
          </optgroup>
        )}
        {done.length > 0 && (
          <optgroup label="Completed Jobs">
            {done.map((j) => (
              <option key={j.id} value={j.id}>
                {jobPickerLine(j)}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!chosen || busy || !!refusal} title={refusal ?? undefined} onClick={() => chosen && onPut(chosen)}>
          {chosen ? `${verb} ${chosen.label}` : `${verb} This Job`}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** BUSINESS COST. The company's own buckets as 44px buttons; one tap is the answer. */
export function BucketGrid({
  onPick,
  onCancel,
  busy = false,
  refusal = null,
}: {
  onPick: (bucket: string) => void;
  onCancel: () => void;
  busy?: boolean;
  /** The sentence that stops this paper being a business cost: every bucket is shut and says why. */
  refusal?: string | null;
}) {
  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-slate-500">The company&apos;s own, on no job. Which bucket?</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {BUSINESS_COST_BUCKETS.map((b) => (
          <Button
            key={b}
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal py-2"
            disabled={busy || !!refusal}
            title={refusal ?? undefined}
            onClick={() => onPick(b)}
          >
            {b}
          </Button>
        ))}
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The mark a guess carries on its button: never read off the paper, a person decides. */
export function GuessMark() {
  return <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[11px] font-semibold">Guess</span>;
}
