"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { setAppointmentOutcome } from "../actions";

/**
 * HOW THE VISIT ENDED — said on the visit, with the door to say it (cn-v1069).
 *
 * The visit page never read what it became: an estimate written up from it (capture.quote_id) was
 * nowhere on the page, Start The Estimate was offered again over a finished one, and the outcome
 * 0205 gave every visit (won / lost) was written by the estimate's status and
 * by Nort and shown by neither. Erik's two meetings "with nothing else to come of them" had no door
 * at all on the page: only Nort could close them.
 *
 *   Written up as EST-0042 · sent          the estimate, as a link; a dead one says so
 *   Won · Jun 14 · J-039 The Bayberry place  the outcome, with its day and the job when there is one
 *   [Lost]                                 the office's one door on a completed visit with a win or
 *                                          loss to record (a meeting too), still undecided, no job,
 *                                          no live estimate
 *
 * The outcome is the visit's own answer (setAppointmentOutcome), the same column the estimate's
 * Accepted / Declined and the Inspections tab's bucket read. Change re-opens the three words; Clear
 * takes the answer back. Nothing here is drawn for a visit with nothing to say.
 */
export type VisitEstimate = { id: string; number: string | null; status: string | null; live: boolean };
export type VisitOutcomeWord = "won" | "lost" | "no_bid";

// ONE WORD FOR AN ENDING THAT ISN'T A WIN (Erik, 2026-10-08: "just keep Lost everywhere - KISS"). The
// column still holds no_bid on a few old rows (Nort's tool can write it); every one of them reads Lost.
const WORDS: Record<VisitOutcomeWord, string> = { won: "Won", lost: "Lost", no_bid: "Lost" };

/** The outcome, in the page's words; an unknown stored word is shown as stored, never hidden. */
export function outcomeWord(outcome: string | null | undefined): string | null {
  if (!outcome) return null;
  return WORDS[outcome as VisitOutcomeWord] ?? outcome;
}

/** Whether the office is offered the ending doors: a completed estimate visit, still undecided, with
 *  no job and no live estimate (a live one decides it from the estimate's side). Pure, for the test. */
export function endingOffered(v: {
  isStaff: boolean;
  status: string | null;
  outcome: string | null;
  hasJob: boolean;
  estimateLive: boolean;
  decidable: boolean;
}): boolean {
  return v.isStaff && v.decidable && v.status === "completed" && !v.outcome && !v.hasJob && !v.estimateLive;
}

const DOOR = "inline-flex min-h-[44px] items-center justify-center";

export function VisitEnding({
  appointmentId,
  isStaff,
  decidable,
  status,
  estimate,
  outcome,
  outcomeAt,
  job,
  tz,
}: {
  appointmentId: string;
  isStaff: boolean;
  /** A visit with a win or a loss to record (lib/statuses DECIDABLE_VISIT_TYPES): not a work visit, not a final inspection. */
  decidable: boolean;
  status: string | null;
  estimate: VisitEstimate | null;
  outcome: string | null;
  outcomeAt: string | null;
  job: { id: string; job_number: string | null; name: string | null } | null;
  tz: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [pending, start] = useTransition();

  const word = outcomeWord(outcome);
  const offered = endingOffered({ isStaff, status, outcome, hasJob: !!job, estimateLive: !!estimate?.live, decidable });
  if (!estimate && !word && !offered) return null;

  function decide(next: VisitOutcomeWord | null) {
    start(async () => {
      const res = await setAppointmentOutcome(appointmentId, next);
      if (!res.ok) {
        toast(res.error ?? "That didn't save — try again.", "error");
        return;
      }
      toast(next ? `Marked ${WORDS[next]}.` : "Answer cleared.", "success");
      setChanging(false);
      router.refresh();
    });
  }

  const choices = (
    <div className="mt-2 flex flex-wrap gap-2">
      {(["lost", ...(changing ? ["won" as const] : [])] as VisitOutcomeWord[]).map((o) => (
        <Button key={o} type="button" variant="secondary" disabled={pending} className={DOOR} onClick={() => decide(o)}>
          {WORDS[o]}
        </Button>
      ))}
      {changing && (
        <>
          {outcome && (
            <Button type="button" variant="ghost" disabled={pending} className={DOOR} onClick={() => decide(null)}>
              Clear The Answer
            </Button>
          )}
          <Button type="button" variant="ghost" disabled={pending} className={DOOR} onClick={() => setChanging(false)}>
            Keep It
          </Button>
        </>
      )}
    </div>
  );

  return (
    <div className="my-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-sm" data-testid="visit-ending">
      {estimate && (
        <p className="text-slate-700">
          Written up as{" "}
          <Link href={`/quotes/${estimate.id}`} className="font-medium text-brand hover:underline">
            {estimate.number ?? "the estimate"}
          </Link>
          {estimate.status ? ` · ${estimate.status}` : ""}
          {!estimate.live && <span className="text-slate-500"> — that estimate is over; a new one can be started below.</span>}
        </p>
      )}
      {word && (
        <p className={`flex flex-wrap items-center gap-x-2 text-slate-700 ${estimate ? "mt-1" : ""}`}>
          <span className="font-medium">{word}</span>
          {outcomeAt && <span className="text-slate-500">· {formatDate(outcomeAt, tz)}</span>}
          {outcome === "won" && job && (
            <Link href={`/jobs/${job.id}`} className="text-brand hover:underline">
              · {[job.job_number, job.name].filter(Boolean).join(" ")}
            </Link>
          )}
          {isStaff && !changing && (
            <button type="button" onClick={() => setChanging(true)} className="min-h-[44px] text-xs text-slate-500 underline-offset-2 hover:underline">
              Change
            </button>
          )}
        </p>
      )}
      {offered && !changing && (
        <>
          <p className={`text-slate-700 ${estimate ? "mt-2" : ""}`}>How did this one end?</p>
          {choices}
        </>
      )}
      {changing && choices}
    </div>
  );
}
