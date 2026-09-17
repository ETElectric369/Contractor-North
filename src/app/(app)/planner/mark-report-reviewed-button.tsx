"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { markDailyReportReviewed } from "../timeclock/actions";
import { useToast } from "@/components/toast";

/** Check off a crew-lead daily report (filed → reviewed) from My Day's Daily Reports
 *  card — the office's "seen it" stamp on the clock-out debrief. It lived beside
 *  /timecards while the review list did (cn-v958 moved both): the debrief's headline is
 *  what materials the crew needs TOMORROW, which is a My Day question, not a payroll one.
 *  Staff-only by placement AND by the server action (markDailyReportReviewed calls
 *  requireStaff, with the daily_reports_update RLS behind it) — a tech never renders it
 *  and could not land it if they did. */
export function MarkReportReviewedButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const toast = useToast();
  return (
    <button
      onClick={() =>
        start(async () => {
          const res = await markDailyReportReviewed(id);
          if (!res?.ok) { toast(res?.error ?? "Couldn't mark reviewed — try again.", "error"); return; }
          toast("Report marked reviewed", "success");
          router.refresh();
        })
      }
      disabled={pending}
      className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
    >
      <CheckCircle2 className="h-3.5 w-3.5" /> Mark Reviewed
    </button>
  );
}
