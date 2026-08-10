"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { MoveToDay } from "@/components/move-to-day";
import { shiftApptToDay } from "@/lib/appt-time";
import { moveJobDay } from "../schedule/actions";
import { rescheduleAppointment, setAppointmentStatus } from "../appointments/actions";

// Row verbs for the My Day agenda — thin client wrappers that bind the shared
// <MoveToDay> sheet to each record type's canonical server contract (jobs →
// moveJobDay, appointments → rescheduleAppointment). One grammar, two record
// kinds. Staff-only: the page only renders these for staff (the server
// actions are staff-gated anyway).

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

/**
 * DONE, FROM WHERE YOU ARE STANDING.
 *
 * Erik, three separate reports about one thing: "The later inspections already happened" /
 * "The lead was already inspected and the inspection already happened. We need a better flow for
 * this." / "when something is done close it."
 *
 * My Day only ever showed TODAY, and it already hid cancelled and completed ones — so nothing was
 * piling up. The problem was narrower and more annoying than a pile: an appointment he had just
 * finished stayed on the list for the rest of the day, because closing it meant opening the
 * appointment, finding the status control, and coming back. So it sat there, and by the afternoon
 * his own day was lying to him about what was left.
 *
 * setAppointmentStatus has existed the whole time. This is the button that calls it.
 */
export function ApptDoneButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      aria-label={`Mark ${title} done`}
      title="Mark done"
      disabled={pending}
      className={rowTrigger}
      onClick={() =>
        start(async () => {
          const res = await setAppointmentStatus(id, "completed");
          // A zero-row update is a 204, not an error — the action already checks, so trust its
          // verdict rather than the absence of a throw.
          if (!res.ok) return toast(res.error ?? "Couldn't mark it done.", "error");
          toast("Done — off your day.", "success");
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
    </button>
  );
}
