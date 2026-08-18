"use client";

import { useEffect, useState } from "react";
import { clockIn } from "@/app/(app)/timeclock/actions";
import { listPending, registerReplayer, startAutoDrain } from "@/lib/offline/queue";

/**
 * THE QUEUE DRAINS FROM ANYWHERE IN THE APP (audit 9).
 *
 * The promise on the clock card is "it'll file itself when you have signal" — and the drain that
 * kept that promise was mounted inside the clock card itself, on /planner. Walk to the job page,
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
  const [pending, setPending] = useState(0);
  const [blocked, setBlocked] = useState(0);

  useEffect(() => {
    registerReplayer("time.clockIn", async (args, clientOpId) => {
      const a = args as Parameters<typeof clockIn>[0];
      const res = await clockIn({ ...a, clock_in_at: null, clientOpId });
      // A refusal that TIME fixes (a session that hadn't refreshed after hours offline) must not
      // be quarantined as a permanent rejection — the drain waits and tries again instead.
      const transient = !res.ok && /sign(ed)? in|session|expired|temporar|timeout|network|fetch/i.test(res.error ?? "");
      return { ...res, retryable: transient };
    });

    let alive = true;
    const refresh = async () => {
      const ops = await listPending();
      if (!alive) return;
      setPending(ops.filter((o) => !o.blocked).length);
      setBlocked(ops.filter((o) => o.blocked).length);
    };
    void refresh();
    const stop = startAutoDrain(() => void refresh(), userId);
    return () => {
      alive = false;
      stop();
    };
  }, [userId]);

  if (!pending && !blocked) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-3 shell:bottom-4">
      <div
        className={`pointer-events-auto rounded-full px-3.5 py-2 text-xs font-medium shadow-lg ${
          blocked
            ? "border border-rose-200 bg-rose-50 text-rose-800"
            : "border border-amber-200 bg-amber-50 text-amber-900"
        }`}
      >
        {blocked
          ? `${blocked} punch${blocked === 1 ? "" : "es"} the office has to enter — tell them the time you started.`
          : `Holding ${pending} punch${pending === 1 ? "" : "es"} on this phone — filing as soon as you have signal.`}
      </div>
    </div>
  );
}
