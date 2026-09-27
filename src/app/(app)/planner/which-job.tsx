"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { putPunchOnJob, whichJobChoices } from "../timeclock/which-job-actions";
import {
  pickOutcome,
  type WhichJobMoment,
  type WhichJobOption,
  type WhichJobResult,
} from "../timeclock/which-job-choices";

export type { WhichJobOption, WhichJobResult } from "../timeclock/which-job-choices";

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
 * hour since the punch, not just the minutes after the tap — through the shared server action
 * (timeclock/which-job-actions putPunchOnJob, the same one the clock doors' sheet below uses).
 * After the write lands the route is refreshed and the four doors render in this block's place —
 * no reload, nothing to find.
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
  /** The server action: sets job_id on the caller's own, job-less entry. Checked write. */
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
        // The write landed: say so (the block is about to be replaced) and re-render the page from
        // the server so the Now block comes back with the job's doors — the RSC refresh, not a
        // full reload.
        if (res.label) toast(`Your punch is on ${res.label}.`, "success");
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

// ── THE SHEET: "Which Job Are You On?" at the clock (Erik, 2026-09-26: "yes") ─────────────────
//
// The duplicate punches began with a clock that couldn't tell the job (the schedule didn't cover
// the day), saved the punch on no job and asked nothing; days later the office typed the same
// hours again on the job. So when a clock-in lands on no job, the door that made it (Timeclock, My
// Day's clock card, the offline queue once it files) puts ONE question up, and the same one once
// more when that shift closes still on no job:
//   · the punch is ALREADY saved before the sheet appears: the clock never waits on it, and the
//     sheet loads its own list after the clock has answered;
//   · the likely jobs first (which-job-choices), each one 44px tap;
//   · "Skip, The Office Will Pick" always there: skipping writes nothing and the office picks, as
//     before (Hours On No Job, the job's Time tab);
//   · picking is a checked write, and anything but a landed write comes back as a plain line;
//   · a job the clock knew never gets here: the clock stays two buttons.

export type SheetPhase =
  | { phase: "loading" }
  | { phase: "ready"; jobs: WhichJobOption[]; isStaff: boolean }
  | { phase: "failed"; error: string };

/**
 * The sheet as it looks, given its state. No hooks: the doors' wiring is in WhichJobSheet, and the
 * tests read this one (every row a 44px button, Skip always present, no price anywhere).
 */
export function WhichJobSheetView({
  moment,
  state,
  busyId = null,
  err = null,
  placed = null,
  onPick,
  onSkip,
}: {
  moment: WhichJobMoment;
  state: SheetPhase;
  busyId?: string | null;
  err?: string | null;
  /** The pick landed and there is no toast to say so (the offline queue's sheet): said here. */
  placed?: string | null;
  onPick: (job: WhichJobOption) => void;
  onSkip: () => void;
}) {
  const footer = placed ? (
    <Button type="button" className="min-h-[44px] w-full" onClick={onSkip}>
      Done
    </Button>
  ) : (
    <Button type="button" variant="outline" className="min-h-[44px] w-full" onClick={onSkip} disabled={!!busyId}>
      Skip, The Office Will Pick
    </Button>
  );
  return (
    <Modal open onClose={onSkip} title="Which Job Are You On?" size="sm" portal footer={footer}>
      {placed ? (
        <p className="text-sm font-medium text-green-700" role="status">
          {placed}
        </p>
      ) : (
        <div data-testid="which-job-sheet">
          <p className="text-sm text-slate-600">
            {moment === "in"
              ? "You're clocked in. Tap the job you're on and the whole punch goes on it."
              : "You're clocked out, and this punch has no job. Tap the job it was on."}
          </p>
          {state.phase === "loading" ? (
            <p className="mt-3 flex min-h-[44px] items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Finding your jobs…
            </p>
          ) : state.phase === "failed" ? (
            <p className="mt-3 text-sm text-slate-600">{state.error}</p>
          ) : state.jobs.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">
              {state.isStaff
                ? "No job is going right now. Put this punch on its job from Timecards when you know it."
                : "No job is going right now. The office puts this punch on the right job."}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
              {state.jobs.map((j) => (
                <li key={j.id}>
                  <button
                    type="button"
                    onClick={() => onPick(j)}
                    disabled={!!busyId}
                    className="flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-slate-900">{j.label}</span>
                      {j.why && <span className="block text-xs text-slate-500">{j.why}</span>}
                    </span>
                    {busyId === j.id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {err && (
            <p className="mt-2 text-sm text-red-600" role="alert">
              {err}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * The sheet, wired: loads its own list for `entryId` (after the clock has answered), and a tap puts
 * the punch on that job. `confirmInline`: the door has no toast (the shell's offline queue sits
 * outside the toast provider), so the sentence is said in the sheet with a Done button instead.
 */
export function WhichJobSheet({
  entryId,
  moment,
  onClose,
  confirmInline = false,
}: {
  entryId: string;
  moment: WhichJobMoment;
  onClose: () => void;
  confirmInline?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<SheetPhase>({ phase: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    whichJobChoices(entryId).then(
      (r) => {
        if (!alive) return;
        setState(r.ok ? { phase: "ready", jobs: r.jobs, isStaff: r.isStaff } : { phase: "failed", error: r.error });
      },
      () => {
        if (alive) setState({ phase: "failed", error: "No connection, so the jobs didn't load. Your punch is saved; skip, and the office will put it on its job." });
      },
    );
    return () => {
      alive = false;
    };
  }, [entryId]);

  async function pick(job: WhichJobOption) {
    if (busyId) return;
    setBusyId(job.id);
    setErr(null);
    try {
      const out = await pickOutcome(putPunchOnJob, entryId, job);
      if (out.kind === "placed") {
        router.refresh();
        if (confirmInline) {
          setPlaced(out.sentence);
          return;
        }
        toast(out.sentence, "success");
        onClose();
        return;
      }
      if (out.kind === "stale" && !confirmInline) {
        // The punch moved underneath (closed, or got its job elsewhere): the screen behind catches
        // up, and the sentence rides a toast because the sheet goes with it.
        toast(out.sentence, "error");
        router.refresh();
        onClose();
        return;
      }
      setErr(out.sentence);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <WhichJobSheetView
      moment={moment}
      state={state}
      busyId={busyId}
      err={err}
      placed={placed}
      onPick={(j) => void pick(j)}
      onSkip={onClose}
    />
  );
}
