"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { wontHappenToast } from "@/lib/appointments/wont-happen";
import { Button } from "@/components/ui/button";
import { setAppointmentOutcome, wontHappenAppointment } from "../appointments/actions";

/**
 * The two honest answers for a visit that may never have happened (the "Didn't Happen?" group on
 * /inspections): Didn't Happen runs the visit page's own Won't Happen (wontHappenAppointment: removed
 * when nothing hangs on it, otherwise cancelled and kept), Lost records the outcome the same way the
 * visit's ending card does. Each says what it did, or why not, in words.
 *
 * DIDN'T HAPPEN ASKS FIRST, IN THE ROW: the house's two taps (the schedule sheet's Clear the Date,
 * schedule/tile-sheet). The first tap opens the question in the reader's words with the deed and
 * Keep It under it; nothing is written until the second. Never the browser's own dialog: its
 * buttons are the browser's words in the browser's language, and it is the one box that does not
 * look like the app.
 *
 * ON THIS LIST THE ROW SIMPLY LEAVES and the person stays where they are: the list re-reads
 * (router.refresh), and it is alive whatever became of the visit. Only the visit's OWN page has to
 * go somewhere when its visit is gone (appointments/[id]/visit-header-actions).
 */
export function MissedDoors({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();

  const didntHappen = () =>
    start(async () => {
      const res = await wontHappenAppointment(id);
      if (!res.ok || !res.did) {
        toast(res.error ?? t("vp_thatVisitDidntChange"), "error");
        setAsking(false);
        // A refusal means the row is not what this list shows (already cancelled, marked Done, gone):
        // re-read, so the row says what is true instead of offering the same door again.
        router.refresh();
        return;
      }
      toast(wontHappenToast(res.did, res.note, lang, t), "success");
      router.refresh();
    });
  const lost = () =>
    start(async () => {
      const res = await setAppointmentOutcome(id, "lost");
      if (!res.ok) {
        toast(res.error ?? t("vp_thatDidntSave"), "error");
        return;
      }
      toast(t("vp_markedLost"), "success");
      router.refresh();
    });

  return (
    <MissedDoorsView
      asking={asking}
      pending={pending}
      onAsk={() => setAsking(true)}
      onDidntHappen={didntHappen}
      onKeep={() => setAsking(false)}
      onLost={lost}
    />
  );
}

/**
 * The two faces, drawn from what they are handed (so a test can read the asking face, which a tap
 * opens). Resting: Didn't Happen and Lost, side by side at the end of the row. Asking: the question
 * across the row's full width, the deed in red, Keep It beside it.
 */
export function MissedDoorsView({
  asking,
  pending,
  onAsk,
  onDidntHappen,
  onKeep,
  onLost,
}: {
  asking: boolean;
  pending: boolean;
  onAsk: () => void;
  onDidntHappen: () => void;
  onKeep: () => void;
  onLost: () => void;
}) {
  const t = translator(useLang());
  if (asking) {
    return (
      <div className="w-full rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
        <p>{t("ip_didntHappenAsk")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="text-red-600" disabled={pending} onClick={onDidntHappen}>
            {pending ? t("vp_btn_saving") : t("ip_btn_didntHappen")}
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={onKeep}>
            {t("vp_btn_keepIt")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 gap-2">
      <Button type="button" variant="secondary" disabled={pending} onClick={onAsk}>
        {pending ? t("vp_btn_saving") : t("ip_btn_didntHappen")}
      </Button>
      <Button type="button" variant="secondary" disabled={pending} onClick={onLost}>
        {t("ip_btn_lost")}
      </Button>
    </div>
  );
}
