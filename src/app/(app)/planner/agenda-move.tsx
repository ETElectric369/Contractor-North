"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { MoveToDay } from "@/components/move-to-day";
import { useToast } from "@/components/toast";
import { shiftApptToDay } from "@/lib/appt-time";
import { moveJobDay } from "../schedule/actions";
import { rescheduleAppointment } from "../appointments/actions";
import { toggleTask, updateTask } from "../tasks/actions";

// Row verbs for the My Day agenda — thin client wrappers that bind the shared
// <MoveToDay> sheet to each record type's canonical server contract (jobs →
// moveJobDay, appointments → rescheduleAppointment, tasks → updateTask
// due_date). One grammar, three record kinds. Staff-only: the page only
// renders these for staff (the server actions are staff-gated anyway).

const rowTrigger =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-brand";

/** Move a job's day. Proposal-aware: a pending customer date-pick link blocks
 *  the move server-side (needsProposalConfirm) until the user confirms
 *  withdrawing it — a later customer tap on an OLD option can't silently
 *  overwrite the move. */
export function JobMoveButton({ jobId, fromDate }: { jobId: string; fromDate: string }) {
  const router = useRouter();
  return (
    <MoveToDay
      label="Move job to a day"
      triggerClassName={rowTrigger}
      onPick={async (dateISO) => {
        if (!dateISO) return { ok: false, error: "Pick a day." };
        let res = await moveJobDay(jobId, fromDate, dateISO);
        if (!res.ok && res.needsProposalConfirm) {
          if (!confirm("A date-pick link is out to the customer for this job. Move it anyway and withdraw the link?")) {
            return { ok: true, note: "Job not moved — the customer's date-pick link is still live." };
          }
          res = await moveJobDay(jobId, fromDate, dateISO, { cancelProposals: true });
        }
        if (res.ok) router.refresh();
        return res;
      }}
    />
  );
}

/** Move an appointment to another day, keeping its time-of-day and duration.
 *  The new instant is computed in the browser (via the shared shiftApptToDay
 *  helper) so the user's own timezone is honored and the calendar/agenda paths
 *  can't drift across a DST boundary. */
export function ApptMoveButton({ id, startsAt, endsAt }: { id: string; startsAt: string; endsAt: string | null }) {
  const router = useRouter();
  return (
    <MoveToDay
      label="Move appointment to a day"
      triggerClassName={rowTrigger}
      onPick={async (dateISO) => {
        if (!dateISO) return { ok: false, error: "Pick a day." };
        const t = shiftApptToDay(startsAt, endsAt, dateISO);
        const res = await rescheduleAppointment(id, t.start, t.end);
        if (res.ok) router.refresh();
        return res; // a withdrawn pick-a-time link surfaces via `note` as a toast
      }}
    />
  );
}

/** Agenda task row verbs: one-tap check-off + move the due date. */
export function TaskAgendaControls({
  taskId,
  category,
  jobId,
}: {
  taskId: string;
  category: string;
  jobId: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          if (busy || done) return;
          setBusy(true);
          setDone(true); // optimistic — the row leaves the agenda on refresh
          const res = await toggleTask(taskId, true, { category, jobId });
          setBusy(false);
          if (!res.ok) {
            setDone(false);
            toast(res.error ?? "Couldn't check that off — try again.", "error");
            return;
          }
          router.refresh();
        }}
        disabled={busy}
        title="Mark done"
        aria-label="Mark done"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100"
      >
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-md border ${
            done ? "border-brand bg-brand text-white" : "border-slate-300"
          }`}
        >
          {done && <Check className="h-3.5 w-3.5" />}
        </span>
      </button>
      <MoveToDay
        label="Move due date"
        clearable
        triggerClassName={rowTrigger}
        onPick={async (dateISO) => {
          const res = await updateTask(taskId, { due_date: dateISO }, { category, jobId });
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </>
  );
}
