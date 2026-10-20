"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, type Tone } from "@/components/ui/badge";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { InfoPopup } from "@/components/info-popup";
import { useToast } from "@/components/toast";
import {
  AUTHORITY_MAX,
  INSPECTION_RESULTS,
  INSPECTION_WINDOWS,
  INSPECTOR_MAX,
  PERMIT_STATUSES_OPEN_TO_VISITS,
  WHY_MAX,
  authorityWithoutRow,
  inOrder,
  inspectionLine,
  isOpenInspection,
  passedOnDay,
  permitInspectionStand,
  standLine,
  type InspectionResult,
  type InspectionStand,
  type PermitInspection,
} from "@/lib/permit-inspections";
import { deleteInspection, recordInspectionResult, reopenInspection, saveInspection } from "../../permits/inspection-actions";

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

/** The words for a tap that never reached the server (a dead zone): the same line the clock and the
 *  timecards say. A rejected action used to be thrown out of the transition and take the job page to
 *  its error boundary with nothing said, the Add button still hidden behind it. */
export const NO_SIGNAL_LINE = "No connection, so that didn't go through. Try again when you have a bar or two.";

/** What a write came to: its answer, or the ONE line to show. A refusal speaks in the action's own
 *  words (or the caller's fallback); a throw is a tap that never landed. Never rethrows. */
export async function settleWrite<T extends { ok: boolean; error?: string }>(
  what: Promise<T>,
  fallback: string,
): Promise<{ res: T } | { error: string }> {
  let res: T;
  try {
    res = await what;
  } catch {
    return { error: NO_SIGNAL_LINE };
  }
  if (!res?.ok) return { error: res?.error ?? fallback };
  return { res };
}

const standTone = (s: InspectionStand): Tone =>
  s.state === "clear" ? "green" : s.state === "needs_another" || s.state === "overdue" ? "red" : s.hisToDo ? "amber" : "blue";

const HOW_IT_WORKS = [
  "The inspections happen in the order they are listed here, top to bottom.",
  "One that is waiting on the visit in front of it reads \"Waits for …\". Until the one in front passes, it is not yours to chase and the app will not ask you about it.",
  "You can still book it now. Inspectors are booked days ahead — often two on one morning — and the order only decides what the app calls ready, never what you may write down.",
  "A booking is a DAY plus morning, afternoon or all day: an inspector gives you a window, never a time.",
  "Passed is one tap: it is written on the day it was booked (or today). Tapped by mistake? Change It, then It Hasn't Happened Yet puts the visit back as open.",
  "Failed asks why — what has to be put right before they come back. A visit that was cancelled is written there too.",
  "A visit that failed stays on the list as what happened. Book another one with the same authority and it takes that visit's place in the line, so whoever was waiting on it now waits on the new one.",
  "Only a booking nobody went to can be removed. A visit that happened is changed, never removed — removing it would erase who came and what they said.",
  "When every inspection has passed, the permit is closed and the job is genuinely finished. On an electrical job the last visit is often the utility's, where the meter goes back on.",
  "Who ISSUED the permit is a different question, and it is the permit's own Authority above. This list is who INSPECTS it.",
];

export function PermitInspections({
  permitId,
  rows,
  todayStr,
  suggestions = [],
  canWrite = false,
  unread = false,
  authority = null,
  permitStatus = null,
}: {
  permitId: string;
  rows: PermitInspection[];
  /** Who ISSUED the permit (permits.authority). When no row carries that name, the card offers its
   *  visit in one tap — the town that issues an electrical permit also inspects it. */
  authority?: string | null;
  /** The permit's own status: a closed permit offers no visit to add. */
  permitStatus?: string | null;
  /** The COMPANY's today (yyyy-mm-dd), handed down from the server: never the browser's clock. */
  todayStr: string;
  /** The authorities this company has called before — a shortcut past the typing, never a list. */
  suggestions?: string[];
  /** Staff, with the Permits & Inspections switch on. Off: the list still reads, nothing is written. */
  canWrite?: boolean;
  /** The read of the inspections failed. Then the card CLAIMS NOTHING — "no inspections yet" would be
   *  a lie about a permit that may well be waiting on the utility. It says so in one line instead. */
  unread?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Which form is open: a booking (new or an id), a result (an id; `preset` = the verb tapped), or nothing. */
  const [form, setForm] = useState<{ kind: "book" | "result"; id: string | null; preset?: InspectionResult } | null>(null);
  /** WHAT THE LAST RESULT CARRIED FORWARD: what is true now, and the one next step, with its door.
   *  A toast is gone in four seconds; "the job is done — finish the job and bill it" is the end of the
   *  chain and has to stay on the screen until he takes it. */
  const [carried, setCarried] = useState<{ message: string; next: string | null; href: string | null } | null>(null);

  const ordered = inOrder(rows);
  const stand = permitInspectionStand(ordered, todayStr);
  const line = standLine(stand);
  const listId = `auth-${permitId}`;
  /** The issuing authority's own visit, not yet a row (lib/permit-inspections): offered while the
   *  permit is open to visits (issued, booked, failed) and not every visit has passed. */
  const missing = !unread && PERMIT_STATUSES_OPEN_TO_VISITS.has(permitStatus ?? "") && stand.state !== "clear" ? authorityWithoutRow(authority, ordered) : null;
  /** The door just used: hidden until the rows come back changed, so a second tap in the gap
   *  between the save and the refresh cannot add the visit twice. A failed save shows it again. */
  const [addedFor, setAddedFor] = useState<string | null>(null);
  useEffect(() => {
    setAddedFor(null);
  }, [rows]);

  /** `onFail` runs when the write did not land — refused OR never reached the server — so a door that
   *  hid itself on the tap (the Add button) comes back with the words, never stuck hidden. */
  const run = (
    what: Promise<{ ok: boolean; error?: string; message?: string; next?: string | null; href?: string | null }>,
    fallback: string,
    onFail?: () => void,
  ) =>
    start(async () => {
      setError(null);
      const done = await settleWrite(what, fallback);
      if ("error" in done) {
        setError(done.error);
        onFail?.();
        return;
      }
      const res = done.res;
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

      {/* WHERE IT STANDS, in one line: who still has to come, or that every visit passed. Never while the
          read is lost: a verdict worked out from rows nobody could read is a guess. */}
      {!unread && line && (
        <div className="mt-1">
          <Badge tone={standTone(stand)}>{line}</Badge>
        </div>
      )}

      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}

      {/* THE ISSUING AUTHORITY'S OWN VISIT, IN ONE TAP (J-012, 2026-10-15: the Town of Truckee permit
          had a TTPUD row and no Truckee row; Erik marked "the permit inspection" passed on the permit's
          status, which carries nothing forward). Not booked yet — Passed or Change The Booking follow. */}
      {canWrite && missing && addedFor !== missing && (
        <div className="mt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal py-2 text-left"
            disabled={pending}
            onClick={() => {
              setAddedFor(missing);
              run(
                saveInspection({ authority: missing, scheduled_for: null, scheduled_window: null, permit_id: permitId, first: true }),
                "Couldn't add it — try again.",
                () => setAddedFor(null),
              );
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Add The {missing} Inspection
          </Button>
        </div>
      )}

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

      {unread ? (
        <p className="py-2 text-xs text-amber-700">Couldn&rsquo;t read this permit&rsquo;s inspections just now. Reload to try again.</p>
      ) : ordered.length === 0 ? (
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
                <span className="flex flex-wrap items-center gap-1">
                  {canWrite && (
                    <>
                      {/* THE VERB FIRST, IN WORDS (Erik, 2026-10-15, from the phone). An open visit:
                          Passed is one tap, written on the booked day (or today) — the common case
                          needs no form; Failed opens the form, because a failure says why. A visit
                          written up: Change It. */}
                      {isOpenInspection(r) ? (
                        <>
                          <Button
                            size="sm"
                            className="min-h-11"
                            aria-label={`${r.authority}: passed`}
                            disabled={pending}
                            onClick={() =>
                              run(
                                recordInspectionResult({ id: r.id, result: "passed", result_on: passedOnDay(r, todayStr), inspector: null, why: null, expect_open: true }),
                                "Couldn't save it — try again.",
                              )
                            }
                          >
                            Passed
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="min-h-11"
                            aria-label={`${r.authority}: failed`}
                            onClick={() => setForm(form?.kind === "result" && form.id === r.id ? null : { kind: "result", id: r.id, preset: "failed" })}
                          >
                            Failed
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => setForm(form?.kind === "result" && form.id === r.id ? null : { kind: "result", id: r.id })}
                        >
                          Change It
                        </Button>
                      )}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Change the booking for ${r.authority}`}
                        title="Change The Booking"
                        onClick={() => setForm(form?.kind === "book" && form.id === r.id ? null : { kind: "book", id: r.id })}
                      >
                        <Pencil aria-hidden />
                      </Button>
                      {/* ONLY A BOOKING NOBODY WENT TO. A visit that happened is a result: removing
                          it would erase the day they came, who came and how it went — and with it the
                          visit in front of the next authority, which would then read as unblocked
                          with nothing having passed. The action refuses it too; this stops the door
                          being offered at all. */}
                      {isOpenInspection(r) && (
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
                      )}
                    </>
                  )}
                </span>
              </div>
              {form?.kind === "result" && form.id === r.id && (
                <ResultForm
                  row={r}
                  preset={form.preset}
                  pending={pending}
                  todayStr={todayStr}
                  onCancel={() => setForm(null)}
                  onSave={(input) => run(recordInspectionResult(input), "Couldn't save it — try again.")}
                  onReopen={r.result ? () => run(reopenInspection(r.id, permitId), "Couldn't reopen it — try again.") : undefined}
                />
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
  preset,
  onReopen,
}: {
  row: PermitInspection;
  pending: boolean;
  todayStr: string;
  onCancel: () => void;
  onSave: (input: { id: string; result: string; result_on: string; inspector: string | null; why: string | null }) => void;
  /** The verb that opened the form (Failed), when one did. */
  preset?: InspectionResult;
  /** THE UNDO for a result written by mistake: the visit goes back to open. Only on a written-up row. */
  onReopen?: () => void;
}) {
  const [result, setResult] = useState<string>(preset ?? row.result ?? "passed");
  // The day they came: the one written, else the booked day once it has come, else today — never a
  // day still ahead (the same rule as the one-tap Passed).
  const [on, setOn] = useState((row.result_on ?? "").slice(0, 10) || passedOnDay(row, todayStr));
  const [who, setWho] = useState(row.inspector ?? "");
  const [why, setWhy] = useState(row.notes ?? "");

  return (
    <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-white p-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <Label htmlFor={`rr-${row.id}`}>Inspection Status</Label>
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
      {/* A FAILURE SAYS WHY (Erik, 2026-10-03: "Inspection Status: Passed or Failed (if failed, why)").
          Drawn only on a failure, because a reason box standing open under a pass invites a note
          nobody asked for and buries the one that matters. Save is shut without it, and the door
          refuses it too — the form is a convention, the server is the boundary. */}
      {result === "failed" && (
        <div>
          <Label htmlFor={`rn-${row.id}`}>Why It Failed</Label>
          <Textarea
            id={`rn-${row.id}`}
            rows={2}
            maxLength={WHY_MAX}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="What has to be put right before they come back"
          />
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {onReopen && (
          <Button size="sm" variant="outline" className="mr-auto min-h-11" disabled={pending} onClick={onReopen}>
            It Hasn&rsquo;t Happened Yet
          </Button>
        )}
        <Button size="sm" variant="outline" className="min-h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="min-h-11"
          disabled={pending || !on || (result === "failed" && !why.trim())}
          onClick={() => onSave({ id: row.id, result, result_on: on, inspector: who.trim() || null, why: why.trim() || null })}
        >
          {pending ? "Saving…" : "Save Result"}
        </Button>
      </div>
    </div>
  );
}
