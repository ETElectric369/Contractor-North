"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, CalendarPlus, CheckCircle2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { hasInAppHistory } from "@/components/back-link";
import {
  ACTIONS_DANGER_ROW_CLS,
  ACTIONS_DIVIDER_CLS,
  ACTIONS_ROW_CLS,
  useCloseActionsMenu,
} from "@/components/section-actions-menu";
import { wontHappenConfirm, wontHappenToast, wontHappenUndo } from "@/lib/appointments/wont-happen";
import { putVisitBackOnSchedule, setAppointmentStatus, wontHappenAppointment } from "../actions";

/**
 * THE VISIT PAGE'S ⋯ ACTIONS ROWS (W2-11). The header used to carry up to seven controls: Get Paid,
 * "Mark inspection complete" (under 44px), a Delete for empty visits, a bare ✓ and ✗, Clear The Date
 * and Edit Details (whose modal footer had a hard Delete). Now it carries at most ONE main button
 * (Get Paid on a work visit, Mark Walk-Through Done on a booked walk-through) and this menu, last on
 * the row: Mark Done · Edit Details… · Clear The Date · Put It Back On The Schedule · — · Won't Happen.
 *
 * Each row says what happened in a toast and closes the panel; a status it changes has an Undo.
 */

/** Undo for a status deed: back to what it was. A visit that was waiting on the customer's pick
 *  comes back Scheduled (its link was withdrawn for good), and the toast says so. */
export function useStatusUndo(id: string) {
  const router = useRouter();
  const toast = useToast();
  return (previousStatus: string | undefined) => ({
    label: "Undo",
    onClick: () => {
      const back = wontHappenUndo(previousStatus);
      void (async () => {
        const res = await setAppointmentStatus(id, back.status);
        toast(
          res.ok ? (back.note ? `Put back. ${back.note}` : "Put back.") : (res.error ?? "Couldn't put it back."),
          res.ok ? "success" : "error",
        );
        router.refresh();
      })();
    },
  });
}

/** 'Mark Done' — a work visit that is booked (Get Paid holds the main slot). */
export function MarkDoneRow({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const closeMenu = useCloseActionsMenu();
  const undo = useStatusUndo(id);
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className={ACTIONS_ROW_CLS}
      onClick={() =>
        start(async () => {
          const res = await setAppointmentStatus(id, "completed");
          if (!res.ok) {
            toast(res.error ?? "Couldn't mark it done — try again.", "error");
            return;
          }
          toast(res.note ? `Marked Done. ${res.note}` : "Marked Done", "success", undo(res.previousStatus));
          closeMenu();
          router.refresh();
        })
      }
    >
      <CheckCircle2 className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {pending ? "Saving…" : "Mark Done"}
    </button>
  );
}

/** 'Put It Back On The Schedule' — a cancelled visit only (putVisitBackOnSchedule says the rest). */
export function PutBackRow({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const closeMenu = useCloseActionsMenu();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className={ACTIONS_ROW_CLS}
      onClick={() =>
        start(async () => {
          const res = await putVisitBackOnSchedule(id);
          if (!res.ok) {
            toast(res.error ?? "Couldn't put it back on the schedule — try again.", "error");
            return;
          }
          toast(res.message ?? "Back on the schedule.", "success");
          closeMenu();
          router.refresh();
        })
      }
    >
      <CalendarPlus className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {pending ? "Saving…" : "Put It Back On The Schedule"}
    </button>
  );
}

/**
 * 'Won't Happen' — after a divider, in red and last. The confirm says which will happen, from the
 * page's reading of the same four facts (`deletes`); the server decides again at the write and the
 * toast repeats ITS verdict, so a capture saved in between wins.
 */
export function WontHappenRow({ id, deletes, afterHref }: { id: string; deletes: boolean; afterHref: string }) {
  const router = useRouter();
  const toast = useToast();
  const closeMenu = useCloseActionsMenu();
  const undo = useStatusUndo(id);
  const [pending, start] = useTransition();
  function go() {
    if (!confirm(wontHappenConfirm(deletes ? "delete" : "cancel"))) return;
    start(async () => {
      const res = await wontHappenAppointment(id);
      if (!res.ok || !res.did) {
        toast(res.error ?? "That visit didn't change — try again.", "error");
        return;
      }
      closeMenu();
      if (res.did === "deleted") {
        toast(wontHappenToast("deleted"), "success");
        // GO BACK WHERE THEY CAME FROM, not to a hardcoded parent (Erik deleted from the
        // Walk-Throughs list and landed on /schedule). Real in-app history wins; the explicit
        // fallback, the visit's schedule day, only covers a cold entry. The deleted page can't
        // re-render itself.
        if (hasInAppHistory()) router.back();
        else router.push(afterHref);
        return;
      }
      toast(wontHappenToast("cancelled", res.note), "success", undo(res.previousStatus));
      router.refresh();
    });
  }
  return (
    <>
      <div className={ACTIONS_DIVIDER_CLS} />
      <button type="button" disabled={pending} onClick={go} className={ACTIONS_DANGER_ROW_CLS}>
        <Ban className="h-4 w-4 shrink-0" /> {pending ? "Saving…" : "Won't Happen"}
      </button>
    </>
  );
}
