"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck, Loader2 } from "lucide-react";
import { fillWeekFromSchedule } from "./crew-actions";

/**
 * MAKE THE SUGGESTION REAL.
 *
 * The board used to draw the schedule's guess as a dashed pill in the same slot it draws real
 * assignments. Nothing was saved; it vanished on refresh. That is the app having an OPINION where
 * it shows FACTS, and it is what "i didn't know what that did" was pointing at — the honest answer
 * being "nothing".
 *
 * The rule that replaces it: NEVER SHOW A GUESS — offer to MAKE it real, then show what's real.
 * One tap writes ordinary rows the office can then edit, move or clear like any other, and
 * afterwards every filled cell on the board is a decision somebody actually made.
 *
 * That is also what makes plan-vs-actual possible at all: you cannot compare the schedule against
 * the timecards while half the schedule was never written down.
 */
export function FillWeekButton({ weekOffset = 0, suggestions = 0 }: { weekOffset?: number; suggestions?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Nothing to offer — say nothing. A button that would do nothing is the same lie in a new shape.
  if (!suggestions && done === null) return null;

  const run = () =>
    start(async () => {
      setErr(null);
      const res = await fillWeekFromSchedule({ weekOffset });
      if (!res.ok) return setErr(res.error ?? "Couldn't fill the week.");
      setDone(res.filled ?? 0);
      router.refresh();
    });

  if (done !== null) {
    return (
      <span className="text-xs text-green-700">
        {done === 0 ? "Nothing to fill." : `Filled ${done} day${done === 1 ? "" : "s"} — edit any of them below.`}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand/5 px-2.5 py-1 text-xs font-medium text-brand hover:bg-brand/10 disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarCheck className="h-3.5 w-3.5" />}
        Fill {suggestions} from the schedule
      </button>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  );
}
