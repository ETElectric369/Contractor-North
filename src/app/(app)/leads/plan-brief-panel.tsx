"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, FileSearch, Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { extOf, intakePaths } from "@/lib/playbook/uploads";
import { parsePlanBrief } from "@/lib/plan-brief";
import { refreshPlanBrief } from "./actions";
import { openLeadInspection } from "../appointments/actions";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";

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
  const t = translator(useLang());

  const brief = parsePlanBrief(intake);
  const hasPdf = intakePaths(intake).some((p) => extOf(p) === "pdf");
  if (!brief && !hasPdf) return null;

  const run = () =>
    start(async () => {
      const r = await refreshPlanBrief(inquiryId);
      if (!r.ok) toast(r.error ?? t("ld_couldntReadPlans"), "error");
      else toast(t("ld_reportReady"), "success");
      router.refresh();
    });

  const runButton = (label: string) => (
    <button
      type="button"
      disabled={pending}
      onClick={run}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
      {pending ? t("ld_btn_readingThePlans") : label}
    </button>
  );

  // A pending run that never finished (function died mid-read) must not look alive forever.
  const stalePending =
    brief?.status === "pending" && (!brief.at || Date.now() - new Date(brief.at).getTime() > 5 * 60 * 1000);

  if (!brief) return <div>{runButton(t("ld_btn_readThePlans"))}</div>;

  if (brief.status === "pending" && !stalePending) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("ld_readingPlansWait")}
      </p>
    );
  }

  if (brief.status !== "ready") {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-amber-700">
          {stalePending ? t("ld_planReadingUnfinished") : (brief.error ?? t("ld_plansCouldntBeRead"))}
        </p>
        {runButton(t("ld_btn_tryAgain"))}
      </div>
    );
  }

  // How many inspection answers the reading seeded, said after the door's own words (" (3 answers ready)").
  const answerCount = Object.keys(brief.answers ?? {}).length;
  const answersReady = answerCount ? ` ${fillText(t(answerCount === 1 ? "ld_answersReadyOne" : "ld_answersReadyMany"), { n: String(answerCount) })}` : "";

  return (
    <div className="space-y-1.5 rounded-lg border border-slate-200 bg-white/70 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {t("ld_reportFromPlans")}
      </p>
      {brief.summary && <p className="text-sm text-slate-700">{brief.summary}</p>}
      {!!brief.scope_included?.length && (
        <p className="text-xs text-slate-600">
          <span className="font-semibold">{t("ld_includes")}</span> {brief.scope_included.join(" · ")}
        </p>
      )}
      {!!brief.scope_excluded?.length && (
        <p className="text-xs text-slate-600">
          <span className="font-semibold">{t("ld_excludes")}</span> {brief.scope_excluded.join(" · ")}
        </p>
      )}
      {!!brief.cautions?.length && (
        <p className="text-xs text-amber-700">
          <span className="font-semibold">{t("ld_verifyOnSite")}</span> {brief.cautions.join(" · ")}
        </p>
      )}
      {!!brief.skipped.length && (
        <p className="text-xs text-slate-400">
          {t("ld_notRead")} {brief.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}
        </p>
      )}
      {/* THE DOOR (Erik: "open the inspector right there with the data all filled in"). Opens the
          lead's existing inspection, or starts one now — either way the answers are seeded.
          Named with the site visit's one word (lib/statuses), Title Case, 44px. */}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await openLeadInspection(inquiryId);
              if (!r.ok || !r.id) {
                toast(r.error ?? t("ld_couldntOpenInspection"), "error");
                return;
              }
              router.push(`/appointments/${r.id}`);
            })
          }
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-sky-600 px-3 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
          {t("ld_btn_openTheInspection")}
          {answersReady}
        </button>
        {runButton(t("ld_btn_readAgain"))}
      </div>
    </div>
  );
}
