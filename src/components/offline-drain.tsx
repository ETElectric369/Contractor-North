"use client";

import { useEffect, useState } from "react";
import { clockIn } from "@/app/(app)/timeclock/actions";
import { WhichJobSheet } from "@/app/(app)/planner/which-job";
import { askAfterPunch, type WhichJobAsk } from "@/app/(app)/timeclock/which-job-choices";
import { listPending, registerReplayer, remove, startAutoDrain, type QueuedOp } from "@/lib/offline/queue";

/**
 * THE QUEUE DRAINS FROM ANYWHERE IN THE APP (audit 9).
 *
 * The promise on the Now card is "it'll file itself when you have signal" — and the drain that
 * kept that promise was mounted inside the Now card itself, on /planner. Walk to the job page,
 * open Materials, put the phone away: the listeners were removed with the component, so the punch
 * sat on the phone through the entire drive back into coverage and only filed if the tech happened
 * to return to My Day. Past the server's age bound it is then refused outright — the morning is
 * gone, and he was told it was safe.
 *
 * This lives in the (app) shell beside the geofence monitor, which persists across routes for the
 * same reason. It also SHOWS pending work: `listPending` existed from day one with a doc-comment
 * saying a UI would use it to say so, and nothing ever did — so a queued punch was invisible while
 * /timeclock read "Not clocked in", inviting a second one.
 */
export function OfflineDrain({ userId }: { userId: string | null }) {
  const [mine, setMine] = useState<QueuedOp[]>([]);
  const [showBlocked, setShowBlocked] = useState(false);
  // A punch that filed from the queue with no job gets the same "Which Job Are You On?" the live
  // clock asks, once it is saved. This shell sits outside the toast provider, so the sheet says
  // where the punch went itself (confirmInline).
  const [ask, setAsk] = useState<WhichJobAsk | null>(null);
  // WHAT ELSE A FILED PUNCH DID, ON ITS OWN LINE (NY-hold, 0366): a punch that filed onto a job on
  // hold took it off hold, and the clock says so at every door. Outside the toast provider there is
  // no toast to carry it, so it waits here until Got It.
  const [said, setSaid] = useState<string[]>([]);

  useEffect(() => {
    registerReplayer("time.clockIn", async (args, clientOpId) => {
      const a = args as Parameters<typeof clockIn>[0];
      const res = await clockIn({ ...a, clock_in_at: null, clientOpId });
      const again = askAfterPunch(res, "in");
      if (again) setAsk(again);
      const warning = res.ok ? (res.warning ?? "").trim() : "";
      if (warning) setSaid((s) => (s.includes(warning) ? s : [...s, warning]));
      // A refusal that TIME fixes (a session that hadn't refreshed after hours offline) must not
      // be quarantined as a permanent rejection — the drain waits and tries again instead.
      const transient = !res.ok && /sign(ed)? in|session|expired|temporar|timeout|network|fetch/i.test(res.error ?? "");
      return { ...res, retryable: transient };
    });

    let alive = true;
    const refresh = async () => {
      const ops = await listPending();
      if (!alive) return;
      // COUNT ONLY WHAT THIS SESSION CAN ACTUALLY FILE (audit v921). The shop phone's queue
      // outlives the session that wrote it — IndexedDB is deliberately not cleared on sign-out —
      // and drain() already skips another person's op (queue.ts). The banner did not: tech B
      // signed in and was told forever that this phone was holding a punch (or that "the office
      // has to enter" one), for work B never did and B's drain will never send. Same rule as
      // the drain, so the pill and the queue agree.
      setMine(ops.filter((o) => !userId || !o.ownerId || o.ownerId === userId));
    };
    void refresh();
    const stop = startAutoDrain(() => void refresh(), userId);
    return () => {
      alive = false;
      stop();
    };
  }, [userId]);

  const blockedOps = mine.filter((o) => o.blocked);
  const pending = mine.length - blockedOps.length;
  const blocked = blockedOps.length;

  /**
   * A QUARANTINED PUNCH NEEDS A WAY OUT (audit v921 — no dead ends).
   *
   * Nothing in the product ever un-blocked an op, so the rose pill was permanent and on every
   * screen. Its usual cause is benign: the punch was queued in a dead zone, the tech walked to a
   * bar and tapped Clock In again, and the replay was refused with "You're already clocked in."
   * — the hours ARE recorded, and the banner was telling the office to enter them a second time.
   * Clearing is the tech's call, not ours: the op is shown with what the server said before the
   * button appears, and the pill stays until someone decides.
   */
  const clear = async (clientOpId: string) => {
    await remove(clientOpId);
    const ops = await listPending();
    setMine(ops.filter((o) => !userId || !o.ownerId || o.ownerId === userId));
  };

  const sheet = ask ? (
    <WhichJobSheet key={ask.entryId} entryId={ask.entryId} moment={ask.moment} confirmInline onClose={() => setAsk(null)} />
  ) : null;

  const saidLines = said.length ? (
    <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-3 text-sm shadow-lg">
      {said.map((line) => (
        <p key={line} className="text-slate-800">
          {line}
        </p>
      ))}
      <button
        type="button"
        onClick={() => setSaid([])}
        className="mt-2 inline-flex h-11 items-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700"
      >
        Got It
      </button>
    </div>
  ) : null;

  if (!pending && !blocked) {
    return (
      <>
        {sheet}
        {saidLines && (
          <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-3 shell:bottom-4">{saidLines}</div>
        )}
      </>
    );
  }

  return (
    <>
    {sheet}
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-3 shell:bottom-4">
      {saidLines}
      {blocked > 0 && showBlocked ? (
        <div className="pointer-events-auto w-full max-w-sm rounded-2xl border border-rose-200 bg-white p-3 text-xs shadow-lg">
          <p className="font-medium text-rose-900">These never filed</p>
          <ul className="mt-2 space-y-2">
            {blockedOps.map((o) => (
              <li key={o.clientOpId} className="rounded-xl bg-rose-50 p-2">
                <div className="font-medium text-rose-900">
                  {o.label} · {new Date(o.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </div>
                <div className="mt-0.5 text-rose-700">{o.blockedReason ?? "The server wouldn't accept it."}</div>
                <button
                  type="button"
                  onClick={() => void clear(o.clientOpId)}
                  className="mt-2 rounded-full border border-rose-300 px-2.5 py-1 font-medium text-rose-800"
                >
                  Clear It
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-slate-500">
            Check your timecard first — if the hours are already on it, this one was a duplicate and clearing it changes nothing.
          </p>
        </div>
      ) : null}
      <div
        className={`pointer-events-auto flex items-center gap-2 rounded-full px-3.5 py-2 text-xs font-medium shadow-lg ${
          blocked
            ? "border border-rose-200 bg-rose-50 text-rose-800"
            : "border border-amber-200 bg-amber-50 text-amber-900"
        }`}
      >
        <span>
          {blocked
            ? `${blocked} punch${blocked === 1 ? "" : "es"} the office has to enter — tell them the time you started.`
            : `Holding ${pending} punch${pending === 1 ? "" : "es"} on this phone — filing as soon as you have signal.`}
        </span>
        {blocked ? (
          <button
            type="button"
            onClick={() => setShowBlocked((v) => !v)}
            className="shrink-0 rounded-full border border-rose-300 px-2 py-0.5 font-medium text-rose-800"
          >
            {showBlocked ? "Hide" : "Details"}
          </button>
        ) : null}
      </div>
    </div>
    </>
  );
}
