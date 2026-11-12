"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { setAppointmentStatus } from "../actions";
import { useStatusUndo } from "./visit-header-actions";

/** The visit page's main button on an inspection that is booked (W2-11): flips it to `completed`
 *  so the Inspections tab's buckets stay truthful (a visit that happened stops reading as
 *  "upcoming" and lands under the Write Up tile until its estimate exists). 44px, primary: at most one main
 *  button sits in the header, and on a booked inspection this is it. Said in a toast, with Undo:
 *  the page has no other way back from Done. Its words are the signed-in person's language
 *  (lib/words/visit-page, vp_); the page may hand its own label. */
export function MarkCompleteButton({ id, label }: { id: string; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  const undo = useStatusUndo(id);
  const [pending, start] = useTransition();

  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setAppointmentStatus(id, "completed");
          if (!res.ok) {
            toast(res.error ?? t("vp_couldntUpdateStatus"), "error");
            return;
          }
          toast(res.note ? fillText(t("vp_markedDoneNote"), { note: res.note }) : t("vp_markedDone"), "success", undo(res.previousStatus));
          router.refresh();
        })
      }
    >
      <CheckCircle2 className="h-4 w-4" /> {pending ? t("vp_btn_saving") : (label ?? t("vp_btn_markInspectionDone"))}
    </Button>
  );
}
