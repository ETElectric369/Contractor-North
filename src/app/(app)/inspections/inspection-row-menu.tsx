"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import type { Lang } from "@/lib/locale";
import { wontHappenToast, wontHappenUndo } from "@/lib/appointments/wont-happen";
import { notSoldAnswer, undoneKey } from "@/lib/appointments/not-sold";
import { dayWords } from "@/lib/action-items/dated-when";
import { fillSlots } from "@/lib/lang-words";
import { Button } from "@/components/ui/button";
import { MoveToDay, type MoveToDayResult } from "@/components/move-to-day";
import { RowMoreSheet, SHEET_ROW, SheetLink } from "@/components/row-more-sheet";
import { moveVisitToDay } from "../planner/agenda-move";
import { putVisitBackOnSchedule, rescheduleAppointment, setAppointmentOutcome, setAppointmentStatus, wontHappenAppointment } from "../appointments/actions";
import type { ListRow, MenuDoor } from "./list-rows";
import { VisitOfferAsk, tieVisitToJob } from "./visit-offer-button";
import { fillText } from "@/lib/i18n";

/**
 * AN INSPECTION ROW'S ⋯ (Sales › Inspections). The row's moves sit behind the app's one row sheet
 * (components/row-more-sheet), each a full-width row that says what it does, in this order:
 *   · Open Inspection and Pick a Day (cn-v1171): links, to the visit and to the Schedule.
 *   · Move to Another Day…: the one day picker; the visit keeps its time of day and its length, and
 *     the toast names the day it went to.
 *   · It Happened: Write It Up: marks the visit done (Undo puts its status back).
 *   · Not Sold (cn-v1170, was Lost): the visit did not become work; it is kept on file (Undo clears the outcome).
 *   · Dismiss… (cn-v1166; was Delete…): the visit page's own Dismiss, behind its ask; a visit that is cancelled and kept
 *     (something was on it) offers Undo, as the visit's own page does.
 * The page decides which a row gets (list-rows rowDoors); none: no ⋯ at all.
 *
 * ONE ITEM IS ITS OWN BUTTON (cn-v1171; Erik: "if Edit Details is the only option under the ... then
 * just say Edit Details instead of ..."). A row with exactly one move draws it in the row, as a
 * button, and no ⋯. This is the one place that rule lives.
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

type Row = Pick<ListRow, "id" | "who" | "what" | "doors" | "visitHref" | "startsAt" | "endsAt" | "happenedSaid" | "offerOthers">;
type ToastFn = ReturnType<typeof useToast>;
type Words = ReturnType<typeof translator>;

/** A lone move, drawn in the row as an outline button on a 44px target (never a filled one: the row's
 *  boxed button is the one filled). */
export const LONE_DOOR =
  "btn-gloss inline-flex h-11 items-center justify-center whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:border-brand hover:text-brand disabled:opacity-50";

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
 * IT HAPPENED: the visit is marked done, so its row stops saying Day Passed. The toast is the row's
 * own finished sentence (`said`, worded on the server by the estimates switch, cn-v1171): it says an
 * estimate is needed only where the company makes them. The Undo puts its
 * status back (setAppointmentStatus hands over the one it had). The one thing an Undo can't restore, a
 * withdrawn pick-a-time link, is said and kept until it is read.
 */
export async function markItHappened(
  id: string,
  io: DoorIo,
  said: string,
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
  io.toast(said, "success", back ? statusUndo(id, back, io, deps.setStatus) : undefined);
  if (res.note) io.toast(res.note, "info", undefined, { sticky: true });
  io.refresh();
}

/**
 * NOT SOLD (cn-v1170, was Lost): the one ending for a visit that did not become work. When the answer
 * says the visit's lead went Not Sold with it (leadMarked), the toast says so. The Undo clears the
 * outcome, and the server puts a Not Sold lead back by its own rule: the Undo says the lead is open
 * again only when the answer says it was (leadReopened). A lead step that failed (warning) is said.
 */
export async function markItLost(
  id: string,
  io: DoorIo,
  deps: { setOutcome: typeof setAppointmentOutcome; putBack?: typeof putVisitBackOnSchedule } = { setOutcome: setAppointmentOutcome, putBack: putVisitBackOnSchedule },
): Promise<void> {
  let res: Awaited<ReturnType<typeof setAppointmentOutcome>>;
  try {
    res = await deps.setOutcome(id, "lost", { offSchedule: true });
  } catch {
    io.toast(io.t("vp_thatDidntSave"), "error");
    return;
  }
  if (!res.ok) return refused(io, res.error ?? io.t("vp_thatDidntSave"));
  io.close();
  const a = notSoldAnswer(res);
  // A visit answered Not Sold before its day came off the schedule (cn-v1175, R8): the Undo puts it back
  // through the visit page's own door back (putVisitBackOnSchedule): a day still ahead keeps its day; a
  // visit that was waiting on the customer's pick had no agreed day and comes back waiting for one, never
  // Scheduled on a time nobody picked (skeptic #83, S1). Where it went is said.
  const off = res.offSchedule ?? null;
  const undo = {
    label: io.t("ag_btn_undo"),
    onClick: () => {
      void deps
        .setOutcome(id, null)
        .then(async (r) => {
          if (r.ok && off && deps.putBack) {
            const back = await deps.putBack(id, { previousStatus: off.previousStatus });
            if (!back.ok) return { ...r, warning: back.error ?? io.t("vp_thatDidntSave") };
            return { ...r, where: back.message };
          }
          return r;
        })
        .then(
        (r: Awaited<ReturnType<typeof setAppointmentOutcome>> & { where?: string }) => {
          if (!r.ok) io.toast(r.error ?? io.t("vp_thatDidntSave"), "error");
          else {
            const k = undoneKey(r);
            io.toast(`${k ? io.t(k) : io.t("ip_backWhereItWas")}${r.where ? ` ${r.where}` : ""}`, "success");
            if (r.warning) io.toast(r.warning, "error");
          }
          io.refresh();
        },
        () => io.toast(io.t("vp_thatDidntSave"), "error"),
      );
    },
  };
  io.toast(io.t(a.said), "success", undo);
  if (a.warning) io.toast(a.warning, "error");
  // The visit's own withdrawn link and, when its lead went Not Sold with it, the lead's other links
  // (skeptic #83, S9): one sticky note, kept until it is read.
  const links = [off?.note, res.note].filter(Boolean).join(" ");
  if (links) io.toast(links, "info", undefined, { sticky: true });
  io.refresh();
}

/**
 * DISMISS, the second tap: the visit page's own rule (wontHappenAppointment: removed when nothing hangs
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
  row: Pick<ListRow, "id" | "startsAt" | "endsAt">,
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
  const doors = row.doors;
  const others = row.offerOthers ?? [];
  if (doors.length + others.length === 0) return null;
  // One move: its own button in the row, no sheet to close (a lone Dismiss… asks in the row itself).
  if (doors.length === 1 && others.length === 0) return <InspectionRowDoors row={row} tz={tz} doors={doors} close={() => {}} rowClass={LONE_DOOR} />;
  return (
    <RowMoreSheet title={row.who} subline={row.what || null}>
      {({ close }) => <InspectionRowDoors row={row} tz={tz} doors={doors} close={close} />}
    </RowMoreSheet>
  );
}

/**
 * The doors' state (resting or asking, a deed out) and their deeds. Inside the sheet it lives in the
 * open sheet, so a closed sheet opens at rest again; a lone door lives in the row.
 */
function InspectionRowDoors({
  row,
  tz,
  doors,
  close,
  rowClass,
}: {
  row: Row;
  tz: string;
  doors: MenuDoor[];
  close: () => void;
  rowClass?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  const [asking, setAsking] = useState(false);
  const [offerAsked, setOfferAsked] = useState<{ id: string; label: string } | null>(null);
  const [pending, start] = useTransition();
  const io: DoorIo = { toast, refresh: () => router.refresh(), close, lang, t };

  // THE OFFER'S OTHER CANDIDATES (cn-v1175, R5): each asks in the sheet, the same question as the button.
  if (offerAsked) {
    return (
      <VisitOfferAsk
        job={offerAsked}
        pending={pending}
        onKeep={() => setOfferAsked(null)}
        onYes={() =>
          start(async () => {
            const landed = await tieVisitToJob(row.id, offerAsked, { toast, refresh: io.refresh, t });
            if (landed) close();
            else setOfferAsked(null);
          })
        }
      />
    );
  }

  return (
    <>
    {(row.offerOthers ?? []).map((o) => (
      <button key={`offer-${o.id}`} type="button" disabled={pending} onClick={() => setOfferAsked(o)} className={rowClass ?? SHEET_ROW} data-offer={o.id}>
        {fillText(t("ip_btn_doneAs"), { job: o.label })}
      </button>
    ))}
    <InspectionRowMenuView
      doors={doors}
      visitHref={row.visitHref}
      rowClass={rowClass}
      asking={asking}
      pending={pending}
      onPickDay={(d) => moveTheVisit(row, d, tz, io)}
      onHappened={() => start(() => markItHappened(row.id, io, row.happenedSaid))}
      onLost={() => start(() => markItLost(row.id, io))}
      onAsk={() => setAsking(true)}
      onDelete={() => start(() => deleteTheVisit(row.id, io))}
      onKeep={() => setAsking(false)}
    />
    </>
  );
}

/**
 * The sheet's two faces, drawn from what they are handed (so a test reads the asking face, which a
 * tap opens). Resting: the row's moves, one sheet row each. Asking: the question, the deed in red,
 * Keep It beside it. While a deed is out every button waits. `rowClass` is the sheet's row, or a lone
 * door's button in the row.
 */
export function InspectionRowMenuView({
  doors,
  visitHref = "",
  rowClass = SHEET_ROW,
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
  /** The inspection's own page, for Open Inspection. */
  visitHref?: string;
  rowClass?: string;
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
          // Links, not deeds: the sheet goes with the page (SheetLink), and nothing is written.
          case "open":
            return (
              <SheetLink key="open" href={visitHref} className={rowClass}>
                {t("ip_btn_openInspection")}
              </SheetLink>
            );
          case "pickDay":
            return (
              <SheetLink key="pickDay" href="/schedule" className={rowClass}>
                {t("ip_btn_pickADay")}
              </SheetLink>
            );
          case "move":
            // The picker's own heading is the row's words without the ellipsis (the ellipsis says a
            // sheet opens; the sheet it opens is that move).
            return (
              <MoveToDay key="move" label={move.replace(/…$/, "")} triggerClassName={rowClass} onPick={onPickDay}>
                {move}
              </MoveToDay>
            );
          case "happened":
            return (
              <button key="happened" type="button" disabled={pending} onClick={onHappened} className={rowClass}>
                {t("ip_btn_itHappened")}
              </button>
            );
          case "lost":
            return (
              <button key="lost" type="button" disabled={pending} onClick={onLost} className={rowClass}>
                {t("ip_btn_lost")}
              </button>
            );
          case "del":
            return (
              <button key="del" type="button" disabled={pending} onClick={onAsk} className={rowClass}>
                {t("ip_btn_delete")}
              </button>
            );
        }
      })}
    </>
  );
}
