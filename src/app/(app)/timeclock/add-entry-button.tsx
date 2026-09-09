"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { createManualEntry } from "./actions";
import { buildShiftSpan } from "./shift-span";
import { lunchMinutesFor } from "@/lib/lunch-rule";
import { LunchCheckbox } from "@/components/lunch-checkbox";
import { todayStrInTz } from "@/lib/tz";
import { formatDuration } from "@/lib/utils";
import type { JobCode } from "@/lib/types";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";

interface JobOption {
  id: string;
  job_number: string;
  name: string;
  address?: string | null;
  customer_name?: string | null; // feeds the codes-off customer · address label
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

export function AddEntryButton({
  isStaff,
  members,
  jobCodes,
  jobs,
  tz = "America/Los_Angeles",
  jobCodesEnabled = true,
}: {
  isStaff: boolean;
  members: Member[];
  jobCodes: JobCode[];
  jobs: JobOption[];
  /** Org IANA timezone, so the default date is the business's local "today"
   *  rather than the browser/UTC day. Defaults to the org-settings default. */
  tz?: string;
  /** org setting timeclock_job_codes — false drops the code question and labels
   *  jobs customer · address. Default true = today's form. */
  jobCodesEnabled?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const today = todayStrInTz(tz);
  const [member, setMember] = useState("");
  const [date, setDate] = useState(today);
  const [startT, setStartT] = useState("08:00");
  const [endT, setEndT] = useState("16:00");
  // EXPLICIT end date (same as the Edit modal). Without it, deriving the end stamp from the
  // single start date turned an end-BEFORE-start typo (e.g. 4pm–8am flipped) into a ~23h
  // overnight shift instead of the rejection it should be. Seeded to the start date, so a
  // same-day end<start still trips "End time must be after start", and an overnight is opt-in.
  const [endDate, setEndDate] = useState(today);
  const [jobId, setJobId] = useState("");
  const [jobCode, setJobCode] = useState("");
  const [miles, setMiles] = useState(0);
  // Lunch is OPT-IN (Erik 2026-09-08) — unchecked means the shift is paid gross.
  const [tookLunch, setTookLunch] = useState(false);
  const [rate, setRate] = useState(0);
  const [notes, setNotes] = useState("");

  // Pay-rate guardrails: anchor the free Rate input to the selected person's REAL
  // base rate, and trip a non-blocking amber warning when the typed value is their
  // BILL rate — the $75-in-the-pay-slot mistake can never happen silently again.
  // ("Me" has no anchor — the viewer isn't identified client-side.)
  const person = members.find((m) => m.id === member);
  const baseRate = Number(person?.hourly_rate ?? 0);
  const billRate = Number(person?.bill_rate ?? 0);
  const billRateTyped =
    rate > 0 && billRate > 0 && Math.abs(rate - billRate) <= 0.01 && Math.abs(billRate - baseRate) > 0.01;

  // Span-aware, with an EXPLICIT end date (parity with the Edit modal): a same-day
  // end<start is rejected (a typo, not a 23h shift), while a real overnight is opt-in via
  // the End date field. The derivation is a fallback only when the two dates match.
  const span = buildShiftSpan(date, startT, endT, endDate);

  function submit() {
    setError(null);
    // Build ISO from local date + time so the user's timezone is respected; an end time
    // before the start rolls onto the next day (overnight shift).
    if (!span) {
      setError("Enter a valid date and times.");
      return;
    }
    const { clockIn, clockOut } = span;
    if (clockOut <= clockIn) {
      setError("End time must be after start time.");
      return;
    }
    start(async () => {
      const res = await createManualEntry({
        profile_id: member,
        clock_in: clockIn.toISOString(),
        clock_out: clockOut.toISOString(),
        job_id: jobId || null,
        job_code: jobCode || null,
        // Stated every time, so 0 is a real answer and not "wasn't asked".
        lunch_minutes: lunchMinutesFor(tookLunch),
        notes,
        miles,
        // Blank/0 ⇒ default rate; a positive number sets a per-entry override.
        rate_override: rate > 0 ? rate : null,
      });
      if (!res.ok) {
        setError(res.error ?? "Could not add entry.");
        return;
      }
      setOpen(false);
      setNotes("");
      // SAY WHERE IT WENT (Erik 2026-09-08: "Time card entry not appearing"). /timeclock is a
      // clock, not a ledger — the office's entries live on Timecards — so adding one from here
      // used to close the modal onto a page that shows no trace of it. Name what was recorded
      // and hand over the door to it, rather than leaving the office to wonder if it saved.
      const paidHrs = Math.max(0, (clockOut.getTime() - clockIn.getTime()) / 3_600_000 - lunchMinutesFor(tookLunch) / 60);
      const who = person?.full_name ?? "you";
      const day = clockIn.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      toast(`Added ${formatDuration(paidHrs)} for ${who} · ${day}`, "success", {
        label: "Timecards",
        onClick: () => router.push("/timecards"),
      });
      router.refresh();
    });
  }

  if (!isStaff) return null; // techs clock in/out live — only the office adds entries

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add Entry
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add past timecard entry"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={submit}
            saving={pending}
            saveLabel="Add Entry"
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {isStaff && (
            <div>
              <Label htmlFor="member">Crew member</Label>
              <Select id="member" value={member} onChange={(e) => setMember(e.target.value)}>
                <option value="">Me</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name ?? "Unnamed"}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* Dates in the LEFT column, times in the RIGHT one, so the two rows line up on a
              phone (Erik 2026-09-08 — they used to alternate date/time/time/date). */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <Label htmlFor="date">Start date</Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => {
                  const v = e.target.value;
                  // A same-day shift's end date follows the start date; a shift already
                  // marked overnight keeps its own end date.
                  setEndDate((prev) => (prev === date ? v : prev));
                  setDate(v);
                }}
              />
            </div>
            <div>
              <Label htmlFor="start">Start time</Label>
              <Input id="start" type="time" value={startT} onChange={(e) => setStartT(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="end-date">End date</Label>
              <Input id="end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              {span?.overnight && <p className="mt-1 text-xs text-slate-500">Overnight shift</p>}
            </div>
            <div>
              <Label htmlFor="end">End time</Label>
              <Input id="end" type="time" value={endT} onChange={(e) => setEndT(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {/* Codes off: no code question — the entry carries just its job below. */}
            {jobCodesEnabled && (
              <div className="col-span-2">
                <Label htmlFor="m-code">Job code</Label>
                <Select id="m-code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
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
              <Label htmlFor="m-miles">Miles</Label>
              <NumberInput id="m-miles" value={miles} onValueChange={setMiles} />
            </div>
            <div className="col-span-2 sm:col-span-3">
              <Label htmlFor="m-rate">Rate ($/hr, blank/0 = default)</Label>
              <NumberInput id="m-rate" value={rate} onValueChange={setRate} step={0.5} />
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
          <LunchCheckbox id="m-lunch" checked={tookLunch} onChange={setTookLunch} />

          <div>
            <Label htmlFor="m-job">Job (optional)</Label>
            <Select id="m-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">— No job —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {jobCodesEnabled ? jobLabel(j) : jobSiteLabel(j)}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="m-notes">Notes</Label>
            <Textarea id="m-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}
