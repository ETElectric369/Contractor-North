"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { duplicateTimeEntry } from "../timeclock/actions";

/** One-tap copy of a finished timecard entry (same person/job/times), which the
 *  user can then edit (e.g. change the date) — handy for repeating days. */
export function DuplicateEntryButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      onClick={() => start(async () => { await duplicateTimeEntry(id); router.refresh(); })}
      disabled={pending}
      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
      title="Duplicate entry"
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}
