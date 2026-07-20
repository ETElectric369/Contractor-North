"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { updateTimeEntry, deleteTimeEntry } from "../timeclock/actions";
import { buildShiftSpan, spanGrossHours } from "../timeclock/shift-span";
import type { JobCode } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";

interface Entry {
  id: string;
  clock_in: string;
  clock_out: string | null;
  lunch_minutes: number;
  job_id?: string | null;
  job_code: string | null;
  notes: string | null;
  miles?: number;
  rate_override?: number | null;
  // Payroll locks — base pay settled / mileage settled. The server hard-blocks
  // pay-relevant changes on locked entries; these let the modal SAY so up front.
  paid_at?: string | null;
  mileage_paid_at?: string | null;
  profile_id?: string;
  profiles?: { full_name: string | null } | null;
  // The entry's current job (joined), so we can keep it as an option even when
  // it's older than the recent-jobs list and would otherwise vanish on save.
  job?: { job_number: string; name: string } | null;
  // Existing split-across-jobs allocations, so the editor round-trips them.
  time_allocations?: { job_id?: string | null; hours?: number | null; job_code?: string | null; description?: string | null }[];
}
interface Member {
  id: string;
  full_name: string | null;
  // Pay-rate anchor (staff-only pages pass these): the person's real base pay,
  // plus the customer bill rate so the Rate field can warn when it's typed by
  // mistake. bill_rate is never offered or defaulted into the pay field.
  hourly_rate?: number | null;
  bill_rate?: number | null;
}
interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

function parts(iso: string | null) {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

export function EditEntryButton({
  entry,
  jobCodes,
  jobs = [],
  members = [],
  isStaff = false,
  jobCodesEnabled = true,
  initialOpen = false,
  hideTrigger = false,
  onClosed,
}: {
  entry: Entry;
  jobCodes: JobCode[];
  jobs?: JobOption[];
  members?: Member[];
  isStaff?: boolean;
  /** Org setting timeclock_job_codes — when false the code picker is hidden (job-only entries). */
  jobCodesEnabled?: boolean;
  /** Mount with the modal already open — the /timecards?entry=<id> deep link
   *  (a week-grid pill tap). Pair with hideTrigger + onClosed. */
  initialOpen?: boolean;
  /** Skip the pencil trigger (the deep-link wrapper provides no anchor row). */
  hideTrigger?: boolean;
  /** Fires whenever the modal closes (cancel, save, delete) — the deep-link
   *  wrapper strips ?entry= here so a refresh doesn't re-open the modal. */
  onClosed?: () => void;
}) {
  const router = useRouter();
  const inP = parts(entry.clock_in);
  const outP = parts(entry.clock_out);

  const [open, setOpen] = useState(initialOpen);
  const close = () => {
    setOpen(false);
    onClosed?.();
  };
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [profileId, setProfileId] = useState(entry.profile_id ?? "");
  const [date, setDate] = useState(inP.date);
  const [startT, setStartT] = useState(inP.time);
  const [endT, setEndT] = useState(outP.time || inP.time);
  // EXPLICIT end date. The modal used to rebuild BOTH stamps from the single start date,
  // so any shift that crossed midnight came back as clock_out <= clock_in and could not
  // be saved at all — and a multi-day entry (the 30-hour forgotten-clock-out case the
  // office comes here to fix) would have been silently truncated to a same-day span on
  // save. Seeded from the stored clock_out, so opening and saving is always a no-op.
  const [endDate, setEndDate] = useState(outP.date || inP.date);
  const [jobId, setJobId] = useState(entry.job_id ?? "");
  const [jobCode, setJobCode] = useState(entry.job_code ?? "");
  // Real lunch MINUTES (not a 30/0 boolean) so editing an unrelated field can't silently
  // collapse a stored 45/60-min lunch down to 30 and mis-state paid hours (the wage bug).
  const [lunchMin, setLunchMin] = useState(entry.lunch_minutes ?? 0);
  const lunchTaken = lunchMin > 0;
  const [breaksTaken, setBreaksTaken] = useState(true);
  const [miles, setMiles] = useState(entry.miles ?? 0);
  // rate_override is only WRITTEN when the user actually edits the Rate field — an unrelated
  // save must never silently clear a supervisor override back to base pay.
  const [rate, setRate] = useState(entry.rate_override == null ? 0 : Number(entry.rate_override));
  const [rateDirty, setRateDirty] = useState(false);
  const [notes, setNotes] = useState(entry.notes ?? "");
  // Split-across-jobs rows (pre-filled from existing allocations so save round-trips them).
  const [splits, setSplits] = useState<{ job_id: string; hours: number; description: string }[]>(() =>
    (entry.time_allocations ?? []).map((a) => ({ job_id: a.job_id ?? "", hours: Number(a.hours ?? 0), description: a.description ?? "" })),
  );
  const addSplit = () => setSplits((s) => [...s, { job_id: jobId || "", hours: 0, description: "" }]);
  const setSplit = (i: number, patch: Partial<{ job_id: string; hours: number; description: string }>) =>
    setSplits((s) => s.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeSplit = (i: number) => setSplits((s) => s.filter((_, idx) => idx !== i));

  // Pay-rate guardrails: anchor the free Rate input to the selected person's REAL
  // base rate, and trip a non-blocking amber warning when the typed value is their
  // BILL rate — the $75-in-the-pay-slot mistake can never happen silently again.
  // Rates stay human-stated (never inferred); nothing here blocks a save.
  const person = members.find((m) => m.id === (profileId || entry.profile_id));
  const baseRate = Number(person?.hourly_rate ?? 0);
  const billRate = Number(person?.bill_rate ?? 0);
  const billRateTyped =
    rate > 0 && billRate > 0 && Math.abs(rate - billRate) <= 0.01 && Math.abs(billRate - baseRate) > 0.01;

  // Payroll locks — surfaced up front so the office doesn't discover them as a save error.
  const basePaid = !!entry.paid_at;
  const mileageSettled = !!entry.mileage_paid_at;

  // Span-aware: an end time earlier in the day than the start means the shift ran past
  // midnight, so it ends on the FOLLOWING day. Rebuilding both stamps on the single Date
  // field meant an overnight shift could never be saved OR corrected here — the modal
  // (and updateTimeEntry) rejected it with "End must be after start" every time.
  const span = buildShiftSpan(date, startT, endT, endDate);
  const grossHrs = spanGrossHours(span);
  const lunchRequired = grossHrs > 5;
  const breaksRequired = grossHrs > 3.5;
  const twoBreaks = grossHrs > 5;
  const lunchHrs = lunchMin / 60;
  const workedHrs = Math.max(0, grossHrs - lunchHrs); // billable shift = gross minus the real lunch
  const allocated = splits.reduce((s, r) => s + (Number(r.hours) || 0), 0);
  const remainder = Math.round((workedHrs - allocated) * 100) / 100;

  function save() {
    setError(null);
    if (!span) return setError("Invalid date/time.");
    const { clockIn: ci, clockOut: co } = span;
    if (co <= ci) return setError("End must be after start.");
    if (lunchRequired && !lunchTaken) return setError("Confirm the 30-minute lunch — required for shifts over 5 hours.");
    if (breaksRequired && !breaksTaken) return setError("Confirm the rest break(s) — required by labor law.");
    if (allocated > workedHrs + 0.01) return setError(`Split adds up to ${allocated.toFixed(2)}h — more than the ${workedHrs.toFixed(2)}h worked.`);
    const allocations = splits
      .filter((s) => s.job_id || (Number(s.hours) || 0) > 0)
      .map((s) => ({ job_id: s.job_id || null, job_code: null, hours: Number(s.hours) || 0, description: s.description || "" }));
    start(async () => {
      const res = await updateTimeEntry({
        id: entry.id,
        clock_in: ci.toISOString(),
        clock_out: co.toISOString(),
        lunch_minutes: lunchMin,
        job_id: jobId || null,
        job_code: jobCode || null,
        notes,
        miles,
        // Only touch the override when the user actually edited the field; otherwise round-trip
        // the stored value so an unrelated edit can't wipe a supervisor rate. (Number-cast the
        // seed — a numeric column can arrive as a string and must round-trip as the same value.)
        rate_override: rateDirty ? (rate > 0 ? rate : null) : entry.rate_override == null ? null : Number(entry.rate_override),
        profile_id: profileId || undefined,
        allocations,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      close();
      router.refresh();
    });
  }

  function remove() {
    if (!confirm("Delete this time entry? This can't be undone.")) return;
    start(async () => {
      const res = await deleteTimeEntry(entry.id);
      if (!res.ok) return setError(res.error ?? "Could not delete.");
      close();
      router.refresh();
    });
  }

  if (!isStaff) return null; // techs can't edit times/job after the fact — office only

  return (
    <>
      {!hideTrigger && (
        <button
          onClick={() => setOpen(true)}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          title="Edit entry"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}

      <Modal
        open={open}
        onClose={close}
        title="Edit time entry"
        footer={
          <ModalActions
            onCancel={close}
            onSave={save}
            saving={pending}
            saveLabel="Save Changes"
            extra={
              <Button
                variant="ghost"
                onClick={remove}
                disabled={pending}
                className="text-red-600 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            }
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          {(basePaid || mileageSettled) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {basePaid && mileageSettled
                ? "Base pay & mileage are settled for this entry — times, rate, person and miles are locked. Undo on Payroll to edit them; notes and job are still editable."
                : basePaid
                  ? "This entry is in a paid period — times, rate and person are locked. Undo on Payroll to edit them; notes, job and miles are still editable."
                  : "Mileage for this entry is settled — miles are locked. Undo on Payroll to edit them; everything else is still editable."}
            </div>
          )}
          <div>
            <Label htmlFor="e-member">Team member</Label>
            {isStaff && members.length > 0 ? (
              <Select id="e-member" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {!entry.profile_id && <option value="">— Select —</option>}
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name ?? "Unnamed"}</option>
                ))}
              </Select>
            ) : (
              <div className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
                {entry.profiles?.full_name ?? "—"}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <Label htmlFor="e-date">Date</Label>
              <Input
                id="e-date"
                type="date"
                value={date}
                onChange={(e) => {
                  const v = e.target.value;
                  // A same-day shift's end date follows the start date; a shift that
                  // already ends on another day keeps its own end date.
                  setEndDate((prev) => (prev === date ? v : prev));
                  setDate(v);
                }}
              />
            </div>
            <div>
              <Label htmlFor="e-start">Start</Label>
              <Input id="e-start" type="time" value={startT} onChange={(e) => setStartT(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-end">End</Label>
              <Input id="e-end" type="time" value={endT} onChange={(e) => setEndT(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-end-date">End date</Label>
              <Input id="e-end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              {span?.overnight && <p className="mt-1 text-xs text-slate-500">Overnight shift</p>}
            </div>
          </div>
          <div>
            <Label htmlFor="e-job">Job</Label>
            <Select id="e-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">— No job —</option>
              {/* Keep the entry's current job selectable even if it's older than
                  the recent-jobs list, so saving never silently clears it. */}
              {entry.job_id && !jobs.some((j) => j.id === entry.job_id) && (
                <option value={entry.job_id}>
                  {entry.job ? jobLabel(entry.job) : "Current job"}
                </option>
              )}
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {jobLabel(j)}
                </option>
              ))}
            </Select>
            {splits.length > 0 && (
              <p className="mt-1 text-xs text-slate-400">The split below decides the billing — the job above is just the fallback.</p>
            )}
          </div>

          {/* Split across jobs — e.g. "1h at Northwoods, the rest elsewhere." Each row bills its job
              its own hours; the single Job above is ignored for billing once a split exists. */}
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">Split across jobs</span>
              <button type="button" onClick={addSplit} className="text-xs font-semibold text-brand hover:underline">
                + Add Job
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              On more than one job this shift? Give each its hours — billing charges each job its own time.
              Unallocated time is still paid, just not billed to a job.
            </p>
            {splits.length > 0 && (
              <div className="mt-2 space-y-2">
                {splits.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Select value={s.job_id} onChange={(e) => setSplit(i, { job_id: e.target.value })} className="min-w-0 flex-1">
                      <option value="">— Job —</option>
                      {entry.job_id && !jobs.some((j) => j.id === entry.job_id) && (
                        <option value={entry.job_id}>{entry.job ? jobLabel(entry.job) : "Current job"}</option>
                      )}
                      {jobs.map((j) => (
                        <option key={j.id} value={j.id}>{jobLabel(j)}</option>
                      ))}
                    </Select>
                    <div className="w-24 shrink-0">
                      <NumberInput value={s.hours} onValueChange={(v) => setSplit(i, { hours: v })} step={0.25} aria-label="Hours" />
                    </div>
                    <button type="button" onClick={() => removeSplit(i)} className="shrink-0 rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Remove">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <div className={allocated > workedHrs + 0.01 ? "text-xs font-medium text-red-600" : "text-xs text-slate-500"}>
                  {allocated.toFixed(2)}h allocated of {workedHrs.toFixed(2)}h worked
                  {allocated > workedHrs + 0.01
                    ? " · more than worked"
                    : remainder > 0.01
                      ? ` · ${remainder.toFixed(2)}h unbilled`
                      : " · fully allocated"}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {jobCodesEnabled && (
              <div className="col-span-2">
                <Label htmlFor="e-code">Job code</Label>
                <Select id="e-code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
                  <option value="">— Code —</option>
                  {jobCodes.map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.code} — {c.description}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="e-miles">Miles</Label>
              <NumberInput id="e-miles" value={miles} onValueChange={setMiles} />
            </div>
            <div>
              <Label htmlFor="e-rate">Rate ($/hr, blank/0 = default)</Label>
              <NumberInput id="e-rate" value={rate} onValueChange={(v) => { setRate(v); setRateDirty(true); }} step={0.5} />
              {baseRate > 0 && (
                <p className="mt-1 text-xs text-slate-400">{`Base $${baseRate.toFixed(2)}/hr — leave blank to use it`}</p>
              )}
            </div>
          </div>
          {billRateTyped && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {`That's ${person?.full_name ?? "this person"}'s bill rate (what customers are charged)${baseRate > 0 ? ` — their pay rate is $${baseRate.toFixed(2)}/hr.` : "."}`}
            </div>
          )}
          <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${lunchRequired && !lunchTaken ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>
            <input
              type="checkbox"
              checked={lunchTaken}
              onChange={(e) => setLunchMin(e.target.checked ? Math.max(30, entry.lunch_minutes ?? 30) : 0)}
              className="h-4 w-4 rounded border-slate-300 text-brand"
            />
            <span className="text-slate-700">Took a lunch{lunchRequired ? <span className="font-medium text-amber-700"> · required (over 5 hrs)</span> : null}</span>
            {lunchTaken && (
              <span className="ml-auto flex items-center gap-1 text-slate-600">
                <span className="w-16"><NumberInput value={lunchMin} onValueChange={setLunchMin} step={15} aria-label="Lunch minutes" /></span>
                min
              </span>
            )}
          </label>
          <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${breaksRequired && !breaksTaken ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>
            <input type="checkbox" checked={breaksTaken} onChange={(e) => setBreaksTaken(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
            <span className="text-slate-700">Took {twoBreaks ? "two 10-minute rest breaks" : "a 10-minute rest break"}{breaksRequired ? <span className="font-medium text-amber-700"> · required</span> : null}</span>
          </label>
          <div>
            <Label htmlFor="e-notes">Notes</Label>
            <Textarea id="e-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}
