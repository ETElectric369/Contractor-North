"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { formatDate } from "@/lib/utils";
import { estimateStatusLabel } from "@/lib/statuses";
import { notSoldAnswer, undoneKey } from "@/lib/appointments/not-sold";
import { wonStartShown } from "@/lib/appointments/won-sheet";
import { searchJobsForVisit, setAppointmentOutcome } from "../actions";
import { LinkPicker } from "./link-picker";

/**
 * HOW THE VISIT ENDED — said on the visit, with the door to say it (cn-v1069).
 *
 * The visit page never read what it became: an estimate written up from it (capture.quote_id) was
 * nowhere on the page, Start the Estimate was offered again over a finished one, and the outcome
 * 0205 gave every visit (won / lost) was written by the estimate's status and
 * by Nort and shown by neither. Erik's two meetings "with nothing else to come of them" had no door
 * at all on the page: only Nort could close them.
 *
 *   Written up as EST-0042 · sent          the estimate, as a link; a dead one says so
 *   Won · Jun 14 · J-039 The Bayberry place  the outcome, with its day and the job when there is one
 *   [Not Sold]  Already Have the Job? Pick It
 *                                          the office's doors on a completed visit with a win or
 *                                          loss to record (a meeting too), still undecided, no job,
 *                                          no live estimate. WON IS THE INSPECTOR'S BOTTOM DOOR now
 *                                          (cn-v1176, "Won · Start the Job": the job comes FROM the
 *                                          sale, the owner's "opposite direction of flow"); the card
 *                                          keeps only the quiet pick for a job that already exists,
 *                                          narrowed to this visit's own customer and lead
 *                                          (searchJobsForVisit), through the attach door
 *                                          (linkAppointmentTo, which stamps won).
 *   Won · No job yet. [Won · Start the Job]  a visit marked Won with no job: the link opens the
 *                                          Won sheet (?won=1), with the same quiet pick beside it.
 *
 * The outcome is the visit's own answer (setAppointmentOutcome), the same column the estimate's
 * Accepted / Declined and the Inspections tab's bucket read. Change re-opens the three words; Clear
 * takes the answer back. Nothing here is drawn for a visit with nothing to say. Every word is the
 * signed-in person's language (lib/words/visit-page, vp_); the estimate's stored status word stays
 * as stored.
 */
export type VisitEstimate = { id: string; number: string | null; status: string | null; live: boolean };
export type VisitOutcomeWord = "won" | "lost" | "no_bid";

type Words = (key: string) => string;

// ONE WORD FOR AN ENDING THAT ISN'T A WIN (Erik, 2026-10-08: "just keep Lost everywhere - KISS"; and
// 2026-11-19, cn-v1170: "Not Sold" replaces "Lost"). The column still holds no_bid on a few old rows
// (Nort's tool can write it); every one of them reads Not Sold.
const WORD_KEY: Record<VisitOutcomeWord, string> = { won: "vp_won", lost: "vp_lost", no_bid: "vp_lost" };

/** The outcome, in the page's words (the reader's language when handed its translator; English by
 *  default); an unknown stored word is shown as stored, never hidden. */
export function outcomeWord(outcome: string | null | undefined, t: Words = translator("en")): string | null {
  if (!outcome) return null;
  const key = WORD_KEY[outcome as VisitOutcomeWord];
  return key ? t(key) : outcome;
}

/** Whether the office is offered the ending doors: a completed estimate visit, still undecided, with
 *  no job and no live estimate (a live one decides it from the estimate's side). Pure, for the test. */
export function endingOffered(v: {
  isStaff: boolean;
  status: string | null;
  outcome: string | null;
  hasJob: boolean;
  estimateLive: boolean;
  decidable: boolean;
}): boolean {
  return v.isStaff && v.decidable && v.status === "completed" && !v.outcome && !v.hasJob && !v.estimateLive;
}

/** A visit marked Won with no job picked (cn-v1175, R8): the card says so and opens the Won sheet (cn-v1176). */
export function jobAsked(v: { isStaff: boolean; decidable: boolean; outcome: string | null; hasJob: boolean }): boolean {
  return v.isStaff && v.decidable && v.outcome === "won" && !v.hasJob;
}

const DOOR = "inline-flex min-h-[44px] items-center justify-center";

export function VisitEnding({
  appointmentId,
  isStaff,
  decidable,
  status,
  estimate,
  outcome,
  outcomeAt,
  job,
  tz,
  seed = "",
  visitType,
}: {
  appointmentId: string;
  isStaff: boolean;
  /** A visit with a win or a loss to record (lib/statuses DECIDABLE_VISIT_TYPES): not a work visit, not a final inspection. */
  decidable: boolean;
  status: string | null;
  estimate: VisitEstimate | null;
  outcome: string | null;
  outcomeAt: string | null;
  job: { id: string; job_number: string | null; name: string | null } | null;
  tz: string;
  /** What the job picker searches first: the visit's address (jobs are named by street). */
  seed?: string;
  /** The visit's stored type: the Won sheet's link is drawn only for a type the sheet takes (cn-v1176
   *  fix F2, won-sheet wonStartShown); any other Won visit with no job keeps the quiet pick only. */
  visitType: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const lang = useLang();
  const t = translator(lang);
  const [changing, setChanging] = useState(false);
  const [pending, start] = useTransition();

  const word = outcomeWord(outcome, t);
  const offered = endingOffered({ isStaff, status, outcome, hasJob: !!job, estimateLive: !!estimate?.live, decidable });
  if (!estimate && !word && !offered) return null;

  function decide(next: VisitOutcomeWord | null) {
    start(async () => {
      const res = await setAppointmentOutcome(appointmentId, next);
      if (!res.ok) {
        toast(res.error ?? t("vp_thatDidntSave"), "error");
        return;
      }
      if (next === "lost") {
        // cn-v1170: Not Sold may close the visit's lead too, and the toast says so. The Undo clears the
        // answer; the server reopens the lead by its own rule and says whether it did (leadReopened).
        const a = notSoldAnswer(res);
        toast(t(a.said), "success", {
          label: t("vp_btn_undo"),
          onClick: () => {
            void setAppointmentOutcome(appointmentId, null).then(
              (r) => {
                toast(r.ok ? t(undoneKey(r) ?? "vp_answerCleared") : (r.error ?? t("vp_thatDidntSave")), r.ok ? "success" : "error");
                if (r.ok && r.warning) toast(r.warning, "error");
                router.refresh();
              },
              () => toast(t("vp_thatDidntSave"), "error"),
            );
          },
        });
        if (a.warning) toast(a.warning, "error");
      } else {
        toast(next ? t("vp_markedWon") : t("vp_answerCleared"), "success");
        // Won or cleared may put the visit's Not Sold lead back; a lead step that failed is said.
        if (res.warning) toast(res.warning, "error");
      }
      setChanging(false);
      router.refresh();
    });
  }

  // THE QUIET PICK (cn-v1176): a job that already exists for this visit's customer or lead, through the
  // attach door; the narrowed search re-reads the visit on the server.
  const pick = !job && (
    <div className="min-w-[14rem] flex-1 [&>div]:mt-0">
      <LinkPicker
        appointmentId={appointmentId}
        linked={null}
        seed={seed}
        kinds={["job"]}
        openLabel={t("vp_btn_alreadyHaveTheJobPickIt")}
        label={null}
        search={(q) => searchJobsForVisit(appointmentId, q)}
      />
    </div>
  );

  const choices = (
    <div className="mt-2 flex flex-wrap items-start gap-2">
      <Button type="button" variant="secondary" disabled={pending} className={DOOR} onClick={() => decide("lost")}>
        {t("vp_btn_lost")}
      </Button>
      {pick}
      {changing && (
        <>
          {outcome && (
            <Button type="button" variant="ghost" disabled={pending} className={DOOR} onClick={() => decide(null)}>
              {t("vp_btn_clearTheAnswer")}
            </Button>
          )}
          <Button type="button" variant="ghost" disabled={pending} className={DOOR} onClick={() => setChanging(false)}>
            {t("vp_btn_keepIt")}
          </Button>
        </>
      )}
    </div>
  );

  return (
    <div className="my-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-sm" data-testid="visit-ending">
      {estimate && (
        <p className="text-slate-700">
          {t("vp_writtenUpAs")}{" "}
          <Link href={`/quotes/${estimate.id}`} className="font-medium text-brand hover:underline">
            {estimate.number ?? t("vp_btn_theEstimate")}
          </Link>
          {estimate.status ? ` · ${estimateStatusLabel(estimate.status, lang, t)}` : ""}
          {!estimate.live && <span className="text-slate-500"> {t("vp_estimateIsOver")}</span>}
        </p>
      )}
      {word && (
        <p className={`flex flex-wrap items-center gap-x-2 text-slate-700 ${estimate ? "mt-1" : ""}`}>
          <span className="font-medium">{word}</span>
          {outcomeAt && <span className="text-slate-500">· {formatDate(outcomeAt, tz, lang)}</span>}
          {outcome === "won" && job && (
            <Link href={`/jobs/${job.id}`} className="text-brand hover:underline">
              · {[job.job_number, job.name].filter(Boolean).join(" ")}
            </Link>
          )}
          {isStaff && !changing && (
            <button type="button" onClick={() => setChanging(true)} className="min-h-[44px] text-xs text-slate-500 underline-offset-2 hover:underline">
              {t("vp_btn_change")}
            </button>
          )}
        </p>
      )}
      {offered && !changing && (
        <>
          <p className={`text-slate-700 ${estimate ? "mt-2" : ""}`}>{t("vp_howDidThisOneEnd")}</p>
          {choices}
        </>
      )}
      {/* A WIN WITH NO JOB IS NOT AN ENDING (cn-v1175, R8; cn-v1176): the card says so, and its ONE link
          opens the Won sheet (the Inspector's bottom door, ?won=1); the quiet pick sits beside it. Not
          Sold stays behind Change. */}
      {jobAsked({ isStaff, decidable, outcome, hasJob: !!job }) && !offered && !changing && (
        <>
          <p className="mt-1 text-slate-600" data-won-no-job="">
            {t("vp_noJobYet")}
          </p>
          <div className="mt-2 flex flex-wrap items-start gap-2">
            {wonStartShown({ type: visitType, outcome, hasJob: !!job }) && (
              <Link
                href={`/appointments/${appointmentId}?won=1`}
                scroll={false}
                className={`${DOOR} rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:border-brand hover:text-brand`}
                data-won-start=""
              >
                {t("vi_btn_wonStartTheJob")}
              </Link>
            )}
            {pick}
          </div>
        </>
      )}
      {changing && choices}
    </div>
  );
}
