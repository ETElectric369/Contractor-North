"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, FilePenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { duplicateQuote } from "../actions";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

/** One-tap clone of this quote (header + line items) into a fresh "(copy)"
 *  draft, then opens it for editing. With `revision` (0391) the copy REVISES this estimate: it keeps
 *  the job, the customer and the lead, and accepting it supersedes this one.
 *
 *  REVISE SAYS WHAT IT DOES BEFORE IT DOES IT (cn-v1168). Both doors make a copy and open it, and the
 *  one difference between them could not be seen until the copy was accepted: the owner, 2026-11-19,
 *  made the second quote of a duplex with Revise, the customer accepted both, and the first was
 *  retired ("if i wanted it gone i would have deleted it"). So Revise's first tap makes nothing: it
 *  says, in this estimate's own number, that the revision REPLACES it when accepted, and offers the
 *  copy that stands on its own right beside the revision. Duplicate is one tap, as it always was.
 *
 *  WHERE REVISE IS DRAWN (cn-v1169): only inside the editor's "These line items are locked" notice on
 *  an accepted estimate, never on the toolbar. His words, the same day: "yes to hiding the revise
 *  button inside locked quotes for good reason". An estimate that is not locked is revised by editing
 *  it. This component renders a fragment (the button, the sentence's full-width panel, an error line),
 *  so whoever mounts it gives it a row that wraps. */
export function DuplicateQuoteButton({ id, revision = false, number = null }: { id: string; revision?: boolean; /** This estimate's number, for the sentence Revise says first. */ number?: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Revise's first tap opened the sentence; nothing is made until one of its two buttons is tapped. */
  const [asking, setAsking] = useState(false);
  /** Which of the two the open sentence is making, so only that button says so. */
  const [making, setMaking] = useState<"revision" | "copy" | null>(null);

  const make = (asRevision: boolean) =>
    start(async () => {
      setError(null);
      setMaking(asRevision ? "revision" : "copy");
      const res = await duplicateQuote(id, asRevision ? { revision: true } : undefined);
      setMaking(null);
      if (!res.ok || !res.id) return setError(res.error ?? (asRevision ? t("qt_couldntRevise") : t("qt_couldntDuplicate")));
      // The copy exists, but something it should carry didn't come: said, and it stays up
      // until read, because the page it lands on would not otherwise say what's missing.
      if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
      setAsking(false);
      router.push(`/quotes/${res.id}`);
    });

  return (
    <>
      <Button
        variant="outline"

        disabled={pending}
        onClick={() => {
          setError(null);
          if (revision) setAsking(true);
          else make(false);
        }}
        title={revision ? t("qt_reviseTitle") : t("qt_duplicateTitle")}
      >
        {revision ? <FilePenLine className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {pending && !asking ? (revision ? t("qt_btn_revising") : t("qt_btn_duplicating")) : revision ? t("qt_btn_revise") : t("qt_btn_duplicate")}
      </Button>
      {revision && asking && (
        <div className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
          <p className="text-sm text-slate-700">{fillText(t("qt_reviseAsk"), { number: number || t("qe_thisEstimate") })}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button disabled={pending} onClick={() => make(true)}>
              {making === "revision" ? t("qt_btn_revising") : t("qt_btn_makeTheRevision")}
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => make(false)}>
              <Copy className="h-4 w-4" /> {making === "copy" ? t("qt_btn_duplicating") : t("qt_btn_duplicateInstead")}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setAsking(false)}>
              {t("qt_btn_cancel")}
            </Button>
          </div>
        </div>
      )}
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </>
  );
}
