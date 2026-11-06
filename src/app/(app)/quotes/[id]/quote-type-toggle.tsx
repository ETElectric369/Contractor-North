"use client";

import { useState, useTransition } from "react";
import { SegmentedControl } from "@/components/ui/segmented";
import { setQuoteType } from "../actions";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

/** The two types' words (qt_btn_typeQuote / qt_btn_typeEstimate), read in the person's language. */
const LABEL_KEY: Record<"estimate" | "quote", string> = {
  quote: "qt_btn_typeQuote",
  estimate: "qt_btn_typeEstimate",
};

/** Fixed-price quote vs time-&-materials estimate — same document, the label and
 *  the printed wording follow this.
 *
 *  THE INV-069 SHAPE, ON THE ESTIMATE PAGE (2026-09-18 sweep).
 *
 *  Erik pressed Pay Now on a draft invoice, the server promoted it behind his back, and the page
 *  he was looking at went on showing draft controls over a locked row. This toggle is the same
 *  disagreement pointed the other way: it rendered at EVERY status and flipped the visible
 *  selection the instant it was clicked, before the server had said anything. setQuoteType's rule
 *  is quoted below — on a sent estimate the click was always going to be refused, so the pill
 *  showed "Estimate (T&M)" for one beat on a document whose stored PDF says "fixed price", then
 *  snapped back with no word about why. The screen must never assert something the database has
 *  not agreed to.
 *
 *  Two changes, both of them that one rule:
 *  1. Past draft the toggle does not render at all — the type reads as plain text, with the one
 *     sentence that says what CAN be done (the invoice page's own answer, invoice-detail.tsx:877,
 *     where a sent invoice's tax picker becomes the rate as text).
 *  2. While it does render, the selection moves only after the write lands. A refusal stays on
 *     screen instead of being thrown away — `void setQuoteType(...)` discarded the result, so a
 *     failure was, by construction, silent.
 *
 *  `status` is optional because this control is composed by the page; when the page hasn't said
 *  what the status is we cannot gate on a guess (a gate that disagrees with the server rule is
 *  the same bug moved), so the toggle renders and the server's answer is shown either way. */
export function QuoteTypeToggle({
  id,
  value,
  status,
}: {
  id: string;
  value: "estimate" | "quote";
  /** The quote's status. The gate needs it; pass `q.status` from the page. */
  status?: string | null;
}) {
  const [type, setType] = useState<"estimate" | "quote">(value);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const t = translator(useLang());

  function pick(next: "estimate" | "quote") {
    if (next === type || pending) return;
    setError(null);
    start(async () => {
      const res = await setQuoteType(id, next);
      // THE SILENT-WRITE LAW: the old call was `void setQuoteType(...)`, so a refusal — or a
      // dead database — landed nowhere at all and the pill simply sat on the new value.
      if (!res?.ok) {
        setError(res?.error ?? t("qt_couldntChangeType"));
        return;
      }
      setType(next);
    });
  }

  /**
   * setQuoteType, quoted exactly:
   *   const curStatus = (cur as { status?: string } | null)?.status;
   *   if (curStatus && curStatus !== "draft") {
   *     return { ok: false, error: "This estimate was already sent — its type can't be changed…" };
   *   }
   * Anything that is not a draft can only ever be refused, so it is not offered.
   */
  if (status && status !== "draft") {
    return (
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-700">{t(LABEL_KEY[type])}</div>
        <div className="text-xs text-slate-500">
          {t("qt_typeSetAlreadySent")}
        </div>
      </div>
    );
  }

  return (
    // No min-w-0 on this wrapper: the header row sizes the ~250px pill by its content, and
    // letting it shrink below that is how the share icon got pushed off a 375px screen once.
    <div>
      <div title={t("qt_typeTitle")}>
        <SegmentedControl
          activeId={type}
          onSelect={(id) => pick(id as "estimate" | "quote")}
          items={[
            { id: "quote", label: t(LABEL_KEY.quote) },
            { id: "estimate", label: t(LABEL_KEY.estimate) },
          ]}
        />
      </div>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  );
}
