"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { MoveToDay } from "@/components/move-to-day";
import { RowMoreSheet, SHEET_ROW } from "@/components/row-more-sheet";
import { shiftApptToDay } from "@/lib/appt-time";
import { moveJobDay } from "../schedule/actions";
import { rescheduleAppointment, setAppointmentStatus } from "../appointments/actions";
import { AppointmentButton, type ApptValue } from "../appointments/appointment-button";

// THE AGENDA ROW'S ⋯ (My Day, staff only). Running Late? and Navigate stay on the row, where a thumb
// at a red light finds them; the office's verbs (Mark Done, Move To Another Day…, Edit Details…) sit
// behind one 44px ⋯ that opens the app's one row sheet (components/row-more-sheet). Each verb keeps
// its record's canonical server contract: jobs → moveJobDay, appointments → rescheduleAppointment and
// setAppointmentStatus. The page renders this for staff only; the actions are staff-gated anyway.

/** What a move said: `moved` is whether anything moved (the sheet closes only then). */
export type MoveOutcome = { ok: boolean; error?: string; note?: string; moved: boolean };

type MoveJobDay = typeof moveJobDay;

/**
 * Move a job's day FROM THE ROW'S OWN DAY (moveJobDay's `fromDate`): on a Mon-Tue + Thu-Fri job,
 * Thursday's row moves the Thu-Fri range, not Mon-Tue. Proposal-aware: a pending customer date-pick
 * link blocks the move server-side (needsProposalConfirm) until the person confirms withdrawing it,
 * so a later customer tap on an OLD option can't silently overwrite the move.
 */
export async function moveJobFromDay(
  jobId: string,
  fromDate: string,
  dateISO: string | null,
  deps: { move: MoveJobDay; confirm: (question: string) => boolean } = { move: moveJobDay, confirm: (q) => window.confirm(q) },
): Promise<MoveOutcome> {
  if (!dateISO) return { ok: false, error: "Pick a day.", moved: false };
  let res = await deps.move(jobId, fromDate, dateISO);
  if (!res.ok && res.needsProposalConfirm) {
    if (!deps.confirm("A date-pick link is out to the customer for this job. Move it anyway and withdraw the link?")) {
      return { ok: true, note: "Job not moved — the customer's date-pick link is still live.", moved: false };
    }
    res = await deps.move(jobId, fromDate, dateISO, { cancelProposals: true });
  }
  return { ok: res.ok, error: res.error, note: res.note, moved: res.ok };
}

/**
 * Move a visit to another day, keeping its time of day and its length. The new instant is computed
 * in the ORG's timezone (shiftApptToDay), so a laptop one zone over can't slide a 9:00 visit an hour
 * across a DST boundary. A withdrawn pick-a-time link comes back as `note` (a toast).
 */
export async function moveVisitToDay(
  appt: Pick<ApptValue, "id" | "starts_at" | "ends_at">,
  dateISO: string | null,
  tz: string | undefined,
  deps: { reschedule: typeof rescheduleAppointment } = { reschedule: rescheduleAppointment },
): Promise<MoveOutcome> {
  if (!dateISO) return { ok: false, error: "Pick a day.", moved: false };
  const t = shiftApptToDay(appt.starts_at, appt.ends_at, dateISO, tz); // org tz (audit v921 review)
  const res = await deps.reschedule(appt.id, t.start, t.end);
  return { ok: res.ok, error: res.error, note: res.note, moved: res.ok };
}

/**
 * DONE, FROM WHERE YOU ARE STANDING (Erik: "when something is done close it"). A visit he had just
 * finished stayed on his day until he opened it and found the status control. Mark Done writes it,
 * closes the sheet and says so; the Undo puts back the status it had (setAppointmentStatus hands it
 * over). The one thing an Undo can't restore, a withdrawn pick-a-time link, is said and kept until
 * it is read. A refusal stays on the sheet as a toast, and the sheet stays open.
 */
export async function markVisitDone(
  id: string,
  io: {
    setStatus: typeof setAppointmentStatus;
    toast: ReturnType<typeof useToast>;
    refresh: () => void;
    close: () => void;
  },
): Promise<void> {
  const res = await io.setStatus(id, "completed");
  // A zero-row update is a 204, not an error: the action checks, so trust its verdict.
  if (!res.ok) {
    io.toast(res.error ?? "Couldn't mark it done.", "error");
    return;
  }
  io.close();
  const back = res.previousStatus;
  io.toast(
    "Done, Off Your Day",
    "success",
    back
      ? {
          label: "Undo",
          onClick: () => {
            void io.setStatus(id, back).then(
              (r) => {
                if (!r.ok) io.toast(r.error ?? "Couldn't put it back. Open the visit to set its status.", "error");
                else io.toast("Back On Your Day", "success");
                io.refresh();
              },
              () => io.toast("No connection, so it's still marked done. Try Undo again when you have a bar or two.", "error"),
            );
          },
        }
      : undefined,
  );
  if (res.note) io.toast(res.note, "info", undefined, { sticky: true });
  io.refresh();
}

interface Opt {
  id: string;
  label: string;
  address?: string | null;
}

/**
 * THE SHEET'S ROWS, in order. A visit: Mark Done, Move To Another Day…, Edit Details…. A job: Move
 * To Another Day… only (Done never sits on a job row: a job is done by finishing it, on the job). Each
 * row closes the sheet only when its verb lands; a nested Move or Edit sheet opens above this one.
 */
export function AgendaRowActions({
  close,
  appt,
  jobId,
  fromDate,
  tz,
  jobs,
  customers,
  staff,
}: {
  close: () => void;
  appt?: ApptValue;
  jobId?: string;
  fromDate: string;
  tz?: string;
  jobs: Opt[];
  customers: Opt[];
  staff: Opt[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function markDone(a: ApptValue) {
    start(async () => {
      try {
        await markVisitDone(a.id, { setStatus: setAppointmentStatus, toast, refresh: () => router.refresh(), close });
      } catch {
        toast("No connection, so it isn't marked done yet. Try again when you have a bar or two.", "error");
      }
    });
  }

  /** A Move sheet's pick: refresh and close this sheet when something moved; say the rest. */
  const afterMove = (out: MoveOutcome) => {
    if (out.moved) {
      router.refresh();
      close();
    }
    return { ok: out.ok, error: out.error, note: out.note };
  };

  if (appt) {
    return (
      <>
        <button type="button" disabled={pending} onClick={() => markDone(appt)} className={SHEET_ROW}>
          Mark Done
        </button>
        <MoveToDay label="Move To Another Day" triggerClassName={SHEET_ROW} onPick={async (d) => afterMove(await moveVisitToDay(appt, d, tz))}>
          Move To Another Day…
        </MoveToDay>
        <AppointmentButton
          jobs={jobs}
          customers={customers}
          staff={staff}
          appointment={appt}
          rowLabel="Edit Details…"
          triggerClassName={SHEET_ROW}
          onSaved={close}
        />
      </>
    );
  }
  if (jobId) {
    return (
      <MoveToDay label="Move To Another Day" triggerClassName={SHEET_ROW} onPick={async (d) => afterMove(await moveJobFromDay(jobId, fromDate, d))}>
        Move To Another Day…
      </MoveToDay>
    );
  }
  return null;
}

/**
 * The row's one ⋯: a visit with its record, or a job. A row with neither (a week-view visit, which
 * carries no record) gets no ⋯ at all rather than an empty sheet.
 */
export function AgendaRowMenu({
  title,
  subline = null,
  appt,
  jobId,
  fromDate,
  tz,
  jobs,
  customers,
  staff,
}: {
  title: string;
  subline?: string | null;
  appt?: ApptValue;
  jobId?: string;
  /** The ROW's own day (yyyy-mm-dd, org tz): today in the day view, that day in the week view. */
  fromDate: string;
  tz?: string;
  jobs: Opt[];
  customers: Opt[];
  staff: Opt[];
}) {
  if (!appt && !jobId) return null;
  return (
    <RowMoreSheet title={title} subline={subline}>
      {({ close }) => (
        <AgendaRowActions
          close={close}
          appt={appt}
          jobId={appt ? undefined : jobId}
          fromDate={fromDate}
          tz={tz}
          jobs={jobs}
          customers={customers}
          staff={staff}
        />
      )}
    </RowMoreSheet>
  );
}
