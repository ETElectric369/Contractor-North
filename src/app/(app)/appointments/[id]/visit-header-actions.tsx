"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, CalendarPlus, CheckCircle2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
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
 * "Mark inspection complete" (under 44px), a Delete for empty visits, a bare ✓ and ✗, Clear the Date
 * and Edit Details (whose modal footer had a hard Delete). Now it carries at most ONE main button
 * (Get Paid on a work visit, Mark Inspection Done on a booked inspection) and this menu, last on
 * the row: Mark Done · Edit Details… · Clear the Date · Put It Back on the Schedule · — · Won't Happen.
 *
 * Each row says what happened in a toast and closes the panel; a status it changes has an Undo.
 * The rows' own words are the signed-in person's language (lib/words/visit-page, vp_); a note the
 * server sends back (res.note, in the caller's language already) is said as received.
 */

/** Undo for a status deed: back to what it was. A visit that was waiting on the customer's pick
 *  comes back Scheduled (its link was withdrawn for good), and the toast says so. */
export function useStatusUndo(id: string) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  return (previousStatus: string | undefined) => ({
    label: t("vp_btn_undo"),
    onClick: () => {
      const back = wontHappenUndo(previousStatus, lang, t);
      void (async () => {
        const res = await setAppointmentStatus(id, back.status);
        toast(
          res.ok ? (back.note ? fillText(t("vp_putBackNote"), { note: back.note }) : t("vp_putBack")) : (res.error ?? t("vp_couldntPutItBack")),
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
  const t = translator(useLang());
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
            toast(res.error ?? t("vp_couldntMarkItDone"), "error");
            return;
          }
          toast(res.note ? fillText(t("vp_markedDoneNote"), { note: res.note }) : t("vp_markedDone"), "success", undo(res.previousStatus));
          closeMenu();
          router.refresh();
        })
      }
    >
      <CheckCircle2 className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {pending ? t("vp_btn_saving") : t("vp_btn_markDone")}
    </button>
  );
}

/** 'Put It Back on the Schedule' — a cancelled visit only (putVisitBackOnSchedule says the rest). */
export function PutBackRow({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
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
            toast(res.error ?? t("vp_couldntPutBackOnSchedule"), "error");
            return;
          }
          toast(res.message ?? t("vp_backOnTheSchedule"), "success");
          closeMenu();
          router.refresh();
        })
      }
    >
      <CalendarPlus className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {pending ? t("vp_btn_saving") : t("vp_btn_putItBackOnTheSchedule")}
    </button>
  );
}

/**
 * 'Won't Happen' — after a divider, in red and last. The confirm says which will happen, from the
 * page's reading of the same four facts (`deletes`); the server decides again at the write and the
 * toast repeats ITS verdict, so a capture saved in between wins.
 *
 * THEN THE PAGE IS LEFT, IN THE SAME BREATH, FOR WHERE THE VISIT LIVES (`afterHref`: Sales ›
 * Inspections for an inspection, its day on the Schedule for any other booking; lib/appointments/
 * visit-home). Erik, 2026-11-10: "i deleted a couple inspections and instead of going back to the
 * inspection page it goes to" the app's 404. What happened: the action revalidates, so Next renders
 * THIS page again inside the action's own answer; the visit is gone, the page answers notFound(),
 * and with no not-found page inside the shell that is the bare 404 in place of the dock, the
 * sub-nav and the toast. The old way out was router.back(), which is the browser's history and
 * tells Next's router nothing, so the dead page was applied first and the Back raced it.
 *
 * A navigation dispatched in the tick the answer arrives is different: Next gives it priority over
 * the action still on its queue and throws that re-render away (run on Next's own queue in
 * tests/next-router-queue.test.ts). So the row navigates, at once, the way a job, an estimate or an
 * invoice leaves after its own delete — and never router.back() (above) or router.refresh() (asks
 * for the dead page again).
 *   · DELETED: replace. The page no longer exists, so it leaves no entry for Back to land on.
 *   · CANCELLED: push. The visit is still there (the toast's Undo, Put It Back on its page), so Back
 *     returns to it.
 */
export function WontHappenRow({ id, deletes, afterHref }: { id: string; deletes: boolean; afterHref: string }) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  const closeMenu = useCloseActionsMenu();
  const undo = useStatusUndo(id);
  const [pending, start] = useTransition();
  function go() {
    if (!confirm(wontHappenConfirm(deletes ? "delete" : "cancel", lang, t))) return;
    start(async () => {
      const res = await wontHappenAppointment(id);
      if (!res.ok || !res.did) {
        toast(res.error ?? t("vp_thatVisitDidntChange"), "error");
        return;
      }
      closeMenu();
      if (res.did === "deleted") {
        toast(wontHappenToast("deleted", null, lang, t), "success");
        router.replace(afterHref);
        return;
      }
      toast(wontHappenToast("cancelled", res.note, lang, t), "success", undo(res.previousStatus));
      router.push(afterHref);
    });
  }
  return (
    <>
      <div className={ACTIONS_DIVIDER_CLS} />
      <button type="button" disabled={pending} onClick={go} className={ACTIONS_DANGER_ROW_CLS}>
        <Ban className="h-4 w-4 shrink-0" /> {pending ? t("vp_btn_saving") : t("vp_btn_wontHappen")}
      </button>
    </>
  );
}
