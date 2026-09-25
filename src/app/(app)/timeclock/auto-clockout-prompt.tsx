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
  const optionLabel = (j: JobOpt) => (jobCodesEnabled ? jobLabel(j) : jobSiteLabel(j));
  // Save may only RAISE lunch on a closed shift (the 0143 guard), so a pre-existing 45-minute lunch
  // is the floor, never lowered here.
  const storedLunch = Math.max(0, Number(entry.lunch_minutes) || 0);
  const [tookLunch, setTookLunch] = useState(storedLunch > 0);
  const lunchMin = Math.max(storedLunch, lunchMinutesFor(tookLunch));
  // AFTER A SWITCH JOB the lunch was usually taken before it: offered on the part before, by default,
  // when there is one (audit v994 SW3). A lunch already on this part stays where it is.
  const [lunchOnPrior, setLunchOnPrior] = useState(!!previousPiece);
  const onPrior = !!previousPiece && tookLunch && lunchOnPrior && storedLunch <= LUNCH_MIN;
  const priorNext = previousPiece ? Math.max(Number(previousPiece.lunch_minutes) || 0, lunchMin) : 0;
  const lunchFitsHere = lunchFits(entry.clock_in, entry.clock_out, onPrior ? 0 : lunchMin);
  const lunchFitsPrior = !!previousPiece && lunchFits(previousPiece.clock_in, previousPiece.clock_out, priorNext);
  // Said before Save, in the same words the server uses: a lunch that fits neither part is refused.
  const lunchNote = !tookLunch
    ? null
    : onPrior
      ? lunchFitsPrior
        ? null
        : lunchFitsHere
          ? "The lunch doesn't fit the part before the switch, so it will go on this part."
          : `A ${lunchMin}-minute lunch doesn't fit either part of this shift. Untick it, or ask the office to fix it on Timecards.`
      : lunchFitsHere
        ? null
        : lunchFitsPrior
          ? `The ${lunchMin}-minute lunch is longer than this part of your shift, so it will go on the part before the switch.`
          : `A ${lunchMin}-minute lunch is longer than this ${previousPiece ? "part of your shift" : "shift"}. Untick it, or ask the office to fix it on Timecards.`;

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
    kind === "job" ? (jobs.find((j) => j.id === val) ? optionLabel(jobs.find((j) => j.id === val)!) : "that job") : kind === "code" ? val : null;
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
        return setError("No connection — nothing was saved. Try again when you have a bar or two.");
      }
      if (!res.ok) return setError(res.error ?? "Could not save.");
      // The card leaves once it is answered, so what it has to say rides the toast, not the card: the
      // split with its Undo (the same join the Timecards sheet offers), and any money sentence kept on
      // screen until it has been read.
      const left = res.split?.left_id;
      const right = res.split?.right_id;
      toast(
        switched ? "Saved. The shift is split into 2 entries." : "Saved your hours.",
        "success",
        switched && left && right
          ? {
              label: "Undo",
              onClick: () => {
                void joinTimeEntries({ left_id: left, right_id: right })
                  .then((j) => {
                    toast(j.ok ? "Joined back into one shift. Your lunch stays saved." : (j.error ?? "Couldn't join them back."), j.ok ? "success" : "error");
                    router.refresh();
                  })
                  .catch(() => toast("No connection — the split is still there. Join it back on Timecards.", "error"));
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
              Finish your timecard — you clocked out at {splitClock(entry.clock_out, tz)}.
            </div>
            <div className="text-xs text-amber-700">
              {splitClock(entry.clock_in, tz)}–{splitClock(entry.clock_out, tz)} on {entry.jobLabel}. Nobody was asked about lunch when it closed.
            </div>
          </div>
        </div>

        {storedLunch > LUNCH_MIN ? (
          <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white/60 px-3 py-2 text-sm text-slate-600">
            <Coffee className="h-4 w-4 shrink-0 text-slate-400" />
            {`A ${storedLunch}-minute unpaid lunch is already on this shift.`}
          </p>
        ) : (
          <LunchCheckbox id="ac-lunch" checked={tookLunch} onChange={setTookLunch} className="border-amber-200 bg-white/60" />
        )}

        {previousPiece && tookLunch && storedLunch <= LUNCH_MIN && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-white/60 px-3 py-1 text-xs text-slate-600">
            <span>
              {onPrior
                ? `The lunch goes on ${previousPiece.jobLabel} (${splitClock(previousPiece.clock_in, tz)}–${splitClock(previousPiece.clock_out, tz)}), before the switch.`
                : `The lunch goes on ${entry.jobLabel}, this part of your shift.`}
            </span>
            <button type="button" onClick={() => setLunchOnPrior((v) => !v)} className="min-h-[44px] font-semibold text-brand hover:underline">
              {onPrior ? "Put It On This Part" : `Put It On ${previousPiece.jobLabel}`}
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
              <span>I Switched Jobs During This Shift</span>
            </label>
            {switched && (
              <div className="space-y-2">
                <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                  <Label htmlFor="ac-at" className="mb-0">
                    At
                  </Label>
                  <Input id="ac-at" type="time" value={hm} onChange={(e) => setHm(e.target.value)} className="h-11" />
                </div>
                <Select value={pick} onChange={(e) => setPick(e.target.value)} className="h-11 w-full" aria-label="The job you switched to">
                  <option value="">Pick A Job</option>
                  <optgroup label="Jobs">
                    {jobs.map((j) => (
                      <option key={j.id} value={`job:${j.id}`}>
                        {optionLabel(j)}
                      </option>
                    ))}
                  </optgroup>
                  {jobCodesEnabled && jobCodes.length > 0 && (
                    <optgroup label="Time Codes — Paid, Not Billed">
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
                    {`${splitClock(entry.clock_in, tz)}–${splitClock(at, tz)} on ${entry.jobLabel} (${formatDuration(shown.left.hours)})`}
                    {shown.left.lunchMinutes > 0 ? " with the lunch" : ""}
                    {`, then ${splitClock(at, tz)}–${splitClock(entry.clock_out, tz)} on ${pickedLabel ?? "the job you pick"} (${formatDuration(shown.right.hours)})`}
                    {shown.right.lunchMinutes > 0 ? " with the lunch" : ""}.
                  </p>
                ) : (
                  <p className="text-xs text-amber-800">{shown.problem ?? "Pick the time you switched."}</p>
                )}
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button onClick={save} disabled={pending || !canSave} className="h-11 w-full">
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Saving
            </>
          ) : (
            "Save My Hours"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
