"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { drivingDistanceMiles } from "@/lib/google-maps";
import { autoLunchMinutes } from "@/lib/lunch-rule";
import { createManualEntry } from "../../timeclock/actions";
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

  const grossHrs = (() => {
    const ci = new Date(`${date}T${startT}:00`);
    const co = new Date(`${date}T${endT}:00`);
    if (isNaN(ci.getTime()) || isNaN(co.getTime()) || co <= ci) return 0;
    return (co.getTime() - ci.getTime()) / 3_600_000;
  })();
  // Lunch is AUTOMATIC (>5h ⇒ 30 min, the shared rule) — shown as a note, applied by
  // the server (lunch_minutes omitted below).
  const autoLunch = autoLunchMinutes(grossHrs);

  function save() {
    setError(null);
    const ci = new Date(`${date}T${startT}:00`);
    const co = new Date(`${date}T${endT}:00`);
    if (isNaN(ci.getTime()) || isNaN(co.getTime())) return setError("Invalid date/time.");
    if (co <= ci) return setError("End must be after start.");
    start(async () => {
      const res = await createManualEntry({
        profile_id: profileId,
        clock_in: ci.toISOString(),
        clock_out: co.toISOString(),
        job_id: jobId,
        job_code: jobCode || null,
        // Omitted → the server's auto-lunch rule decides (>5h ⇒ 30 min).
        notes,
        miles,
        rate_override: rate > 0 ? rate : null,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
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
          {autoLunch > 0 && (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
              Over 5 hours — a 30-minute unpaid lunch is deducted automatically. Adjust it on the entry afterwards if needed.
            </p>
          )}
          <div>
            <Label htmlFor="at-notes">Notes</Label>
            <Textarea id="at-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
    </>
  );
}
