"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/input";
import { updateQuoteStatus } from "../actions";
import { QUOTE_STATUSES } from "@/lib/statuses";

/**
 * THE STATUS OF THE DEAL — and it has to actually save.
 *
 * Erik: "i marked the donner pass rd estimate as Declined and it didnt save." This awaited
 * updateQuoteStatus and threw the Result away, with no refresh: a refused write left the select
 * showing the new word while the row still said the old one, and said nothing. Same silent-result
 * class as the tour losing a whole setup. Now the answer is read, the failure is shown, the
 * select snaps back to the truth, and a success refreshes the page that depends on it.
 */
export function StatusControl({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState(status);
  const router = useRouter();
  return (
    <>
    <Select
      value={shown}
      disabled={pending}
      className="h-11 w-40"
      onChange={(e) => {
        const next = e.target.value;
        const prev = shown;
        setShown(next);
        setErr(null);
        start(async () => {
          const res = await updateQuoteStatus(id, next);
          if (!res?.ok) {
            setShown(prev);
            setErr(res?.error ?? "That didn't save — try again.");
            return;
          }
          // Accepted, but the job didn't spin up — say so instead of a silent "done".
          if ("warning" in res && res.warning) setErr(res.warning);
          router.refresh();
        });
      }}
    >
      {/* Options come from the spine (same set updateQuoteStatus validates against). */}
      {QUOTE_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s[0].toUpperCase() + s.slice(1)}
        </option>
      ))}
    </Select>
    {err && <p className="mt-1 text-xs text-rose-600">{err}</p>}
    </>
  );
}
