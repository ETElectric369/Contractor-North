"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Coffee, Car, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { jobLabel } from "@/lib/schedule-options";
import {
  atFromClockTime,
  clockInputValue,
  defaultSplitAt,
  isPaidEntry,
  nudgeSplitAt,
  splitClock,
  splitPreview,
  type SplitSide,
} from "@/lib/split-preview";
import { formatDateTz } from "@/lib/tz";
import type { JobCode } from "@/lib/types";
import { shiftClaim, splitTimeEntry, type SplitResult } from "../timeclock/actions";

/** The columns of an entry the sheet reads. The edit modal's projection already carries all of them. */
export type SplitSheetEntry = {
  id: string;
  clock_in: string;
  clock_out: string | null;
  status?: string | null;
  lunch_minutes: number | null;
  miles?: number | null;
  paid_at?: string | null;
  mileage_paid_at?: string | null;
  job_id?: string | null;
  job_code?: string | null;
  job?: { job_number: string; name: string } | null;
  profiles?: { full_name: string | null } | null;
};

type JobOption = { id: string; job_number: string; name: string };

/** What the sheet opens on: the cut Nort proposed (fill, never execute), or nothing. */
export type SplitPrefill = { at?: string | null; jobId?: string | null; code?: string | null };

const hoursText = (h: number) => `${(Math.round(h * 100) / 100).toString()} h`;

/**
 * SPLIT THIS SHIFT (0288). Erik, 2026-09-24: "i think it will be better if a shift is split to create
 * multiple timecard entries instead of trying to do this complicated thing whatever it is it doesnt
 * work very well".
 *
 * ONE cut, at a clock time. The shift keeps its job and its id as the first part; the second part
 * starts at the cut on the job picked for it. The two parts are ordinary timecard entries, so they
 * cannot add up to more than the shift did: the footer says "same as the shift", and the database
 * asserts it again to the second. A three-job day is two cuts.
 *
 * Nothing is pre-picked for the second part (a guessed job is how hours land on the wrong customer),
 * and nothing is saved until "Split Shift" is tapped. Nort may FILL this sheet (the time and the job
 * it heard); only a person splits.
 */
export function SplitShiftSheet({
  entry,
  jobs,
  jobCodes,
  tz,
  open,
  onClose,
  onSplit,
  prefill,
  action = splitTimeEntry,
  claimLookup = shiftClaim,
  knownClaim,
}: {
  entry: SplitSheetEntry;
  jobs: JobOption[];
  jobCodes: JobCode[];
  tz: string;
  open: boolean;
  onClose: () => void;
  /** Fired once the split landed: the caller closes, refreshes and offers Undo. */
  onSplit: (r: SplitResult) => void;
  prefill?: SplitPrefill | null;
  /** The write. Injected only so a static preview can render the sheet without a server. */
  action?: typeof splitTimeEntry;
  /** Which invoice bills this shift, read when the sheet opens. Injected for the static preview. */
  claimLookup?: typeof shiftClaim;
  /** The caller already knows which invoice bills this shift (null = none): no lookup is made. */
  knownClaim?: { id: string; invoice_number: string | null } | null;
}) {
  const firstAt = (prefill?.at && atFromClockTime(entry, clockInputValue(prefill.at, tz), tz)) || defaultSplitAt(entry, tz);
  const [hm, setHm] = useState(firstAt ? clockInputValue(firstAt, tz) : "");
  const [pick, setPick] = useState(
    prefill?.jobId ? `job:${prefill.jobId}` : prefill?.code ? `code:${prefill.code}` : "",
  );
  const [search, setSearch] = useState("");
  const [lunchOn, setLunchOn] = useState<SplitSide | null>(null);
  const [milesOn, setMilesOn] = useState<SplitSide>("left");
  const [error, setError] = useState<string | null>(null);
  const [invoiceHref, setInvoiceHref] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // CARRIED CLAIMS ARE STATED ON THE SHEET, BEFORE THE TAP. Which invoice bills this shift decides
  // what a split may do: a part on the same job carries that claim, a part on another job is refused.
  // The office reads that here, not in a toast after the sheet has gone.
  const [holder, setHolder] = useState<{ id: string; invoice_number: string | null } | null>(knownClaim ?? null);
  useEffect(() => {
    if (knownClaim !== undefined) return;
    let live = true;
    claimLookup(entry.id)
      .then((r) => {
        if (live && r.ok) setHolder(r.holder);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [claimLookup, entry.id, knownClaim]);

  const at = atFromClockTime(entry, hm, tz);
  const preview = splitPreview(entry, at ?? "not a time", lunchOn, { milesOn, tz });
  const lunch = Math.max(0, Number(entry.lunch_minutes) || 0);
  const miles = Math.max(0, Number(entry.miles) || 0);
  const paid = isPaidEntry(entry);
  const leftLabel = entry.job ? jobLabel(entry.job) : entry.job_code || "No job";

  const [kind, val] = pick.split(":");
  const rightJob = kind === "job" ? jobs.find((j) => j.id === val) : undefined;
  const rightLabel =
    kind === "job"
      ? rightJob
        ? jobLabel(rightJob)
        : val === entry.job_id && entry.job
          ? jobLabel(entry.job)
          : "That job"
      : kind === "code"
        ? val
        : null;

  const q = search.trim().toLowerCase();
  const shownJobs = useMemo(
    () => (q ? jobs.filter((j) => `${j.name} ${j.job_number}`.toLowerCase().includes(q)) : jobs),
    [jobs, q],
  );

  const nudge = (min: number) => {
    const base = at ?? firstAt;
    if (!base) return;
    setError(null);
    setHm(clockInputValue(nudgeSplitAt(entry, base, min, { lunchOn }), tz));
  };

  // The same rule split_time_entry applies: the new part is "the same job" when it names the
  // shift's own job (or, on a job-less shift, no job at all).
  const sameJob = pick ? (kind === "job" ? val === entry.job_id : !entry.job_id) : null;
  const holderName = holder ? (holder.invoice_number ?? "An invoice") : null;
  const crossJobBlocked = !!holder && sameJob === false;

  function save() {
    setError(null);
    setInvoiceHref(null);
    if (!preview.ok || !at) return setError(preview.problem ?? "Pick a split time inside the shift.");
    if (!pick) return setError("Pick a job for the second part.");
    start(async () => {
      let res: SplitResult;
      try {
        res = await action({
          entry_id: entry.id,
          at,
          job_id: kind === "job" ? val : null,
          job_code: kind === "code" ? val : null,
          lunch_on: lunch > 0 ? preview.lunchOn : null,
          miles_on: miles > 0 ? preview.milesOn : null,
        });
      } catch {
        setError("No connection — that didn't go through. Try again in a moment.");
        return;
      }
      if (!res.ok) {
        // Said beside the button that was tapped (the footer), not at the foot of a sheet taller than
        // the phone, under a green "same as the shift" that made a refusal look like success.
        setError(res.error ?? "That split didn't save.");
        if (res.invoiceHref) setInvoiceHref(res.invoiceHref);
        return;
      }
      onSplit(res);
    });
  }

  const person = entry.profiles?.full_name ?? null;
  const day = formatDateTz(entry.clock_in, tz);

  return (
    <Modal
      open={open}
      onClose={() => !pending && onClose()}
      title="Split This Shift"
      portal
      footer={
        <div className="w-full space-y-2">
          {/* NOTHING SILENT: a greyed button has its reason right beside it, in the database's words,
              pinned with the button rather than somewhere up the scroll. */}
          {error ? (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-700" role="alert" aria-live="assertive">
              {error}
              {invoiceHref && (
                <Link href={invoiceHref} className="mt-1 flex min-h-[44px] items-center justify-center font-semibold text-red-800 underline">
                  Open That Invoice
                </Link>
              )}
            </div>
          ) : (
            <p
              className={`text-center text-sm ${
                !preview.ok || crossJobBlocked ? "text-amber-800" : preview.sameAsShift && pick ? "text-emerald-700" : "text-slate-500"
              }`}
              aria-live="polite"
            >
              {!preview.ok
                ? (preview.problem ?? "Pick a split time inside the shift.")
                : crossJobBlocked && pick
                  ? `${holderName} bills this whole shift to ${leftLabel}, so the second part has to stay on ${leftLabel}.`
                  : `${
                      preview.sameAsShift
                        ? `Total ${hoursText(preview.paidHours)}, same as the shift.`
                        : // Each part is rounded to the hundredth on its own, as payroll pays it (SW9).
                          `Total ${hoursText(preview.paidHours)}: each part is rounded on its own, so the two parts pay ${Math.abs(preview.roundingDrift).toFixed(2)} h ${preview.roundingDrift > 0 ? "more" : "less"} than the shift's ${hoursText(preview.shiftHours)}. Move the split a minute to even it out.`
                    }${pick ? "" : " Pick a job for the second part."}`}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <ModalActions
              onCancel={onClose}
              onSave={save}
              saving={pending}
              disabled={!preview.ok || !pick || crossJobBlocked}
              saveLabel="Split Shift"
            />
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* THE WHOLE SHIFT, ON TOP: what is being cut, in the words the timecard uses. */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            {person ? `${person} · ${day}` : day}
          </div>
          <div className="mt-0.5 text-sm font-medium text-slate-900">
            {splitClock(entry.clock_in, tz)}–{entry.clock_out ? splitClock(entry.clock_out, tz) : "now"} · {leftLabel}
          </div>
          <div className="text-xs text-slate-500">
            {hoursText(preview.shiftHours)}
            {lunch > 0 ? ` · ${lunch} min lunch` : ""}
            {miles > 0 ? ` · ${miles} mi` : ""}
          </div>
        </div>

        {paid && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This shift is already paid. Both parts stay on {day} and the pay does not change.
          </p>
        )}

        {holder && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {`${holderName} bills this shift. A second part on the same job stays on ${holderName} and won't be billed again; a part on another job can't be split off until the shift comes off that invoice.`}
            <Link href={`/billing/${holder.id}`} className="mt-1 flex min-h-[44px] items-center font-semibold underline">
              Open That Invoice
            </Link>
          </div>
        )}

        {/* ONE "SPLIT AT" TIME. Defaults to the middle, rounded to 15 minutes; the chips move it. */}
        <div>
          <Label htmlFor="split-at">Split At</Label>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" className="h-11 w-16 shrink-0" onClick={() => nudge(-15)} aria-label="15 minutes earlier">
              −15
            </Button>
            <Input
              id="split-at"
              type="time"
              value={hm}
              onChange={(e) => {
                setError(null);
                setHm(e.target.value);
              }}
              className="h-11 min-w-0 flex-1 text-center text-base"
            />
            <Button type="button" variant="outline" className="h-11 w-16 shrink-0" onClick={() => nudge(15)} aria-label="15 minutes later">
              +15
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* FIRST PART: keeps the shift's job and its id. */}
          <PieceCard
            title="First Part"
            label={leftLabel}
            span={`${splitClock(entry.clock_in, tz)}–${at ? splitClock(at, tz) : "…"}`}
            hours={at ? preview.left.hours : null}
            lunch={lunch}
            lunchHere={preview.lunchOn === "left"}
            onLunchHere={() => setLunchOn("left")}
            miles={miles}
            milesHere={preview.milesOn === "left"}
            onMilesHere={() => setMilesOn("left")}
          />
          {/* SECOND PART: nothing picked until somebody picks it. */}
          <PieceCard
            title="Second Part"
            label={rightLabel}
            span={at ? `${splitClock(preview.right.start, tz)}–${entry.clock_out ? splitClock(entry.clock_out, tz) : "…"}` : "…"}
            hours={at ? preview.right.hours : null}
            lunch={lunch}
            lunchHere={preview.lunchOn === "right"}
            onLunchHere={() => setLunchOn("right")}
            miles={miles}
            milesHere={preview.milesOn === "right"}
            onMilesHere={() => setMilesOn("right")}
          >
            <div className="mt-2 space-y-2">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search jobs"
                aria-label="Search jobs"
                className="h-11"
              />
              <Select
                value={pick}
                onChange={(e) => {
                  setError(null);
                  setPick(e.target.value);
                }}
                className="h-11 w-full"
                aria-label="Job for the second part"
              >
                <option value="">Pick A Job</option>
                {pick.startsWith("job:") && !shownJobs.some((j) => `job:${j.id}` === pick) && rightLabel && (
                  <option value={pick}>{rightLabel}</option>
                )}
                <optgroup label="Recent Jobs">
                  {shownJobs.map((j) => (
                    <option key={j.id} value={`job:${j.id}`}>
                      {jobLabel(j)}
                      {j.id === entry.job_id ? " (same job)" : ""}
                    </option>
                  ))}
                </optgroup>
                {jobCodes.length > 0 && (
                  <optgroup label="Time Codes — Paid, Not Billed">
                    {jobCodes.map((c) => (
                      <option key={c.id} value={`code:${c.code}`}>
                        {c.code}
                        {c.description ? ` — ${c.description}` : ""}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </div>
          </PieceCard>
        </div>
      </div>
    </Modal>
  );
}

function PieceCard({
  title,
  label,
  span,
  hours,
  lunch,
  lunchHere,
  onLunchHere,
  miles,
  milesHere,
  onMilesHere,
  children,
}: {
  title: string;
  label: string | null;
  span: string;
  hours: number | null;
  lunch: number;
  lunchHere: boolean;
  onLunchHere: () => void;
  miles: number;
  milesHere: boolean;
  onMilesHere: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</span>
        <span className="font-mono text-sm tabular-nums text-slate-800">{hours != null ? hoursText(hours) : "—"}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-sm">
        <Scissors className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden />
        <span className="tabular-nums text-slate-600">{span}</span>
      </div>
      <div className={`mt-1 truncate text-sm font-semibold ${label ? "text-slate-900" : "text-slate-400"}`}>{label ?? "Pick A Job"}</div>
      {children}
      {(lunch > 0 || miles > 0) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {lunch > 0 &&
            (lunchHere ? (
              <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-50 px-3 text-xs font-medium text-emerald-800">
                <Coffee className="h-4 w-4" aria-hidden /> Lunch Here · {lunch} min
              </span>
            ) : (
              <Button type="button" variant="outline" className="h-11 text-xs" onClick={onLunchHere}>
                <Coffee className="h-4 w-4" /> Move Lunch Here
              </Button>
            ))}
          {miles > 0 &&
            (milesHere ? (
              <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-slate-100 px-3 text-xs font-medium text-slate-700">
                <Car className="h-4 w-4" aria-hidden /> Miles Here · {miles} mi
              </span>
            ) : (
              <Button type="button" variant="outline" className="h-11 text-xs" onClick={onMilesHere}>
                <Car className="h-4 w-4" /> Move Miles Here
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
