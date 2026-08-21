"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, FileSearch, Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { extOf, intakePaths } from "@/lib/playbook/uploads";
import { parsePlanBrief } from "@/lib/plan-brief";
import { refreshPlanBrief } from "./actions";
import { openLeadInspection } from "../appointments/actions";

/**
 * THE PRELIMINARY REPORT ON THE LEAD — the state of a plan reading, and its result.
 *
 * Lives inside the row's ⋯ panel (the negotiated two-line row stays two lines). Four honest
 * states, nothing invented:
 *   · no brief, but a plan PDF exists  → "Read the plans" (covers pre-feature leads and a
 *     background run that died before writing anything)
 *   · pending                          → reading now; stale pending offers the retry
 *   · failed / skipped                 → the reason, and "Try again"
 *   · ready                            → summary, scope in/out, cautions, what was prepared
 *
 * AVAILABLE IS NOT VISIBLE: a lead with no plan uploads renders nothing at all.
 */
export function PlanBriefPanel({ inquiryId, intake }: { inquiryId: string; intake: unknown }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const brief = parsePlanBrief(intake);
  const hasPdf = intakePaths(intake).some((p) => extOf(p) === "pdf");
  if (!brief && !hasPdf) return null;

  const run = () =>
    start(async () => {
      const r = await refreshPlanBrief(inquiryId);
      if (!r.ok) toast(r.error ?? "Couldn't read the plans.", "error");
      else toast("Preliminary report ready.", "success");
      router.refresh();
    });

  const runButton = (label: string) => (
    <button
      type="button"
      disabled={pending}
      onClick={run}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
      {pending ? "Reading the plans…" : label}
    </button>
  );

  // A pending run that never finished (function died mid-read) must not look alive forever.
  const stalePending =
    brief?.status === "pending" && (!brief.at || Date.now() - new Date(brief.at).getTime() > 5 * 60 * 1000);

  if (!brief) return <div>{runButton("Read the plans")}</div>;

  if (brief.status === "pending" && !stalePending) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the plans — the preliminary report will be here in a
        minute.
      </p>
    );
  }

  if (brief.status !== "ready") {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-amber-700">
          {stalePending ? "The plan reading didn't finish." : (brief.error ?? "The plans couldn't be read.")}
        </p>
        {runButton("Try again")}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-slate-200 bg-white/70 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        Preliminary report — from the plans
      </p>
      {brief.summary && <p className="text-sm text-slate-700">{brief.summary}</p>}
      {!!brief.scope_included?.length && (
        <p className="text-xs text-slate-600">
          <span className="font-semibold">Includes:</span> {brief.scope_included.join(" · ")}
        </p>
      )}
      {!!brief.scope_excluded?.length && (
        <p className="text-xs text-slate-600">
          <span className="font-semibold">Excludes:</span> {brief.scope_excluded.join(" · ")}
        </p>
      )}
      {!!brief.cautions?.length && (
        <p className="text-xs text-amber-700">
          <span className="font-semibold">Verify on site:</span> {brief.cautions.join(" · ")}
        </p>
      )}
      {!!brief.skipped.length && (
        <p className="text-xs text-slate-400">
          Not read: {brief.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}
        </p>
      )}
      {/* THE DOOR (Erik: "open the inspector right there with the data all filled in"). Opens the
          lead's existing walk-through, or starts one now — either way the answers are seeded. */}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await openLeadInspection(inquiryId);
              if (!r.ok || !r.id) {
                toast(r.error ?? "Couldn't open the inspection.", "error");
                return;
              }
              router.push(`/appointments/${r.id}`);
            })
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
          Preliminary inspection
          {!!Object.keys(brief.answers ?? {}).length && ` (${Object.keys(brief.answers ?? {}).length} answers ready)`}
        </button>
        {runButton("Read again")}
      </div>
    </div>
  );
}
