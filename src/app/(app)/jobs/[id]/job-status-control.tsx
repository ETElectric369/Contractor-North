"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/input";
// Use the GUARDED setJobStatus (jobs/actions: requireStaff + status whitelist + not-found check).
// There used to be an identically-named UNGUARDED copy in schedule/actions that this imported — a
// name-collision footgun that silently bypassed the staff guard. That copy is now deleted.
import { setJobStatus } from "../actions";
import { setJobHold } from "../../schedule/actions";
import { JOB_STATUSES, jobStatusLabel } from "@/lib/job-status";

// Reference implementation for spine-driven status controls: options derive from the
// spine + labels via jobStatusLabel (wo-status-control / quotes status-control copy this).
const STATUSES = JOB_STATUSES;

export function JobStatusControl({
  id,
  status,
  holdReason,
}: {
  id: string;
  status: string;
  holdReason?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  /* A HOLD ASKS WHY, EVERYWHERE. The rail asks (0234); this dropdown was the one door left that
     parked a job with a shrug — Erik: "any On Hold job should have a reason and therefore needs
     an action." Picking "On hold" here opens the why-input instead of writing blind; every other
     status goes straight through, and leaving on_hold clears the reason (setJobHold's wake rule
     keeps a stale reason from ever reading as a live one). */
  const [askWhy, setAskWhy] = useState(false);
  const [why, setWhy] = useState(holdReason ?? "");
  // NOTHING SILENT: a refused write (staff guard, vanished job) used to refresh the page and
  // quietly snap the dropdown back — a deny that looked like a glitch. The reason shows here.
  const [err, setErr] = useState<string | null>(null);

  function change(next: string) {
    if (next === "on_hold" && status !== "on_hold") {
      setWhy(holdReason ?? "");
      setAskWhy(true);
      return;
    }
    start(async () => {
      setErr(null);
      // Off hold via THE hold writer so the reason clears with the status — setJobStatus alone
      // would leave "waiting on the permit" haunting a job that isn't waiting on anything.
      let res: { ok: boolean; error?: string };
      if (status === "on_hold" && next !== "on_hold") {
        res = await setJobHold(id, null);
        if (res.ok && next !== "scheduled" && next !== "to_be_scheduled") res = await setJobStatus(id, next);
      } else {
        res = await setJobStatus(id, next);
      }
      if (!res.ok) setErr(res.error ?? "That didn't save.");
      router.refresh();
    });
  }

  function park() {
    start(async () => {
      setErr(null);
      const res = await setJobHold(id, why);
      if (!res.ok) { setErr(res.error ?? "That didn't save."); return; } // stay open — the reason typed isn't lost
      setAskWhy(false);
      router.refresh();
    });
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Select value={askWhy ? "on_hold" : status} disabled={pending} className="w-40" onChange={(e) => change(e.target.value)}>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {jobStatusLabel(s).replace(/^\w/, (c) => c.toUpperCase())}
          </option>
        ))}
      </Select>
      {askWhy && (
        <>
          <input
            autoFocus
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); park(); }
              if (e.key === "Escape") setAskWhy(false);
            }}
            placeholder="Why? — waiting on the permit"
            aria-label="Why is this going on hold"
            className="h-9 w-56 rounded-lg border border-brand/60 px-2 text-sm"
          />
          <button
            type="button"
            onClick={park}
            disabled={pending}
            className="h-9 rounded-lg bg-brand px-2.5 text-sm font-semibold text-white"
          >
            Hold It
          </button>
        </>
      )}
      {/* The reason rides beside the status while held — the action in plain sight. */}
      {!askWhy && status === "on_hold" && holdReason && (
        <span className="text-xs text-slate-500">— {holdReason}</span>
      )}
      {err && <span className="text-xs font-medium text-red-600">{err}</span>}
    </span>
  );
}
