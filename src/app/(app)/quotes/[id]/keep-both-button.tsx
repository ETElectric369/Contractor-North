"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { keepBothEstimates } from "../actions";

/**
 * KEEP BOTH (cn-v1168): the door on a revision's page, and on the page of the estimate it replaced.
 *
 * Erik, 2026-11-19: two quotes for the two units of a duplex, the second made with Revise on the first;
 * the customer accepted both and the first "got locked and dissapeared to the bottom of the list, if i
 * wanted it gone i would have deleted it". This is the one tap that says the two are separate work.
 *
 * TWO TAPS, never the browser's dialog: the first says what will happen, in the two estimates' own
 * numbers; the second does it (quotes/actions keepBothEstimates). WHICH SENTENCE is the page's to say
 * (`comeback`, worked out on the server by the deed's own rule, lib/estimate/revision comebackOf): the
 * estimate that was replaced counts again (it was accepted), is an open offer again (it was only
 * sent), or nothing comes back because the revision is not accepted yet. `revisionId` is always the estimate
 * that carries the pointer, whichever page the door is drawn on. What it did is a sentence that has to
 * be READ (which estimate counts again, what the job's list did), so it stays up until it is; anything
 * that could not be finished rides beside it with its one next step. A refusal is said here and
 * nothing closes.
 */
export function KeepBothButton({
  revisionId,
  revision,
  original,
  comeback,
}: {
  revisionId: string;
  /** The revision's number, as the sentence says it. */
  revision: string;
  /** The number of the estimate it revises. */
  original: string;
  /** Where the original comes back to when this revision is un-linked; null = nothing comes back
   *  (the revision is not accepted yet, so its pointer has replaced nothing). */
  comeback: "accepted" | "sent" | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!asking) {
    return (
      <div className="mt-2">
        <Button
          variant="outline"
          onClick={() => {
            setError(null);
            setAsking(true);
          }}
        >
          {t("qe_btn_keepBoth")}
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2 max-w-xl rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
      <p className="text-sm text-slate-700">
        {fillText(t(comeback === "accepted" ? "qe_keepBothAskReplaced" : comeback === "sent" ? "qe_keepBothAskOffer" : "qe_keepBothAskPending"), { revision, original })}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              let res: Awaited<ReturnType<typeof keepBothEstimates>>;
              try {
                res = await keepBothEstimates(revisionId);
              } catch {
                return setError(t("qe_keepBothDidntGo"));
              }
              if (!res.ok) return setError(res.error ?? t("qe_keepBothDidntGo"));
              if (res.said) toast(res.said, "success", undefined, { sticky: true });
              if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
              setAsking(false);
              router.refresh();
            })
          }
        >
          {pending ? t("qe_btn_keepingBoth") : t("qe_btn_keepBoth")}
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => setAsking(false)}>
          {t("qt_btn_cancel")}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </div>
  );
}
