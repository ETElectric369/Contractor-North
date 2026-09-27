"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/input";
import { ComeBackPicker } from "@/components/come-back-picker";
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
  /* A HOLD ASKS WHY, AND WHEN IT COMES BACK, EVERYWHERE. The rail asks (0234); this dropdown was the
     one door left that parked a job with a shrug — Erik: "any On Hold job should have a reason and
     therefore needs an action." Picking "On hold" here opens the come-back picker instead of writing
     blind: Why? (required, it is the reminder the job comes back with) and the day (In A Week unless
     another is picked; there is no "no date": "too quiet gets things lost", 0366). The day is worked
     out on the server in the company's timezone. Every other status goes straight through, and
     leaving on_hold clears the reason and the day (setJobHold's wake rule, and the database's own
     jobs_hold_day, keep a stale reason from ever reading as a live one). */
  const [askWhy, setAskWhy] = useState(false);
  // NOTHING SILENT: a refused write (staff guard, vanished job) used to refresh the page and
  // quietly snap the dropdown back — a deny that looked like a glitch. The reason shows here.
  const [err, setErr] = useState<string | null>(null);

  function change(next: string) {
    if (next === "on_hold" && status !== "on_hold") {
      setErr(null);
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

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Select value={askWhy ? "on_hold" : status} disabled={pending} className="h-11 w-40" onChange={(e) => change(e.target.value)}>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {jobStatusLabel(s).replace(/^\w/, (c) => c.toUpperCase())}
          </option>
        ))}
      </Select>
      {askWhy && (
        <span className="block w-full max-w-sm">
          <ComeBackPicker
            label="Hold It"
            requireWhy
            autoFocus
            initialWhy={holdReason ?? ""}
            pending={pending}
            error={err}
            onCancel={() => {
              setAskWhy(false);
              setErr(null);
            }}
            onSubmit={({ why, when }) =>
              start(async () => {
                setErr(null);
                const res = await setJobHold(id, why, when);
                // Stay open on a refusal: the reason typed and the day picked aren't lost.
                if (!res.ok) {
                  setErr(res.error ?? "That didn't save.");
                  return;
                }
                setAskWhy(false);
                router.refresh();
              })
            }
          />
        </span>
      )}
      {/* The reason rides beside the status while held — the action in plain sight. */}
      {!askWhy && status === "on_hold" && holdReason && (
        <span className="text-xs text-slate-500">— {holdReason}</span>
      )}
      {!askWhy && err && <span className="text-xs font-medium text-red-600">{err}</span>}
    </span>
  );
}
