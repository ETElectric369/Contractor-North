"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PaperFormatSwitch } from "../paper-format-switch";
import { updateQuoteMeta } from "../actions";
import { saveWords } from "@/lib/save-words";
import type { EstimateFormat } from "@/lib/doc-style";

/**
 * THE PILL MOVES ONLY ON THE SERVER'S OK (the silent-write law), the way QuoteTypeToggle's does. The
 * rule on its own so it can be driven: the write's answer becomes what the control holds next — the
 * pick on ok; a refusal in the server's words, the fallback when it gave none, and "try again" when
 * the call itself threw (a dropped connection is a line under the pill, never the error boundary).
 * `write` is the server action; a test hands in its own.
 */
export async function pickPaperFormat(
  quoteId: string,
  picked: EstimateFormat | null,
  write: (id: string, meta: { estimate_format: EstimateFormat | null }) => Promise<{ ok: boolean; error?: string }> = updateQuoteMeta,
): Promise<{ ok: true; chosen: EstimateFormat | null } | { ok: false; error: string }> {
  const said = await saveWords(() => write(quoteId, { estimate_format: picked }), "Couldn't change the paper format — try again.", "Couldn't reach the server — try again.");
  return said ? { ok: false, error: said } : { ok: true, chosen: picked };
}

/**
 * THE SAVED ESTIMATE'S OWN PAPER FORMAT (cn-v1131). Holds the value and writes it through
 * updateQuoteMeta (pickPaperFormat): the pill moves only after the server said ok; a refusal is said
 * in words under it and the pill stays put. On ok the page is refreshed so the print door and the
 * customer's link read the new format at once.
 */
export function PaperFormatControl({
  quoteId,
  value,
  companyDefault,
}: {
  quoteId: string;
  /** quotes.estimate_format as stored: null = the company default. */
  value: EstimateFormat | null;
  companyDefault: EstimateFormat;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<EstimateFormat | null>(value);
  // Re-seed when the page's read changes (after router.refresh), the member-rate pattern: the pill
  // shows what is STORED, never what was typed into a save that did not land.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setChosen(value);
  }
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function pick(v: EstimateFormat | null) {
    if (v === chosen || pending) return;
    setError(null);
    start(async () => {
      const res = await pickPaperFormat(quoteId, v);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setChosen(res.chosen);
      router.refresh();
    });
  }

  return (
    <div>
      <PaperFormatSwitch value={chosen} companyDefault={companyDefault} onChange={pick} disabled={pending} />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
