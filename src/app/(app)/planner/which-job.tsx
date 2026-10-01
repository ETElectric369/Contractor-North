"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { putPunchOnJob, whichJobChoices } from "../timeclock/which-job-actions";
import {
  noJobsToOffer,
  pickOutcome,
  routePick,
  sheetAfterLoad,
  type SheetPhase,
  type WhichJobMoment,
  type WhichJobOption,
} from "../timeclock/which-job-choices";

export type { SheetPhase, WhichJobOption, WhichJobResult } from "../timeclock/which-job-choices";

/*
 * "WHICH JOB ARE YOU ON?" — for a punch that carries no job.
 *
 * My Day's Now card is keyed to the caller's OPEN time entry's job_id. A punch lands job-less
 * whenever the server resolver finds nothing to attach (no crew day-assignment, the job's
 * schedule ended yesterday, more than one job in progress) — and until cn-v947 the job's doors
 * simply didn't render, so Navigate / Materials / Add Cost vanished with no sentence and no door
 * (Erik, 2026-09-11: "what happened to my materials button on the job im clocked into").
 *
 * The Now card says that sentence and has that door: its ONE Pick The Job button opens the sheet
 * below. One pick sets the job on the WHOLE open entry — every hour since the punch, not just the
 * minutes after the tap. After the write lands the route is refreshed and the job's doors take the
 * question's place — no reload, nothing to find.
 *
 * ONE LIST, whichever door: My Day's block once carried a picker fed by the jobs in progress only,
 * while the sheet just before it offered the job he punched last and today's schedule too: a tech
 * helping on a crewmate's scheduled job, who tapped Skip, came back and couldn't find the job the
 * sheet had offered. So every door opens this sheet: one list, one write (putPunchOnJob), one set of
 * sentences — the Now card's Pick The Job, the Timeclock's Pick The Job, the clock itself after a
 * punch on no job, and the offline queue once it files.
 *
 * Only ever offered when the punch has NO job. Moving a punch that already carries one stays
 * on Timecards (the office's after-the-fact correction path).
 */

// ── THE SHEET: "Which Job Are You On?" at the clock (Erik, 2026-09-26: "yes") ─────────────────
//
// The duplicate punches began with a clock that couldn't tell the job (the schedule didn't cover
// the day), saved the punch on no job and asked nothing; days later the office typed the same
// hours again on the job. So when a clock-in lands on no job, the door that made it (Timeclock, My
// Day's Now card, the offline queue once it files) puts ONE question up, and the same one once
// more when that shift closes still on no job:
//   · the punch is ALREADY saved before the sheet appears: the clock never waits on it, and the
//     sheet loads its own list after the clock has answered;
//   · the likely jobs first (which-job-choices), each one 44px tap;
//   · "Skip, The Office Will Pick" always there: skipping writes nothing and the office picks, as
//     before (Hours On No Job, the job's Time tab);
//   · picking is a checked write, and anything but a landed write comes back as a plain line;
//   · a job the clock knew never gets here: the clock stays two buttons;
//   · nothing to offer, nothing to ask: an empty list closes the sheet and a toast says where the
//     punch went (sheetAfterLoad), so an idle company isn't handed a Skip-only modal twice a day.

/**
 * The sheet as it looks, given its state. No hooks: the doors' wiring is in WhichJobSheet, and the
 * tests read this one (every row a 44px button, Skip always present, no price anywhere).
 */
export function WhichJobSheetView({
  moment,
  from = null,
  state,
  busyId = null,
  err = null,
  placed = null,
  holdWhileBusy = false,
  onPick,
  onSkip,
}: {
  moment: WhichJobMoment;
  /** On a "move": the job the APP chose, which the punch is coming off — named, so the sheet says
   *  what it is moving away from and never asks a question about an unnamed job. */
  from?: { id: string; label: string } | null;
  state: SheetPhase;
  busyId?: string | null;
  err?: string | null;
  /** The pick landed and there is no toast to say so (the offline queue's sheet): said here. */
  placed?: string | null;
  /** The door has no toast, so the answer can only land on the sheet: while a pick is out, the X,
   *  a tap outside and Escape leave it open (Back still closes; Modal holdOpen says why). */
  holdWhileBusy?: boolean;
  onPick: (job: WhichJobOption) => void;
  onSkip: () => void;
}) {
  const footer = placed ? (
    <Button type="button" className="min-h-[44px] w-full" onClick={onSkip}>
      Done
    </Button>
  ) : (
    /* A MOVE IS NEVER A DEAD END AND NEVER A DEMAND: the way out says the punch stays where the app
       put it, which is exactly what ignoring the sentence does. "Skip, The Office Will Pick" would be
       a lie here — the punch already has a job. */
    <Button type="button" variant="outline" className="min-h-[44px] w-full" onClick={onSkip} disabled={!!busyId}>
      {moment === "move" ? "Leave It Where It Is" : "Skip, The Office Will Pick"}
    </Button>
  );
  return (
    <Modal open onClose={onSkip} holdOpen={holdWhileBusy && !!busyId} title="Which Job Are You On?" size="sm" portal footer={footer}>
      {placed ? (
        <p className="text-sm font-medium text-green-700" role="status">
          {placed}
        </p>
      ) : (
        <div data-testid="which-job-sheet">
          <p className="text-sm text-slate-600">
            {moment === "move"
              ? `The app put this punch on ${from?.label ?? "a job from today's schedule"}. Tap the job you're really on and the whole punch moves.`
              : moment === "in"
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
            <p className="mt-3 text-sm text-slate-600">{noJobsToOffer(state.isStaff)}</p>
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
  from = null,
  onClose,
  confirmInline = false,
}: {
  entryId: string;
  moment: WhichJobMoment;
  /** On a "move" (the Change door on the clock's sentence): the job the app chose. The list leaves it
   *  out, and the write names it, so the punch can only come off the job the screen said it was on. */
  from?: { id: string; label: string } | null;
  onClose: () => void;
  confirmInline?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  // The job the punch is coming off, as a plain id: the load effect depends on it, and an object
  // literal rebuilt on every render would re-run the read and re-load the list under the thumb.
  const fromId = from?.id ?? null;
  const [state, setState] = useState<SheetPhase>({ phase: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);
  // Whether the sheet is still on screen. It can be closed while a pick is out (Back, the X, a tap
  // outside): the door's onClose has run and the sheet is gone, so the answer must not go to its
  // line (nobody would see a refusal) and onClose must not run twice (a crew lead's debrief, shut
  // already, would open again). routePick sends it to a toast instead.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The door's close and the toast, read when the list lands (the load runs once per punch).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    whichJobChoices(entryId, fromId).then(
      (r) => {
        if (!alive) return;
        const next = sheetAfterLoad(r, { confirmInline, moment });
        if (next.close) {
          // No job to offer: close, and say where the punch went instead of a Skip-only sheet.
          toastRef.current(next.sentence, "info");
          closeRef.current();
          return;
        }
        setState(next.state);
      },
      () => {
        if (alive) setState({ phase: "failed", error: "No connection, so the jobs didn't load. Your punch is saved; skip, and the office will put it on its job." });
      },
    );
    return () => {
      alive = false;
    };
  }, [entryId, confirmInline, fromId, moment]);

  async function pick(job: WhichJobOption) {
    if (busyId) return;
    setBusyId(job.id);
    setErr(null);
    try {
      // ONE WRITE for both: putPunchOnJob places a job-less punch, and moves one off the job the app
      // chose when the screen names that job. Nothing here decides which — `fromId` is the fact.
      const out = await pickOutcome((eid, jid) => putPunchOnJob(eid, jid, fromId), entryId, job);
      const gone = !mounted.current;
      const route = routePick(out, { confirmInline, gone });
      if (route.refresh) router.refresh();
      if (route.toast) toast(route.toast.sentence, route.toast.kind);
      if (gone) return;
      if (route.placed) setPlaced(route.placed);
      if (route.inline) setErr(route.inline);
      if (route.close) onClose();
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  return (
    <WhichJobSheetView
      moment={moment}
      from={from}
      state={state}
      busyId={busyId}
      err={err}
      placed={placed}
      holdWhileBusy={confirmInline}
      onPick={(j) => void pick(j)}
      onSkip={onClose}
    />
  );
}
