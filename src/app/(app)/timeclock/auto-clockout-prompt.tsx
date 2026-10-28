"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock, Coffee, Loader2, ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { formatDuration } from "@/lib/utils";
import { lunchFits } from "./close-math";
import { lunchMinutesFor, LUNCH_MIN } from "@/lib/lunch-rule";
import { LunchCheckbox } from "@/components/lunch-checkbox";
import { atFromClockTime, clockInputValue, defaultSplitAt, splitClock, splitPreview } from "@/lib/split-preview";
import type { JobCode } from "@/lib/types";
import { completeAutoClockOut, joinTimeEntries } from "./actions";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";
import { useToast } from "@/components/toast";
import { fillText, translator } from "@/lib/i18n";
import { useLang } from "@/components/lang-provider";

type JobOpt = {
  id: string;
  job_number: string;
  name: string;
  address?: string | null;
  customer_name?: string | null; // feeds the codes-off customer · address label
  codes?: string[];
};
type Entry = {
  id: string;
  clock_in: string;
  clock_out: string;
  lunch_minutes: number;
  jobId: string | null;
  jobLabel: string;
};
/** The part of the day before a Switch Job: the caller's own unpaid closed entry that ended when
 *  this one began (0288). Where the lunch usually was (audit v994 SW3). */
type PriorPart = {
  id: string;
  jobLabel: string;
  clock_in: string;
  clock_out: string;
  lunch_minutes: number | null;
};

/**
 * Shown on /timeclock when a shift closed with nobody answering: the geofence auto-clocked the tech
 * out (they drove off the job), or they tapped "clock out now, answer later". The clock times are
 * locked at the close; what is asked after the fact is what the close could not ask:
 *
 *   * Lunch (everyone): the one question a tech can still answer on a finished shift.
 *   * "I Switched Jobs" (the office's own shifts only): a switch time and the job it went to, which
 *     SPLITS the shift into two ordinary entries (0288). After-the-fact splits are office work; a
 *     tech's switch is fixed on Timecards.
 *
 * The old job/hours breakdown is gone: every hour of an entry belongs to its own job now, so there
 * is nothing left to break down.
 */
export function AutoClockoutPrompt({
  entry,
  jobCodes,
  jobs,
  jobCodesEnabled = true,
  isStaff = false,
  tz = "America/Los_Angeles",
  previousPiece = null,
}: {
  entry: Entry;
  previousPiece?: PriorPart | null;
  jobCodes: JobCode[];
  jobs: JobOpt[];
  /** org setting timeclock_job_codes — false hides every code control here. */
  jobCodesEnabled?: boolean;
  isStaff?: boolean;
  tz?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  const optionLabel = (j: JobOpt) => (jobCodesEnabled ? jobLabel(j) : jobSiteLabel(j));
  // Save may only RAISE lunch on a closed shift (the 0143 guard), so a pre-existing 45-minute lunch
  // is the floor, never lowered here.
  const storedLunch = Math.max(0, Number(entry.lunch_minutes) || 0);
  const [tookLunch, setTookLunch] = useState(storedLunch > 0);
  const lunchMin = Math.max(storedLunch, lunchMinutesFor(tookLunch));
  // AFTER A SWITCH JOB the lunch was usually taken before it: offered on the part before, by default,
  // when there is one (audit v994 SW3). A lunch already on this part stays where it is: the choice is
  // only offered when this part carries none, or the one lunch would be docked on both parts.
  const canMoveLunch = !!previousPiece && storedLunch === 0;
  const [lunchOnPrior, setLunchOnPrior] = useState(canMoveLunch);
  const onPrior = canMoveLunch && tookLunch && lunchOnPrior;
  const priorNext = previousPiece ? Math.max(Number(previousPiece.lunch_minutes) || 0, lunchMin) : 0;
  const lunchFitsHere = lunchFits(entry.clock_in, entry.clock_out, onPrior ? 0 : lunchMin);
  const lunchFitsPrior = !!previousPiece && lunchFits(previousPiece.clock_in, previousPiece.clock_out, priorNext);
  // Said before Save, in the same words the server uses: a lunch that fits neither part is refused.
  const min = String(lunchMin);
  const lunchNote = !tookLunch
    ? null
    : onPrior
      ? lunchFitsPrior
        ? null
        : lunchFitsHere
          ? t("tc_acLunchNotFitPrior")
          : fillText(t("tc_acLunchFitsNeither"), { min })
      : lunchFitsHere
        ? null
        : lunchFitsPrior
          ? fillText(t("tc_acLunchLongerThisPart"), { min })
          : fillText(t(previousPiece ? "tc_acLunchLongerPart" : "tc_acLunchLongerWhole"), { min });

  const [switched, setSwitched] = useState(false);
  const firstAt = defaultSplitAt({ clock_in: entry.clock_in, clock_out: entry.clock_out }, tz);
  const [hm, setHm] = useState(firstAt ? clockInputValue(firstAt, tz) : "");
  const [pick, setPick] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const at = switched ? atFromClockTime({ clock_in: entry.clock_in, clock_out: entry.clock_out }, hm, tz) : null;
  const shiftLike = { clock_in: entry.clock_in, clock_out: entry.clock_out, status: "closed", lunch_minutes: onPrior ? storedLunch : lunchMin };
  const preview = splitPreview(shiftLike, at ?? "not a time", null, { tz });
  // The lunch lands on the part it fits; the server tries the other part when the longer one can't
  // hold it, and says so when neither can.
  const fitsOther = !preview.ok && lunchMin > 0 && at ? splitPreview(shiftLike, at, preview.lunchOn === "left" ? "right" : "left", { tz }) : null;
  const shown = fitsOther?.ok ? fitsOther : preview;
  const [kind, val] = pick.split(":");
  const pickedLabel =
    kind === "job" ? (jobs.find((j) => j.id === val) ? optionLabel(jobs.find((j) => j.id === val)!) : t("tc_thatJob")) : kind === "code" ? val : null;
  const canSave = !switched || (!!at && shown.ok && !!pick);

  function save() {
    setError(null);
    start(async () => {
      let res: { ok: boolean; error?: string; warning?: string; split?: { left_id?: string; right_id?: string } };
      try {
        res = await completeAutoClockOut({
          entry_id: entry.id,
          lunch_minutes: lunchMin,
          lunch_on_prior: onPrior,
          switched:
            switched && at
              ? { at, job_id: kind === "job" ? val : null, job_code: kind === "code" ? val : null }
              : null,
        });
      } catch {
        return setError(t("tc_offlineNothingSaved"));
      }
      if (!res.ok) return setError(res.error ?? t("tc_couldNotSave"));
      // The card leaves once it is answered, so what it has to say rides the toast, not the card: the
      // split with its Undo (the same join the Timecards sheet offers), and any money sentence kept on
      // screen until it has been read.
      const left = res.split?.left_id;
      const right = res.split?.right_id;
      toast(
        switched ? t("tc_savedSplit") : t("tc_savedHours"),
        "success",
        switched && left && right
          ? {
              label: t("tc_undo"),
              onClick: () => {
                void joinTimeEntries({ left_id: left, right_id: right })
                  .then((j) => {
                    toast(j.ok ? t("tc_joinedBack") : (j.error ?? t("tc_couldNotJoin")), j.ok ? "success" : "error");
                    router.refresh();
                  })
                  .catch(() => toast(t("tc_offlineSplitStays"), "error"));
              },
            }
          : undefined,
      );
      if (res.warning) toast(res.warning, "info", undefined, { sticky: true });
      router.refresh();
    });
  }

  return (
    <Card className="mb-4 border-amber-300 bg-amber-50/60">
      <CardContent className="space-y-4 py-5">
        <div className="flex items-start gap-2">
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <div className="text-sm font-semibold text-amber-800">
              {fillText(t("tc_finishTimecard"), { time: splitClock(entry.clock_out, tz) })}
            </div>
            <div className="text-xs text-amber-700">
              {fillText(t("tc_acRange"), { from: splitClock(entry.clock_in, tz), to: splitClock(entry.clock_out, tz), job: entry.jobLabel })}
            </div>
          </div>
        </div>

        {storedLunch > LUNCH_MIN ? (
          <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white/60 px-3 py-2 text-sm text-slate-600">
            <Coffee className="h-4 w-4 shrink-0 text-slate-400" />
            {fillText(t("tc_acLunchAlready"), { min: String(storedLunch) })}
          </p>
        ) : (
          <LunchCheckbox id="ac-lunch" checked={tookLunch} onChange={setTookLunch} className="border-amber-200 bg-white/60" />
        )}

        {previousPiece && storedLunch > 0 && storedLunch <= LUNCH_MIN && (
          <p className="text-xs text-slate-600">{fillText(t("tc_acPartHasLunch"), { min: String(storedLunch) })}</p>
        )}
        {canMoveLunch && tookLunch && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white/60 px-3 py-1 text-xs text-slate-600">
            <span>
              {onPrior
                ? fillText(t("tc_acLunchOnPrior"), { job: previousPiece.jobLabel, from: splitClock(previousPiece.clock_in, tz), to: splitClock(previousPiece.clock_out, tz) })
                : fillText(t("tc_acLunchOnThisPart"), { job: entry.jobLabel })}
            </span>
            <button type="button" onClick={() => setLunchOnPrior((v) => !v)} className="min-h-[44px] font-semibold text-brand hover:underline">
              {onPrior ? t("tc_putOnThis") : fillText(t("tc_putOnJob"), { job: previousPiece.jobLabel })}
            </button>
          </div>
        )}
        {lunchNote && <p className="text-xs font-medium text-amber-800">{lunchNote}</p>}

        {isStaff && (
          <div className="space-y-2 rounded-lg border border-amber-200 bg-white/60 p-3">
            <label htmlFor="ac-switched" className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-slate-700">
              <input
                id="ac-switched"
                type="checkbox"
                checked={switched}
                onChange={(e) => setSwitched(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand"
              />
              <ArrowLeftRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <span>{t("tc_iSwitchedJobs")}</span>
            </label>
            {switched && (
              <div className="space-y-2">
                <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                  <Label htmlFor="ac-at" className="mb-0">
                    {t("tc_at")}
                  </Label>
                  <Input id="ac-at" type="time" value={hm} onChange={(e) => setHm(e.target.value)} className="h-11" />
                </div>
                <Select value={pick} onChange={(e) => setPick(e.target.value)} className="h-11 w-full" aria-label={t("tc_jobSwitchedToAria")}>
                  <option value="">{t("tc_pickAJob")}</option>
                  <optgroup label={t("tc_jobsGroup")}>
                    {jobs.map((j) => (
                      <option key={j.id} value={`job:${j.id}`}>
                        {optionLabel(j)}
                      </option>
                    ))}
                  </optgroup>
                  {jobCodesEnabled && jobCodes.length > 0 && (
                    <optgroup label={t("tc_timeCodesGroup")}>
                      {jobCodes.map((c) => (
                        <option key={c.id} value={`code:${c.code}`}>
                          {c.code}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
                {at && shown.ok ? (
                  <p className="text-xs text-slate-600">
                    {fillText(t("tc_acPreviewLeft"), { from: splitClock(entry.clock_in, tz), to: splitClock(at, tz), job: entry.jobLabel, hours: formatDuration(shown.left.hours) })}
                    {shown.left.lunchMinutes > 0 ? ` ${t("tc_withTheLunch")}` : ""}
                    {fillText(t("tc_acPreviewRight"), { from: splitClock(at, tz), to: splitClock(entry.clock_out, tz), job: pickedLabel ?? t("tc_theJobYouPick"), hours: formatDuration(shown.right.hours) })}
                    {shown.right.lunchMinutes > 0 ? ` ${t("tc_withTheLunch")}` : ""}.
                  </p>
                ) : (
                  <p className="text-xs text-amber-800">{shown.problem ?? t("tc_pickSwitchTime")}</p>
                )}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button onClick={save} disabled={pending || !canSave} className="h-11 w-full">
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {t("tc_saving")}
            </>
          ) : (
            t("tc_saveMyHours")
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
