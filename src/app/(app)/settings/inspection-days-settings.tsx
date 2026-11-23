"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { InspectionDays, Weekday } from "@/lib/org-settings";
import { updateOrgSettings } from "./actions";
import type { OpenTimesPreview } from "./open-times-preview";

/**
 * INSPECTION DAYS (cn-v1185). The company's own switch for offering open inspection times to a
 * website visitor who has just sent a form: the checkbox, the weekdays, From / To and At Most a Day.
 * It saves exactly as the working-day card beside it does (Save Changes through updateOrgSettings,
 * which validates the shape on the server; a refusal is said in red, never silent).
 *
 * THE CARD TELLS THE TRUTH in plain lines under the controls: what the offer is, what is stopping it
 * (no day ticked, a window shorter than one opening, Leads & Inspections off), and what a visitor
 * would be offered right now. That last line is read on the SERVER page (open-times, the schedule's
 * own rule) as of the page load; while the boxes differ from what is saved it asks for a Save rather
 * than show times that belong to the old answer.
 */

/** Mon … Sun on the card; stored in week order sun..sat (the heal's order). */
const CARD_DAYS: { key: Weekday; label: string }[] = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];
const WEEK_ORDER: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];


const minutesOf = (hm: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export const sameInspectionDays = (a: InspectionDays, b: InspectionDays) =>
  a.offer === b.offer &&
  a.start === b.start &&
  a.end === b.end &&
  a.per_day === b.per_day &&
  a.days.length === b.days.length &&
  a.days.every((d) => b.days.includes(d));

/** THE PINNED SHAPE the Save posts: the five keys, the days de-duplicated in week order sun..sat. */
export function inspectionDaysPatch(s: InspectionDays): { inspection_days: InspectionDays } {
  return {
    inspection_days: {
      offer: s.offer,
      days: WEEK_ORDER.filter((d) => s.days.includes(d)),
      start: s.start,
      end: s.end,
      per_day: s.per_day,
    },
  };
}

/** The plain lines under the controls, in order. Pure: the card's state in, sentences out. */
export function inspectionDaysLines(
  s: InspectionDays,
  o: { leadsOn: boolean; slotMin: number; preview: OpenTimesPreview; dirty: boolean },
): string[] {
  const lines = [
    `A visitor who has just sent a form on your website picks one of your open times on these days. Each opening is ${o.slotMin} clear minutes, never sooner than two days out, and you are told the moment they pick.`,
  ];
  if (!s.offer) return lines;
  let blocked = false;
  if (s.days.length === 0) {
    lines.push("Tick at least one day. Nothing is offered until then.");
    blocked = true;
  } else if (!(minutesOf(s.end) - minutesOf(s.start) >= o.slotMin)) {
    lines.push(`Make To at least ${o.slotMin} minutes after From. Nothing is offered until then.`);
    blocked = true;
  }
  if (!o.leadsOn) {
    lines.push("Leads & Inspections is switched off in Settings › Features. Nothing is offered while it is off.");
    blocked = true;
  }
  if (blocked) return lines;
  if (o.dirty) {
    lines.push("Save to see what a visitor would be offered.");
    return lines;
  }
  if (!o.preview) return lines;
  if ("failed" in o.preview) lines.push("Couldn't read the calendar. Reload to see the open times.");
  else if (o.preview.labels.length === 0) lines.push("Nothing is open on your next six inspection days.");
  else lines.push(`Open right now: ${o.preview.labels.join(", ")}.`);
  return lines;
}

export function InspectionDaysSettings({
  saved,
  leadsOn,
  slotMin,
  preview,
}: {
  /** settings.inspection_days, healed by getOrgSettings. */
  saved: InspectionDays;
  /** The Leads & Inspections switch: off, nothing is offered. */
  leadsOn: boolean;
  /** One opening's length (open-times INSPECTION_SLOT_MIN), handed down so it is typed once. */
  slotMin: number;
  /** Read on the server only while the saved offer is on; null otherwise. */
  preview: OpenTimesPreview;
}) {
  const [offer, setOffer] = useState(saved.offer);
  const [days, setDays] = useState<Weekday[]>(saved.days);
  const [start, setStart] = useState(saved.start);
  const [end, setEnd] = useState(saved.end);
  const [perDay, setPerDay] = useState(saved.per_day);
  const [pending, startT] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const now = inspectionDaysPatch({ offer, days, start, end, per_day: perDay }).inspection_days;
  const dirty = !sameInspectionDays(now, saved);
  const lines = inspectionDaysLines(now, { leadsOn, slotMin, preview, dirty });

  const toggle = (d: Weekday) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  function save() {
    setError(null);
    setDone(false);
    startT(async () => {
      const res = await updateOrgSettings(inspectionDaysPatch(now));
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setDone(true);
      setTimeout(() => setDone(false), 2500);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <label className="flex min-h-11 items-start gap-2 py-1 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={offer}
          onChange={(e) => setOffer(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand"
        />
        <span>Offer Open Times on Your Website</span>
      </label>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Inspection days">
        {CARD_DAYS.map((d) => {
          const pressed = days.includes(d.key);
          return (
            <button
              key={d.key}
              type="button"
              aria-pressed={pressed}
              onClick={() => toggle(d.key)}
              className={
                pressed
                  ? "min-h-11 min-w-11 rounded-lg border border-brand bg-brand px-3 text-sm font-medium text-white"
                  : "min-h-11 min-w-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700"
              }
            >
              {d.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label htmlFor="insp-from">From</Label>
          <Input id="insp-from" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="insp-to">To</Label>
          <Input id="insp-to" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="insp-per-day">At Most a Day</Label>
          <Select id="insp-per-day" value={String(perDay)} onChange={(e) => setPerDay(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        {lines.map((l, i) => (
          <p key={i} className={i === 0 ? "text-xs text-slate-500" : "text-sm text-slate-700"}>
            {l}
          </p>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save Changes"}</Button>
        {done && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
    </div>
  );
}
