"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { reportBackText } from "@/lib/report-back";
import { markReportedBack } from "../actions";

/**
 * REPORT BACK (cn-v1069): where a time-and-materials job stands, and the two doors that keep the
 * promise it made at the start ("I'll let you know when I get into it far enough").
 *
 *   6h in · guess was 8h          the standing, closed hours against the guess (lib/report-back)
 *   [Text Dana]                   a phone hand-off, the same sms: door as Running Late? on My Day,
 *                                 opened with the figures as they stand; never a message log
 *   [Told Them]                   stamps jobs.report_back_at once; the Needs You row is gone
 *   Told them Oct 7 · Undo        after the stamp; the Text door stays usable any time
 *
 * Office only, on a job that bills its actuals (the page mounts it under the running total). The
 * SHAPE is the app's — the explanation of why the guess was passed is Erik's.
 */
const DOOR = "inline-flex min-h-[44px] items-center justify-center gap-1.5";

export function ReportBackCard({
  jobId,
  jobName,
  customerFirst,
  phone,
  sentence,
  hoursIn,
  guessHours,
  reportedAt,
  tz,
}: {
  jobId: string;
  /** The job's name for the text ("the kitchen hood outlet"), never the bare number alone. */
  jobName: string;
  customerFirst: string | null;
  phone: string | null;
  /** "6h in · guess was 8h" / "6h in, no guess" (lib/report-back standingSentence). */
  sentence: string;
  hoursIn: number;
  guessHours: number | null;
  /** jobs.report_back_at: told, and when. */
  reportedAt: string | null;
  tz: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  function stamp(told: boolean) {
    start(async () => {
      const res = await markReportedBack(jobId, told);
      if (!res.ok) {
        toast(res.error ?? "That didn't save — try again.", "error");
        return;
      }
      toast(told ? "Marked told." : "Taken back.", "success");
      router.refresh();
    });
  }

  const body = reportBackText(customerFirst, jobName, { hoursIn, guessHours });
  const sms = phone ? `sms:${phone}&body=${encodeURIComponent(body)}` : null;

  return (
    <Card id="report-back">
      <CardContent className="py-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Report Back</div>
        <p className="mt-1 text-sm text-slate-800">{sentence}</p>
        {reportedAt ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-500">
            <span>Told them {formatDate(reportedAt, tz)}</span>
            <button type="button" disabled={pending} onClick={() => stamp(false)} className="min-h-[44px] text-xs underline-offset-2 hover:underline">
              Undo
            </button>
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-500">
            {customerFirst ? `${customerFirst} hasn't been told where it stands yet.` : "The customer hasn't been told where it stands yet."}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {sms && (
            <a href={sms} className={`${DOOR} rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800`}>
              <MessageSquare className="h-4 w-4 shrink-0" /> Text {customerFirst ?? "Them"}
            </a>
          )}
          {!reportedAt && (
            <Button type="button" disabled={pending} className={DOOR} onClick={() => stamp(true)}>
              {pending ? "Saving…" : "Told Them"}
            </Button>
          )}
        </div>
        {!sms && !reportedAt && (
          <p className="mt-2 text-xs text-slate-400">No phone on the customer's card, so there is no text door here. Call, then tap Told Them.</p>
        )}
      </CardContent>
    </Card>
  );
}
