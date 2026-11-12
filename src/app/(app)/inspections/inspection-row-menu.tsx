"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import { wontHappenToast, wontHappenUndo } from "@/lib/appointments/wont-happen";
import { dayWords } from "@/lib/action-items/dated-when";
import { fillSlots } from "@/lib/lang-words";
import { Button } from "@/components/ui/button";
import { MoveToDay, type MoveToDayResult } from "@/components/move-to-day";
import { RowMoreSheet, SHEET_ROW } from "@/components/row-more-sheet";
import { moveVisitToDay } from "../planner/agenda-move";
import { rescheduleAppointment, setAppointmentOutcome, setAppointmentStatus, wontHappenAppointment } from "../appointments/actions";
import type { BoardRow } from "./board-types";

/**
 * AN OPEN INSPECTION'S ⋯ (Sales › Inspections). The row's moves sit behind the app's one row sheet
 * (components/row-more-sheet), each a full-width row that says what it does, in this order:
 *   · Move to Another Day…: the one day picker; the visit keeps its time of day and its length, and
 *     the toast names the day it went to.
 *   · It Happened: Write It Up: marks the visit done, so it moves to Write Up (Undo puts its status back).
 *   · Lost: the visit did not become work; it is kept, under Lost (Undo clears the outcome).
 *   · Delete…: the visit page's own Won't Happen, behind its ask; a visit that is cancelled and kept
 *     (something was on it) offers Undo, as the visit's own page does.
 * The page decides which a row gets (its `menu`); a row with none of them gets no ⋯ at all, and a
 * visit with no start gets no Move (there is no time of day to keep).
 *
 * DELETE ASKS FIRST, IN THE SHEET: the house's two taps (the schedule sheet's Clear the Date). The
 * first tap swaps the sheet's rows for the question in the reader's words, the deed and Keep It;
 * nothing is written until the second. Never the browser's own dialog: its buttons are the browser's
 * words in the browser's language, and it is the one box that does not look like the app.
 *
 * ON THIS LIST THE ROW SIMPLY LEAVES and the person stays where they are; nothing navigates. Each
 * action revalidates /inspections itself, so its answer carries the list read again. The refresh
 * after a sheet's deed is a belt: the closing sheet steps history back, and that Back can discard it.
 * An Undo's refresh (no sheet is closing then) does land. Only the visit's OWN page has to go
 * somewhere when its visit is gone (appointments/[id]/visit-header-actions).
 *
 * THREE ENDINGS FOR EVERY DEED. Landed: the sheet closes, the toast says what happened, the list
 * re-reads. Refused by the server (the row is not what the list shows: already cancelled, marked
 * done, gone): the refusal is said in red, the sheet closes, THEN the list re-reads, in that order,
 * because a re-read under an open sheet breaks its Back. Thrown (no connection): said, the sheet
 * stays open so the same tap can be tried again, and nothing re-reads.
 *
 * Each deed is a small helper below that takes its server door as `deps`, so its Undo and its three
 * endings are proven without a server.
 */

/** One move a row's ⋯ can hold. */
export type MenuDoor = "move" | "happened" | "lost" | "del";

type Row = Pick<BoardRow, "id" | "who" | "what" | "menu" | "startsAt" | "endsAt">;
type ToastFn = ReturnType<typeof useToast>;
type Words = ReturnType<typeof translator>;

/** The moves a row's sheet draws, in order. Empty: the row has no ⋯. */
export function menuDoors(row: Pick<BoardRow, "menu" | "startsAt">): MenuDoor[] {
  const m = row.menu;
  if (!m) return [];
  const doors: MenuDoor[] = [];
  if (m.move && row.startsAt) doors.push("move");
  if (m.happened) doors.push("happened");
  if (m.lost) doors.push("lost");
  if (m.del) doors.push("del");
  return doors;
}

/** What a deed needs from where it was tapped: the toast, the list's re-read, the sheet's close, the words. */
export type DoorIo = {
  toast: ToastFn;
  refresh: () => void;
  close: () => void;
  lang: Lang;
  t: Words;
};

/** A refusal from the server: said, the sheet closed, then the list re-read (never under an open sheet). */
function refused(io: DoorIo, sentence: string) {
  io.toast(sentence, "error");
  io.close();
  io.refresh();
}

/** An Undo's own answer: put back said, or why not, and the list re-reads after a written answer. */
function undoWith(io: DoorIo, run: () => Promise<{ ok: boolean; error?: string }>, said: string = io.t("ip_backWhereItWas")) {
  return {
    label: io.t("ag_btn_undo"),
    onClick: () => {
      void run().then(
        (r) => {
          if (!r.ok) io.toast(r.error ?? io.t("vp_thatDidntSave"), "error");
          else io.toast(said, "success");
          io.refresh();
        },
        () => io.toast(io.t("vp_thatDidntSave"), "error"),
      );
    },
  };
}

/**
 * AN UNDO THAT PUTS A STATUS BACK, by the visit page's one rule (wontHappenUndo): back to what it was,
 * except a visit that was waiting on the customer's pick. Marking it done or cancelling it withdrew
 * that link for good, so it comes back Scheduled and the Undo says the link stays withdrawn; written
 * back as proposed it would wait on a pick nobody can make.
 */
function statusUndo(id: string, previousStatus: string, io: DoorIo, setStatus: typeof setAppointmentStatus) {
  const back = wontHappenUndo(previousStatus, io.lang, io.t);
  return undoWith(io, () => setStatus(id, back.status), back.note ? fillSlots(io.t("vp_putBackNote"), { note: back.note }) : io.t("ip_backWhereItWas"));
}

/**
 * IT HAPPENED: the visit is marked done, so it leaves Didn't Happen? for Write Up. The Undo puts its
 * status back (setAppointmentStatus hands over the one it had). The one thing an Undo can't restore, a
 * withdrawn pick-a-time link, is said and kept until it is read.
 */
export async function markItHappened(
  id: string,
  io: DoorIo,
  deps: { setStatus: typeof setAppointmentStatus } = { setStatus: setAppointmentStatus },
): Promise<void> {
  let res: Awaited<ReturnType<typeof setAppointmentStatus>>;
  try {
    res = await deps.setStatus(id, "completed");
  } catch {
    io.toast(io.t("vp_thatDidntSave"), "error");
    return;
  }
  // A zero-row update is a 204, not an error: the action checks, so trust its verdict.
  if (!res.ok) return refused(io, res.error ?? io.t("vp_thatDidntSave"));
  io.close();
  const back = res.previousStatus;
  io.toast(io.t("ip_movedToWriteUp"), "success", back ? statusUndo(id, back, io, deps.setStatus) : undefined);
  if (res.note) io.toast(res.note, "info", undefined, { sticky: true });
  io.refresh();
}

/** LOST: the one ending for a visit that did not become work. The Undo clears the outcome. */
export async function markItLost(
  id: string,
  io: DoorIo,
  deps: { setOutcome: typeof setAppointmentOutcome } = { setOutcome: setAppointmentOutcome },
): Promise<void> {
  let res: Awaited<ReturnType<typeof setAppointmentOutcome>>;
  try {
    res = await deps.setOutcome(id, "lost");
  } catch {
    io.toast(io.t("vp_thatDidntSave"), "error");
    return;
  }
  if (!res.ok) return refused(io, res.error ?? io.t("vp_thatDidntSave"));
  io.close();
  io.toast(io.t("vp_markedLost"), "success", undoWith(io, () => deps.setOutcome(id, null)));
  io.refresh();
}

/**
 * DELETE, the second tap: the visit page's own rule (wontHappenAppointment: removed when nothing hangs
 * on it, otherwise cancelled and kept), said the way the visit page says it. A visit cancelled and
 * kept offers Undo, which puts its status back by the visit page's rule; a toast that carries a
 * withdrawn-link note stays until it is read.
 */
export async function deleteTheVisit(
  id: string,
  io: DoorIo,
  deps: { wontHappen: typeof wontHappenAppointment; setStatus: typeof setAppointmentStatus } = {
    wontHappen: wontHappenAppointment,
    setStatus: setAppointmentStatus,
  },
): Promise<void> {
  let res: Awaited<ReturnType<typeof wontHappenAppointment>>;
  try {
    res = await deps.wontHappen(id);
  } catch {
    io.toast(io.t("vp_thatDidntSave"), "error");
    return;
  }
  if (!res.ok || !res.did) return refused(io, res.error ?? io.t("vp_thatVisitDidntChange"));
  io.close();
  const undo = res.did === "cancelled" && res.previousStatus ? statusUndo(id, res.previousStatus, io, deps.setStatus) : undefined;
  const note = res.did === "cancelled" ? res.note : null;
  io.toast(wontHappenToast(res.did, note, io.lang, io.t), "success", undo, note ? { sticky: true } : undefined);
  io.refresh();
}

/**
 * MOVE, the day picked in the nested sheet: the agenda's own move (keeps the time of day and the
 * length, in the company's timezone). Landed: the sheet closes, the toast names the day, the list
 * re-reads; a withdrawn pick-a-time link is a second toast, kept until it is read. Refused: said, the
 * sheet closes, the list re-reads (the picker closes with it: it has nothing left to say). Thrown:
 * the picker says it where the day was picked, and the sheet stays open.
 */
export async function moveTheVisit(
  row: Pick<BoardRow, "id" | "startsAt" | "endsAt">,
  dateISO: string | null,
  tz: string,
  io: DoorIo,
  deps: { reschedule: typeof rescheduleAppointment } = { reschedule: rescheduleAppointment },
): Promise<MoveToDayResult> {
  // The sheet offers no Move without a start, and no day is no move: nothing was asked of the server.
  if (!row.startsAt || !dateISO) return { ok: false };
  let out: Awaited<ReturnType<typeof moveVisitToDay>>;
  try {
    out = await moveVisitToDay({ id: row.id, starts_at: row.startsAt, ends_at: row.endsAt }, dateISO, tz, deps);
  } catch {
    return { ok: false, error: io.t("vp_thatDidntSave") };
  }
  if (!out.moved) {
    refused(io, out.error ?? io.t("vp_thatDidntSave"));
    return;
  }
  io.close();
  // The company's today, for dayWords' year rule (a day in another year says its year).
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  io.toast(fillSlots(io.t("ip_movedToDay"), { day: dayWords(dateISO, today, tz, io.lang) ?? dateISO }), "success");
  if (out.note) io.toast(out.note, "info", undefined, { sticky: true });
  io.refresh();
}

/** The row's ⋯. Nothing at all when the row has no moves. */
export function InspectionRowMenu({ row, tz }: { row: Row; tz: string }) {
  const doors = menuDoors(row);
  if (doors.length === 0) return null;
  return (
    <RowMoreSheet title={row.who} subline={row.what || null}>
      {({ close }) => <InspectionRowDoors row={row} tz={tz} doors={doors} close={close} />}
    </RowMoreSheet>
  );
}

/**
 * The sheet's inside: its state (resting or asking, a deed out) and its deeds. It lives inside the
 * open sheet, so a closed sheet opens at rest again.
 */
function InspectionRowDoors({ row, tz, doors, close }: { row: Row; tz: string; doors: MenuDoor[]; close: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const io: DoorIo = { toast, refresh: () => router.refresh(), close, lang, t };

  return (
    <InspectionRowMenuView
      doors={doors}
      asking={asking}
      pending={pending}
      onPickDay={(d) => moveTheVisit(row, d, tz, io)}
      onHappened={() => start(() => markItHappened(row.id, io))}
      onLost={() => start(() => markItLost(row.id, io))}
      onAsk={() => setAsking(true)}
      onDelete={() => start(() => deleteTheVisit(row.id, io))}
      onKeep={() => setAsking(false)}
    />
  );
}

/**
 * The sheet's two faces, drawn from what they are handed (so a test reads the asking face, which a
 * tap opens). Resting: the row's moves, one sheet row each. Asking: the question, the deed in red,
 * Keep It beside it. While a deed is out every button waits.
 */
export function InspectionRowMenuView({
  doors,
  asking,
  pending,
  onPickDay,
  onHappened,
  onLost,
  onAsk,
  onDelete,
  onKeep,
}: {
  doors: MenuDoor[];
  asking: boolean;
  pending: boolean;
  onPickDay: (dateISO: string | null) => Promise<MoveToDayResult>;
  onHappened: () => void;
  onLost: () => void;
  onAsk: () => void;
  onDelete: () => void;
  onKeep: () => void;
}) {
  const t = translator(useLang());
  if (asking) {
    return (
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
        <p>{t("ip_deleteAsk")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="text-red-600" disabled={pending} onClick={onDelete}>
            {pending ? t("vp_btn_saving") : t("ip_btn_deleteIt")}
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={onKeep}>
            {t("vp_btn_keepIt")}
          </Button>
        </div>
      </div>
    );
  }
  const move = t("ip_btn_moveToAnotherDay");
  return (
    <>
      {doors.map((door) => {
        switch (door) {
          case "move":
            // The picker's own heading is the row's words without the ellipsis (the ellipsis says a
            // sheet opens; the sheet it opens is that move).
            return (
              <MoveToDay key="move" label={move.replace(/…$/, "")} triggerClassName={SHEET_ROW} onPick={onPickDay}>
                {move}
              </MoveToDay>
            );
          case "happened":
            return (
              <button key="happened" type="button" disabled={pending} onClick={onHappened} className={SHEET_ROW}>
                {t("ip_btn_itHappened")}
              </button>
            );
          case "lost":
            return (
              <button key="lost" type="button" disabled={pending} onClick={onLost} className={SHEET_ROW}>
                {t("ip_btn_lost")}
              </button>
            );
          case "del":
            return (
              <button key="del" type="button" disabled={pending} onClick={onAsk} className={SHEET_ROW}>
                {t("ip_btn_delete")}
              </button>
            );
        }
      })}
    </>
  );
}
