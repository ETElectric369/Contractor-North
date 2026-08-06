"use client";

import { useState, useTransition } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { uploadDisplayName } from "@/lib/playbook/uploads";
import { intakeFileUrl } from "./actions";

/**
 * WHAT THE CUSTOMER ATTACHED, on the lead.
 *
 * An upload nobody can open is worse than no upload — it is a promise the office can't keep. The
 * bucket is private (0186), so each link is minted on demand: staff-only, re-checked against the
 * caller's own org AND against the paths this specific lead actually carries, and good for ten
 * minutes. Nothing durable is ever rendered into the page, so a screenshot of this row leaks
 * nothing.
 */
export function IntakeFiles({ inquiryId, paths }: { inquiryId: string; paths: string[] }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  if (!paths.length) return null;

  return (
    <div className="mt-1.5">
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {paths.map((p) => (
          <li key={p}>
            <button
              type="button"
              disabled={busy === p}
              onClick={() =>
                start(async () => {
                  setErr(null);
                  setBusy(p);
                  const r = await intakeFileUrl(inquiryId, p);
                  setBusy(null);
                  if (!r.ok) return setErr(r.error);
                  // A new tab, not a navigation: the office is mid-triage on this list.
                  window.open(r.url, "_blank", "noopener,noreferrer");
                })
              }
              className="inline-flex max-w-[16rem] items-center gap-1 text-sm text-brand underline-offset-2 hover:underline"
            >
              {busy === p ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Paperclip className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{uploadDisplayName(p)}</span>
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="mt-1 text-xs text-rose-600">{err}</p>}
    </div>
  );
}
