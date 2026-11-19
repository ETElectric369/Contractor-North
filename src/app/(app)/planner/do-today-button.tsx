"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { moveJobDay } from "../schedule/actions";

/**
 * DO TODAY: the one tap on a carried-over job's row in My Day (cn-v1169).
 *
 * A job booked for a day that came and went with nobody on it stays on the day of the person who is
 * on it (lib/schedule/carried-over), and this is its door: the day it was booked for MOVES to today,
 * keeping its hours, through the schedule's own move (moveJobDay), the same contract the row's
 * "Move to Another Day…" lands on. A day of that range that WAS worked stays where it happened and
 * only the rest travels, and the answer says which; nothing here decides that.
 *
 * The office's door: moveJobDay is staff-only, and the page draws this for staff only. A tech's row
 * has Navigate and the job itself.
 *
 * A DATE-PICK LINK OUT TO THE CUSTOMER STOPS THE MOVE until the person says to withdraw it: a later
 * tap by the customer on an old option would otherwise overwrite today. That is asked in the app's
 * own sheet with the consequence on the button, never the browser's dialog.
 *
 * Nothing silent: moved is said, a kept worked day is said and stays up until read, a refusal is
 * the server's own sentence, and a dropped connection says nothing moved.
 */

type MoveJobDay = typeof moveJobDay;

/** What one tap came to. */
export type DoTodayOutcome =
  | { kind: "moved"; note: string | null }
  /** A date-pick link is out for this job: ask before withdrawing it. */
  | { kind: "ask" }
  /** `error` null = the request never came back (no connection). */
  | { kind: "refused"; error: string | null };

/**
 * The move, and what it came to. `withdrawLink` is the second tap, after the ask. A link that is
 * STILL in the way on that second call (it cannot be, the call withdraws it) is a refusal with the
 * server's words, never a second ask in a loop.
 */
export async function doToday(move: MoveJobDay, jobId: string, bookedDay: string, todayStr: string, withdrawLink = false): Promise<DoTodayOutcome> {
  let res: Awaited<ReturnType<MoveJobDay>>;
  try {
    res = await move(jobId, bookedDay, todayStr, withdrawLink ? { cancelProposals: true } : undefined);
  } catch {
    return { kind: "refused", error: null };
  }
  if (res.ok) return { kind: "moved", note: (res.note ?? "").trim() || null };
  if (res.needsProposalConfirm && !withdrawLink) return { kind: "ask" };
  return { kind: "refused", error: (res.error ?? "").trim() || null };
}

export function DoTodayButton({
  jobId,
  bookedDay,
  todayStr,
  className,
}: {
  jobId: string;
  /** The day the job was booked for and missed (yyyy-mm-dd, the company's day): the range that moves. */
  bookedDay: string;
  /** Today, the company's day: where it moves to. */
  todayStr: string;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  const [pending, start] = useTransition();
  /** The link ask is open (state, never a remount: the sheet's own history step would close it). */
  const [asking, setAsking] = useState(false);

  const run = (withdrawLink: boolean) =>
    start(async () => {
      const out = await doToday(moveJobDay, jobId, bookedDay, todayStr, withdrawLink);
      if (out.kind === "ask") {
        setAsking(true);
        return;
      }
      setAsking(false);
      if (out.kind === "refused") {
        toast(out.error ?? t("md_doTodayDidntGo"), "error");
        return;
      }
      toast(t("md_movedToToday"), "success");
      // A worked day that stayed where it happened: the server's sentence, kept up until read.
      if (out.note) toast(out.note, "info", undefined, { sticky: true });
      router.refresh();
    });

  return (
    <>
      <button type="button" disabled={pending} onClick={() => run(false)} className={className} title={t("md_doTodayTitle")}>
        <CalendarCheck className="h-4 w-4 shrink-0" /> <span>{pending && !asking ? t("md_doingToday") : t("md_doToday")}</span>
      </button>
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title={t("md_doToday")}
        size="sm"
        footer={<ModalActions onCancel={() => setAsking(false)} onSave={() => run(true)} saveLabel={t("md_moveAndWithdraw")} saving={pending} />}
      >
        <p className="text-sm text-slate-700">{t("md_doTodayLinkOut")}</p>
      </Modal>
    </>
  );
}
