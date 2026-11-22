"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { linkAppointmentTo } from "../appointments/actions";

/**
 * "DONE AS <JOB>?" (cn-v1175, R5; lib/appointments/visit-offer). A job was made for this visit's own
 * customer record after the visit; the app may not decide it is this visit's work, so it ASKS. One tap
 * swaps the button for the question in place (never the browser's dialog); the yes goes through the
 * visit's own attach door (linkAppointmentTo: the job attached, the visit Won, its lead won with it),
 * the answer is said, and the list reads again, where the visit has left by the one visit rule. Keep It
 * puts the button back. A refusal is said in red and nothing moves.
 */

type Deps = { link: typeof linkAppointmentTo };

/** The yes: tie the visit to the job, say what happened. Returns true when it landed. */
export async function tieVisitToJob(
  visitId: string,
  job: { id: string; label: string },
  io: { toast: ReturnType<typeof useToast>; refresh: () => void; t: (key: string) => string },
  deps: Deps = { link: linkAppointmentTo },
): Promise<boolean> {
  let res: Awaited<ReturnType<typeof linkAppointmentTo>>;
  try {
    res = await deps.link(visitId, "job", job.id);
  } catch {
    io.toast(io.t("vp_thatDidntSave"), "error");
    return false;
  }
  if (!res.ok) {
    io.toast(res.error ?? io.t("vp_thatDidntSave"), "error");
    return false;
  }
  io.toast(fillText(io.t("ip_offerTied"), { job: job.label }), "success");
  if (res.note) io.toast(res.note, "info", undefined, { sticky: true });
  io.refresh();
  return true;
}

/** The ask, drawn from what it is handed (so a test reads the asking face a tap opens). */
export function VisitOfferAsk({
  job,
  pending,
  onYes,
  onKeep,
}: {
  job: { id: string; label: string };
  pending: boolean;
  onYes: () => void;
  onKeep: () => void;
}) {
  const t = translator(useLang());
  return (
    <div className="w-full rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" data-offer-ask="">
      <p>{fillText(t("ip_offerAsk"), { job: job.label })}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={onYes}>
          {pending ? t("vp_btn_saving") : fillText(t("ip_btn_doneAsYes"), { job: job.label })}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onKeep}>
          {t("vp_btn_keepIt")}
        </Button>
      </div>
    </div>
  );
}

/** The row's boxed button when it has an offer. */
export function VisitOfferButton({ visitId, job, className }: { visitId: string; job: { id: string; label: string }; className: string }) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  if (asking) {
    return (
      <VisitOfferAsk
        job={job}
        pending={pending}
        onKeep={() => setAsking(false)}
        onYes={() =>
          start(async () => {
            const landed = await tieVisitToJob(visitId, job, { toast, refresh: () => router.refresh(), t });
            if (!landed) setAsking(false);
          })
        }
      />
    );
  }
  return (
    <button type="button" className={className} data-primary="" data-offer={job.id} onClick={() => setAsking(true)}>
      {fillText(t("ip_btn_doneAs"), { job: job.label })}
    </button>
  );
}
