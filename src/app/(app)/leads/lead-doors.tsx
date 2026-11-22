"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast, type ToastAction } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";
import type { Inquiry } from "@/lib/types";
import type { LeadStage } from "@/lib/leads/new-intake";
import { InquiryModal } from "./inquiry-modal";
import { LeadScheduleSheet } from "./convert-menu";
import { reopenLead, setInquiryStatus } from "./actions";

type Toast = (message: string, kind?: "success" | "error" | "info", action?: ToastAction) => void;
/** The reader's words (lib/i18n translator); English when a caller hands none. */
type Words = (key: string) => string;
const ENGLISH: Words = translator("en");

/**
 * NOT SOLD, WITH UNDO (W2-07's Mark Lost, renamed cn-v1170). No confirm: the Undo is the safety, and
 * it puts back the status the lead HAD, carried in the toast (never a guessed "new"). The server
 * refuses while a visit from the lead still stands, and that refusal is said as the server said it.
 */
export async function markLeadNotSold(
  lead: { id: string; name: string; status: string },
  deps: {
    setStatus: (id: string, status: string, opts?: { withUndo?: boolean }) => Promise<{ ok: boolean; error?: string; note?: string }>;
    toast: Toast;
    refresh: () => void;
    t?: Words;
  },
): Promise<void> {
  const t = deps.t ?? ENGLISH;
  const was = lead.status;
  // This door offers the Undo, so the server's sentence may say what Undo cannot bring back (skeptic #83, S6).
  const res = await deps.setStatus(lead.id, "lost", { withUndo: true });
  if (!res?.ok) {
    deps.toast(res?.error ?? t("ld_couldntMarkLost"), "error");
    return;
  }
  // The server's note rides on the same toast (cn-v1180): a pick-a-time link Not Sold withdrew, which
  // is the one part its Undo cannot put back, and the sentence says so.
  const said = [fillText(t("ld_markedLost"), { name: lead.name }), res.note].filter(Boolean).join(". ");
  deps.toast(said, "success", {
    label: t("ld_btn_undo"),
    onClick: () => {
      void (async () => {
        const back = await deps.setStatus(lead.id, was);
        deps.toast(back.ok ? t("ld_putBack") : (back.error ?? t("ld_couldntPutBack")), back.ok ? "success" : "error");
        deps.refresh();
      })();
    },
  });
  deps.refresh();
}

/** REOPEN (cn-v1170): a Not Sold lead goes back on the Leads list. One tap and a toast, no confirm:
 *  nothing is lost by it, and Not Sold is one tap away again. */
export async function reopenNotSoldLead(
  lead: { id: string },
  deps: { reopen: (id: string) => Promise<{ ok: boolean; error?: string }>; toast: Toast; refresh: () => void; t?: Words },
): Promise<void> {
  const t = deps.t ?? ENGLISH;
  const res = await deps.reopen(lead.id);
  if (!res?.ok) {
    deps.toast(res?.error ?? t("ld_couldntReopen"), "error");
    return;
  }
  deps.toast(t("ld_reopened"), "success");
  deps.refresh();
}

/** Reopen, on its own: the doors' notSold stage and each line of the Leads page's Not Sold fold. */
export function ReopenLeadButton({ id }: { id: string }) {
  const t = translator(useLang());
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() => start(() => reopenNotSoldLead({ id }, { reopen: reopenLead, toast, refresh: () => router.refresh(), t }))}
    >
      <RotateCcw className="hidden h-4 w-4 sm:block" /> {t("ld_btn_reopen")}
    </Button>
  );
}

export type LeadDoorsProps = {
  inquiry: Inquiry;
  stage: LeadStage;
  /** The org's own line, so the Let Them Pick handoff can say which number the text will NOT go from. */
  businessPhone: string | null;
  /** Open the Schedule sheet on mount; honoured only when stage is "open". */
  openSchedule?: boolean;
};

/**
 * THE ONE SET OF DOORS FOR A LEAD (cn-v1170), on its row and on its file. Erik, 2026-11-19: "keep
 * edit button, remove everything else except Schedule and Not sold". By stage:
 *   open      Schedule · Not Sold · Edit Details
 *   standing  Edit Details (its visit carries it now)
 *   notSold   Reopen · Edit Details ("the data stays with them in that file for further sales reach out")
 *   converted Edit Details
 * Schedule opens ONE sheet: Book It, Let Them Pick, or Start Now. Delete lives inside Edit Details.
 */
export function LeadDoors({ inquiry, stage, businessPhone, openSchedule = false }: LeadDoorsProps): React.JSX.Element {
  const t = translator(useLang());
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [scheduling, setScheduling] = useState(false);

  // A link that says ?schedule=1 lands with the sheet open, ONCE per mount (cn-v1170): a stage that
  // moves away and back (a booking, then its Undo) must not open it again by itself.
  const openedOnce = useRef(false);
  useEffect(() => {
    if (openedOnce.current || !openSchedule || stage !== "open") return;
    openedOnce.current = true;
    setScheduling(true);
  }, [openSchedule, stage]);

  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-2">
      {stage === "open" && (
        <>
          <Button variant="outline" onClick={() => setScheduling(true)} disabled={pending} title={t("ld_bookInspectionStaysOpen")}>
            <CalendarPlus className="hidden h-4 w-4 sm:block" /> {t("ld_btn_schedule")}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(() =>
                markLeadNotSold(
                  { id: inquiry.id, name: inquiry.name, status: inquiry.status },
                  { setStatus: setInquiryStatus, toast, refresh: () => router.refresh(), t },
                ),
              )
            }
          >
            {t("ld_btn_markLost")}
          </Button>
        </>
      )}
      {stage === "notSold" && <ReopenLeadButton id={inquiry.id} />}
      <InquiryModal mode="edit" inquiry={inquiry} trigger="details" />
      {/* Kept mounted while it is open even when the stage moves: Let Them Pick's link screen must
          stay up after its visit takes the lead off the list (the sheet refreshes on close). */}
      {(stage === "open" || scheduling) && (
        <LeadScheduleSheet
          inquiryId={inquiry.id}
          inquiryName={inquiry.name}
          businessPhone={businessPhone}
          open={scheduling}
          onClose={() => setScheduling(false)}
        />
      )}
    </div>
  );
}
