"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { drivingDistanceMiles } from "@/lib/google-maps";
import { lunchMinutesFor } from "@/lib/lunch-rule";
import { LunchCheckbox } from "@/components/lunch-checkbox";
import { createManualEntry } from "../../timeclock/actions";
import { SameDayShifts, notCarriedWords } from "../../timeclock/same-day-shifts";
import { useToast } from "@/components/toast";
import type { JobCode } from "@/lib/types";

interface Tech {
  id: string;
  full_name: string | null;
  home_address?: string | null;
  // Pay-rate anchor — present only when the viewer is staff (the page enriches the
  // techs select behind its staff flag, so rates never serialize to a tech's props).
  // bill_rate is never offered or defaulted into the pay field.
  hourly_rate?: number | null;
  bill_rate?: number | null;
  /** 0286: the owner is paid by owner's draw, so his shifts carry no pay-rate override. */
  paid_by_draw?: boolean | null;
}

export function JobAddTimeEntry({
  jobId,
  techs,
  jobCodes,
  defaultProfileId,
  companyAddress,
  jobAddress,
  jobCodesEnabled = true,
}: {
  jobId: string;
  techs: Tech[];
  jobCodes: JobCode[];
  defaultProfileId: string;
  companyAddress?: string;
  jobAddress?: string;
  /** Org setting timeclock_job_codes — when false the code picker is hidden (job-only entries). */
  jobCodesEnabled?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [miles, setMiles] = useState(0);
  const [calcing, setCalcing] = useState(false);

  async function autoMiles(originAddr: string) {
    if (!key || !originAddr || !jobAddress) return;
    setCalcing(true);
    const oneWay = await drivingDistanceMiles(key, originAddr, jobAddress);
    setCalcing(false);
    if (oneWay != null) setMiles(Math.round(oneWay * 2 * 10) / 10); // round trip
  }

  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const [date, setDate] = useState(`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`);
  const [startT, setStartT] = useState("08:00");
  const [endT, setEndT] = useState("16:00");
  const [profileId, setProfileId] = useState(defaultProfileId);
  const [jobCode, setJobCode] = useState("");
  const [rate, setRate] = useState(0); // 0 = use the employee's default rate
  const [notes, setNotes] = useState("");
  // Lunch is OPT-IN (Erik 2026-09-08) — unchecked means the shift is paid gross.
  const [tookLunch, setTookLunch] = useState(false);

  // Mileage origin: the selected employee's home address if set, else the company address.
  const mileageOrigin = (techs.find((t) => t.id === profileId)?.home_address || companyAddress || "").trim();

  // Pay-rate guardrails: anchor the free rate input to the selected person's REAL
  // base rate, and trip a non-blocking amber warning when the typed value is their
  // BILL rate — this billing-context modal is exactly where $75/hr (the customer
  // labor rate) is the number in the operator's head. Nothing here blocks a save.
  const person = techs.find((t) => t.id === profileId);
  const baseRate = Number(person?.hourly_rate ?? 0);
  const billRate = Number(person?.bill_rate ?? 0);
  const billRateTyped =
    rate > 0 && billRate > 0 && Math.abs(rate - billRate) <= 0.01 && Math.abs(billRate - baseRate) > 0.01;
  // The owner's shift has no pay rate at all (0286): the field is not offered, and a figure typed
  // for somebody else before switching the person to him is never sent.
  const ownerShift = person?.paid_by_draw === true;


  // ONE TAP, ONE ENTRY: the ref closes the double-tap gap before `pending` re-renders the button
  // (0360 refuses the same hours twice underneath). A refusal bolds the shift in the way in the
  // day's list and re-reads it.
  const inFlight = useRef(false);
  const [clashId, setClashId] = useState<string | null>(null);
  const [dayKey, setDayKey] = useState(0);

  function save() {
    if (inFlight.current || pending) return;
    setError(null);
    const ci = new Date(`${date}T${startT}:00`);
    const co = new Date(`${date}T${endT}:00`);
    if (isNaN(ci.getTime()) || isNaN(co.getTime())) return setError("Invalid date/time.");
    if (co <= ci) return setError("End must be after start.");
    inFlight.current = true;
    start(async () => {
      try {
        const res = await createManualEntry({
          profile_id: profileId,
          clock_in: ci.toISOString(),
          clock_out: co.toISOString(),
          job_id: jobId,
          job_code: jobCode || null,
          // Stated every time, so 0 is a real answer and not "wasn't asked".
          lunch_minutes: lunchMinutesFor(tookLunch),
          notes,
          miles,
          rate_override: !ownerShift && rate > 0 ? rate : null,
        });
        if (!res.ok) {
          setError(res.error ?? "Could not save.");
          setClashId(res.clash?.id ?? null);
          setDayKey((k) => k + 1);
          return;
        }
        setClashId(null);
        setOpen(false);
        router.refresh();
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" /> Add Time Entry
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add time entry"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={save}
            saving={pending}
            saveLabel="Save Entry"
          />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1">
              <Label htmlFor="at-date">Date</Label>
              <Input id="at-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="at-start">Start</Label>
              <Input id="at-start" type="time" value={startT} onChange={(e) => setStartT(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="at-end">End</Label>
              <Input id="at-end" type="time" value={endT} onChange={(e) => setEndT(e.target.value)} />
            </div>
          </div>
          {/* What this person already has that day: a punch on no job gets Put This On <this job>,
              keeping its clock times, instead of the same hours typed a second time (the 85
              Whitney duplicates, 2026-09-26). */}
          <SameDayShifts
            profileId={profileId}
            date={date}
            jobId={jobId}
            highlightId={clashId}
            refreshKey={dayKey}
            onPlaced={(_sentence, shift) => {
              setOpen(false);
              setError(null);
              setClashId(null);
              // The door moved the punch only: say what was typed here that it did not get.
              const left = notCarriedWords({ miles, lunch: tookLunch, code: jobCodesEnabled ? jobCode : null, rate: ownerShift ? 0 : rate, notes });
              if (left) toast(left, "info", { label: "Open That Shift", onClick: () => router.push(`/timecards?entry=${shift.id}`) });
              router.refresh();
            }}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="at-emp">Employee</Label>
              <Select id="at-emp" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                {techs.map((t) => (
                  <option key={t.id} value={t.id}>{t.full_name ?? "Unnamed"}</option>
                ))}
              </Select>
            </div>
            {jobCodesEnabled && (
              <div>
                <Label htmlFor="at-code">Job code</Label>
                <Select id="at-code" value={jobCode} onChange={(e) => setJobCode(e.target.value)}>
                  <option value="">— Code —</option>
                  {jobCodes.map((c) => (
                    <option key={c.id} value={c.code}>{c.code} — {c.description}</option>
                  ))}
                </Select>
              </div>
            )}
          </div>
          {!ownerShift && (
          <div>
            <Label htmlFor="at-rate">Pay rate ($/hr) — supervisor / override</Label>
            <NumberInput id="at-rate" value={rate} onValueChange={setRate} placeholder="Default rate" />
            <p className="mt-1 text-xs text-slate-400">
              {baseRate > 0
                ? `Base $${baseRate.toFixed(2)}/hr — leave blank to use it`
                : "Leave 0 to use this person's default hourly rate."}
            </p>
            {billRateTyped && (
              <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {`That's ${person?.full_name ?? "this person"}'s bill rate (what customers are charged)${baseRate > 0 ? ` — their pay rate is $${baseRate.toFixed(2)}/hr.` : "."}`}
              </div>
            )}
          </div>
          )}
          {/* Miles only — no dollar preview; mileage pay is settled on /payroll by a
              human-typed amount, never an app-computed rate×miles figure. */}
          <div>
            <Label htmlFor="at-miles">Miles</Label>
            <div className="flex gap-2">
              <NumberInput id="at-miles" value={miles} onValueChange={setMiles} />
              {key && mileageOrigin && jobAddress && (
                <Button type="button" size="sm" variant="outline" onClick={() => autoMiles(mileageOrigin)} disabled={calcing} title={`Round trip: ${mileageOrigin} ↔ job`}>
                  {calcing ? "…" : "Auto"}
                </Button>
              )}
            </div>
          </div>
          <LunchCheckbox id="at-lunch" checked={tookLunch} onChange={setTookLunch} />
          <div>
            <Label htmlFor="at-notes">Notes</Label>
            <Textarea id="at-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}
