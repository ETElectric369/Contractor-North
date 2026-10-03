"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, type Tone } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { InfoPopup } from "@/components/info-popup";
import { useToast } from "@/components/toast";
import {
  AUTHORITY_MAX,
  INSPECTION_RESULTS,
  INSPECTION_WINDOWS,
  INSPECTOR_MAX,
  inOrder,
  inspectionLine,
  isOpenInspection,
  permitInspectionStand,
  standLine,
  type InspectionStand,
  type PermitInspection,
} from "@/lib/permit-inspections";
import { deleteInspection, recordInspectionResult, saveInspection } from "../../permits/inspection-actions";

/**
 * WHO STILL HAS TO COME — on the permit, where the permit already is (0378).
 *
 * Erik: "we have to get it inspected by both the Town of Truckee and Liberty Utilities before Liberty
 * will put the meter back on, so final inspections come with permits." So this is a SHORT LIST ON THE
 * PERMIT'S CARD, never a page of its own: the authority, the day and part-day it is booked for, and
 * the result once there is one. One nobody has phoned says so.
 *
 * THE ORDER IS SHOWN, NOT ENFORCED HERE. The one rule (lib/permit-inspections) decides what "waits
 * for" and what is ready; this draws it. Add Inspection stays open on a blocked one on purpose — both
 * of the October job's inspections were booked for one morning, days ahead, by phone.
 *
 * ONE LINE EACH, and the whole explanation behind the info icon as bullets (Erik, 2026-10-03).
 */

const standTone = (s: InspectionStand): Tone =>
  s.state === "clear" ? "green" : s.state === "needs_another" || s.state === "overdue" ? "red" : s.hisToDo ? "amber" : "blue";

const HOW_IT_WORKS = [
  "The inspections happen in the order they are listed here, top to bottom.",
  "One that is waiting on the visit in front of it reads \"Waits for …\". Until the one in front passes, it is not yours to chase and the app will not ask you about it.",
  "You can still book it now. Inspectors are booked days ahead — often two on one morning — and the order only decides what the app calls ready, never what you may write down.",
  "A booking is a DAY plus morning, afternoon or all day: an inspector gives you a window, never a time.",
  "Saying how it went needs the day they came, and one of passed, failed or cancelled.",
  "A visit that failed stays on the list as what happened. Book another one with the same authority; it goes on the end and clears the way when it passes.",
  "When every inspection has passed, the permit is closed and the job is genuinely finished — on this job that is the visit where the meter goes back on.",
  "Who ISSUED the permit is a different question, and it is the permit's own Authority above. This list is who INSPECTS it.",
];

export function PermitInspections({
  permitId,
  rows,
  todayStr,
  suggestions = [],
  canWrite = false,
}: {
  permitId: string;
  rows: PermitInspection[];
  /** The COMPANY's today (yyyy-mm-dd), handed down from the server: never the browser's clock. */
  todayStr: string;
  /** The authorities this company has called before — a shortcut past the typing, never a list. */
  suggestions?: string[];
  /** Staff, with the Permits & Inspections switch on. Off: the list still reads, nothing is written. */
  canWrite?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Which form is open: a booking (new or an id), a result (an id), or nothing. */
  const [form, setForm] = useState<{ kind: "book" | "result"; id: string | null } | null>(null);
  /** WHAT THE LAST RESULT CARRIED FORWARD: what is true now, and the one next step, with its door.
   *  A toast is gone in four seconds; "the meter is on — finish the job and bill it" is the end of the
   *  chain and has to stay on the screen until he takes it. */
  const [carried, setCarried] = useState<{ message: string; next: string | null; href: string | null } | null>(null);

  const ordered = inOrder(rows);
  const stand = permitInspectionStand(ordered, todayStr);
  const line = standLine(stand);
  const listId = `auth-${permitId}`;

  const run = (
    what: Promise<{ ok: boolean; error?: string; message?: string; next?: string | null; href?: string | null }>,
    fallback: string,
  ) =>
    start(async () => {
      setError(null);
      const res = await what;
      if (!res?.ok) {
        setError(res?.error ?? fallback);
        return;
      }
      setForm(null);
      toast(res.message ?? "Saved", "success");
      // The chain's third leg: carry what the write made true, and the next door, onto the screen.
      setCarried(res.next ? { message: res.message ?? "Saved", next: res.next, href: res.href ?? null } : null);
      router.refresh();
    });

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Inspections</span>
          <InfoPopup title="How Inspections On A Permit Work" label="About Inspections On A Permit" bullets={HOW_IT_WORKS} />
        </div>
        {canWrite && (
          <Button size="sm" variant="outline" className="min-h-11" onClick={() => setForm(form?.kind === "book" && !form.id ? null : { kind: "book", id: null })}>
            <Plus className="h-3.5 w-3.5" /> Add Inspection
          </Button>
        )}
      </div>

      {/* WHERE IT STANDS, in one line: who still has to come, or that the meter is on. */}
      {line && (
        <div className="mt-1">
          <Badge tone={standTone(stand)}>{line}</Badge>
        </div>
      )}

      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}

      {/* WHAT THE LAST RESULT CARRIED FORWARD. One line of what is true now, and the next door — the
          utility to book, or the finished job to bill. Never a write that goes quiet. */}
      {carried && (
        <div className="mt-1 rounded-md bg-green-50 px-2 py-1.5 text-xs text-green-900">
          <span>{carried.message}</span>{" "}
          {carried.href ? (
            <Link href={carried.href} className="inline-flex min-h-11 items-center font-medium underline">
              {carried.next}
            </Link>
          ) : (
            <span className="font-medium">{carried.next}</span>
          )}
        </div>
      )}

      {ordered.length === 0 ? (
        <p className="py-2 text-xs text-slate-400">
          No inspections on this permit yet.{canWrite ? " Add the ones that have to come before it closes." : ""}
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {ordered.map((r) => (
            <li key={r.id} className="rounded-md bg-slate-50 px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* ONE LINE: who, when, how it went. No badge repeating the word the line just said —
                    the permit's own line above carries the colour. */}
                <span className="min-w-0 text-xs text-slate-700">{inspectionLine(ordered, r)}</span>
                <span className="flex items-center gap-1">
                  {canWrite && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => setForm(form?.kind === "result" && form.id === r.id ? null : { kind: "result", id: r.id })}
                      >
                        {isOpenInspection(r) ? "Say How It Went" : "Change It"}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Change the booking for ${r.authority}`}
                        title="Change The Booking"
                        onClick={() => setForm(form?.kind === "book" && form.id === r.id ? null : { kind: "book", id: r.id })}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove the ${r.authority} inspection`}
                        title="Remove"
                        disabled={pending}
                        onClick={() => {
                          if (!confirm(`Remove the ${r.authority} inspection from this permit?`)) return;
                          run(deleteInspection(r.id, permitId), "Couldn't remove it — try again.");
                        }}
                      >
                        <Trash2 aria-hidden className="text-slate-400" />
                      </Button>
                    </>
                  )}
                </span>
              </div>
              {form?.kind === "result" && form.id === r.id && (
                <ResultForm row={r} pending={pending} todayStr={todayStr} onCancel={() => setForm(null)} onSave={(input) => run(recordInspectionResult(input), "Couldn't save it — try again.")} />
              )}
              {form?.kind === "book" && form.id === r.id && (
                <BookingForm
                  row={r}
                  listId={listId}
                  suggestions={suggestions}
                  pending={pending}
                  onCancel={() => setForm(null)}
                  onSave={(input) => run(saveInspection({ ...input, id: r.id, permit_id: permitId }), "Couldn't save it — try again.")}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && form?.kind === "book" && !form.id && (
        <BookingForm
          row={null}
          listId={listId}
          suggestions={suggestions}
          pending={pending}
          onCancel={() => setForm(null)}
          onSave={(input) => run(saveInspection({ ...input, permit_id: permitId }), "Couldn't save it — try again.")}
        />
      )}
      {/* The suggestions, once, for every box on this permit. A datalist SUGGESTS and never limits:
          a name this company has never used is typed straight in. */}
      {canWrite && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/** BOOK ONE, OR MOVE ONE: who is coming, the day, and the part of the day. */
function BookingForm({
  row,
  listId,
  suggestions,
  pending,
  onCancel,
  onSave,
}: {
  row: PermitInspection | null;
  listId: string;
  suggestions: string[];
  pending: boolean;
  onCancel: () => void;
  onSave: (input: { authority: string; scheduled_for: string | null; scheduled_window: string | null }) => void;
}) {
  const [authority, setAuthority] = useState(row?.authority ?? "");
  const [day, setDay] = useState((row?.scheduled_for ?? "").slice(0, 10));
  const [win, setWin] = useState<string>(row?.scheduled_window ?? "");
  const id = row?.id ?? "new";

  return (
    <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-white p-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <Label htmlFor={`ia-${id}`}>Who Is Coming</Label>
          <Input
            id={`ia-${id}`}
            className="h-11"
            list={suggestions.length ? listId : undefined}
            maxLength={AUTHORITY_MAX}
            value={authority}
            onChange={(e) => setAuthority(e.target.value)}
            placeholder="e.g. the town, the county, the utility"
          />
        </div>
        <div>
          <Label htmlFor={`id-${id}`}>Day</Label>
          <Input id={`id-${id}`} className="h-11" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div>
          <Label htmlFor={`iw-${id}`}>Part Of The Day</Label>
          <Select id={`iw-${id}`} className="h-11" value={win} onChange={(e) => setWin(e.target.value)}>
            <option value="">Not said</option>
            {INSPECTION_WINDOWS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" className="min-h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="min-h-11"
          disabled={pending || !authority.trim()}
          onClick={() => onSave({ authority, scheduled_for: day || null, scheduled_window: win || null })}
        >
          {pending ? "Saving…" : row ? "Save Changes" : "Save Inspection"}
        </Button>
      </div>
    </div>
  );
}

/**
 * HOW IT WENT. 0378 refuses a result with no day, so this form cannot ask for one without the other:
 * the day starts on the day it was booked for (or today), and Save is shut while it is empty.
 */
function ResultForm({
  row,
  pending,
  todayStr,
  onCancel,
  onSave,
}: {
  row: PermitInspection;
  pending: boolean;
  todayStr: string;
  onCancel: () => void;
  onSave: (input: { id: string; result: string; result_on: string; inspector: string | null }) => void;
}) {
  const [result, setResult] = useState<string>(row.result ?? "passed");
  const [on, setOn] = useState((row.result_on ?? row.scheduled_for ?? todayStr).slice(0, 10));
  const [who, setWho] = useState(row.inspector ?? "");

  return (
    <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-white p-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <Label htmlFor={`rr-${row.id}`}>How It Went</Label>
          <Select id={`rr-${row.id}`} className="h-11" value={result} onChange={(e) => setResult(e.target.value)}>
            {INSPECTION_RESULTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor={`ro-${row.id}`}>Day They Came</Label>
          <Input id={`ro-${row.id}`} className="h-11" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
        </div>
        <div>
          <Label htmlFor={`rw-${row.id}`}>Who Came</Label>
          <Input id={`rw-${row.id}`} className="h-11" maxLength={INSPECTOR_MAX} value={who} onChange={(e) => setWho(e.target.value)} placeholder="The inspector's name" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" className="min-h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="min-h-11" disabled={pending || !on} onClick={() => onSave({ id: row.id, result, result_on: on, inspector: who.trim() || null })}>
          {pending ? "Saving…" : "Save Result"}
        </Button>
      </div>
    </div>
  );
}
