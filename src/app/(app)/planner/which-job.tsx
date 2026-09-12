"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useToast } from "@/components/toast";

export type WhichJobOption = { id: string; label: string };

/** The answer to a pick: the page's server action reports a sentence, never a code.
 *  `stale` = the refusal is because the PUNCH is no longer what this screen shows (it closed, or
 *  got its job some other way): the block must re-render from the server, not sit on the old
 *  facts. The shell has no pull-to-refresh, so the sentence can't ask for one — the component
 *  does the refresh itself. */
export type WhichJobResult = { ok: boolean; error?: string; stale?: boolean };

/**
 * "WHICH JOB ARE YOU ON?" — the Now block for a punch that carries no job.
 *
 * My Day's Now block is keyed to the caller's OPEN time entry's job_id. A punch lands job-less
 * whenever the server resolver finds nothing to attach (no crew day-assignment, the job's
 * schedule ended yesterday, more than one job in progress) — and until cn-v947 the whole block
 * simply didn't render, so Navigate / Open / Materials / Add Cost vanished with no sentence and
 * no door (Erik, 2026-09-11: "what happened to my materials button on the job im clocked into").
 *
 * This is that sentence and that door. One pick sets the job on the WHOLE open entry — every
 * hour since the punch, not just the minutes after the tap — through the page's own server
 * action. NOT switchJob: it records the outgoing segment first, and on a job-less punch that
 * segment is written with job_id NULL, so the morning would be banked to nothing and the job
 * would quietly under-cost. After the write lands the route is refreshed and the four doors
 * render in this block's place — no reload, nothing to find.
 *
 * Only ever offered when the punch has NO job. Moving a punch that already carries one stays
 * on Timecards (the office's after-the-fact correction path).
 */
export function WhichJob({
  entryId,
  jobs,
  isStaff,
  onPick,
}: {
  entryId: string;
  /** The org's jobs in progress, RLS-scoped to the caller — the same rows /timeclock's picker lists. */
  jobs: WhichJobOption[];
  /** Names the right door in the empty-list sentence: staff have Timecards, a tech has the office. */
  isStaff: boolean;
  /** The page's server action: sets job_id on the caller's own open, job-less entry. Checked write. */
  onPick: (entryId: string, jobId: string) => Promise<WhichJobResult>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [jobId, setJobId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    if (!jobId) {
      setErr("Pick the job first.");
      return;
    }
    setErr(null);
    start(async () => {
      try {
        const res = await onPick(entryId, jobId);
        if (!res.ok) {
          const sentence = res.error ?? "Could not put the punch on that job.";
          if (res.stale) {
            // The punch this block describes is gone (closed, or carrying a job now). The old
            // sentence asked for a pull-to-refresh the shell doesn't have; do the refresh here.
            // The sentence rides a toast, not the inline line, because the refresh replaces this
            // very block — with the job's doors, or with nothing when the punch closed — and an
            // inline line would vanish with it before anyone read why the tap did nothing.
            toast(sentence, "error");
            router.refresh();
            return;
          }
          setErr(sentence);
          return;
        }
        // The write landed: re-render the page from the server so the Now block comes back
        // with the job's doors — the RSC refresh, not a full reload.
        router.refresh();
      } catch {
        // Network only (a server refusal comes back as ok:false above). The punch is untouched.
        setErr("No connection — try again when you have bars.");
      }
    });
  }

  return (
    // `id` is the anchor the clock card's "Put It on the Job" door scrolls to.
    <div id="which-job" className="border-b border-brand/20 bg-brand-light/30 px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">Now</div>
      <div className="mt-0.5 text-lg font-bold text-slate-900">Which job are you on?</div>
      <p className="text-sm text-slate-500">
        You&rsquo;re on the clock, but this punch has no job yet. Pick it and the job&rsquo;s doors open here
        — the whole punch goes on it.
      </p>
      {jobs.length === 0 ? (
        // No candidate at all — say who can still fix it rather than showing an empty picker.
        <p className="mt-3 text-sm text-slate-600">
          {isStaff
            ? "No job is in progress right now — start one from Timeclock → More Options, or put this punch on a job from Timecards when you're done."
            : "No job is in progress right now — the office puts this punch on the right job."}
        </p>
      ) : (
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Select
            aria-label="Which job are you on?"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            disabled={pending}
            className="h-11"
          >
            <option value="">Pick the job…</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={pending} className="min-h-[44px]">
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Put It on the Job
          </Button>
        </form>
      )}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </div>
  );
}
