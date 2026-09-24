"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Scissors, Trash2, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { updateTimeEntry, deleteTimeEntry, joinTimeEntries, moveTimeEntryCut, splitTimeEntry } from "../timeclock/actions";
import { buildShiftSpan } from "../timeclock/shift-span";
import type { JobCode } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";
import { useToast } from "@/components/toast";
import { atFromClockTime, clockInputValue, splitClock } from "@/lib/split-preview";
import { hoursBetween } from "@/lib/utils";
import { SplitShiftSheet, type SplitPrefill } from "./split-shift-sheet";
import { StopClockSheet } from "./stop-clock-sheet";
import { clockDoorWords } from "@/lib/long-shift";

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
  status?: string | null;
  /** 0288: the first entry of the shift this piece was cut from, and how. */
  split_from?: string | null;
  split_how?: string | null;
}

/** A touching piece of the same split shift, for Move The Split and Join Back. Its job, lunch and
 *  miles ride along so Join Back can say whose job the hours land on, and its Undo can cut the
 *  shift back where it was. */
export interface SplitNeighbor {
  id: string;
  clock_in: string;
  clock_out: string;
  label: string;
  job_id?: string | null;
  job_code?: string | null;
  lunch_minutes?: number | null;
  miles?: number | null;
}
interface Member {
  id: string;
  full_name: string | null;
  // Pay-rate anchor (staff-only pages pass these): the person's real base pay,
  // plus the customer bill rate so the Rate field can warn when it's typed by
  // mistake. bill_rate is never offered or defaulted into the pay field.
  hourly_rate?: number | null;
  bill_rate?: number | null;
  /** 0286: the owner is paid by owner's draw, so his shifts carry no pay-rate override. */
  paid_by_draw?: boolean | null;
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
  tz = "America/Los_Angeles",
  neighbors,
  initialSplit = null,
  rebuiltFromOldSplit = false,
  workDayEnd,
  viewerId,
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
  /** The org's timezone: every time on the split tools is its wall clock. */
  tz?: string;
  /** The touching pieces of this shift's split, when it has one (Timecards computes them). */
  neighbors?: { prev?: SplitNeighbor | null; next?: SplitNeighbor | null } | null;
  /** Open straight onto Split This Shift, filled in (Nort's fill: /timecards?entry=…&split=1). */
  initialSplit?: SplitPrefill | null;
  /** Any piece of this entry's shift was rebuilt from an old split by 0289, this entry included
   *  when it is the first piece (which carries no split_how of its own). */
  rebuiltFromOldSplit?: boolean;
  /** "HH:MM", the org's work-day end (workDayWindowHm(settings).end): the clock-out sheet
   *  offers it as a chip on the clock-in day. */
  workDayEnd?: string;
  /** The person looking. A running clock that is his own reads "Clock Out", not his own name. */
  viewerId?: string | null;
}) {
  const router = useRouter();
  /** A RUNNING clock is stopped, not edited (2026-09-24): the trigger names whose clock it is,
   *  "Clock Out Brian" (Erik: "an option to [end] an employees time clock and clock out for them"),
   *  and the modal is the clock-out sheet, whose clock-out time starts empty on a forgotten one.
   *  The closed-entry form below is untouched. */
  const isOpen = entry.status === "open" && !entry.clock_out;
  const clockOutWords = clockDoorWords(entry.profiles?.full_name, { self: !!viewerId && entry.profile_id === viewerId }).clockOut;
  const inP = parts(entry.clock_in);
  const outP = parts(entry.clock_out);

  const [open, setOpen] = useState(initialOpen && !initialSplit);
  const [splitting, setSplitting] = useState(initialOpen && !!initialSplit);
  /** The sheet was opened from this edit form, so Cancel goes back to it (with whatever was typed
   *  there still in it) instead of closing everything. */
  const [splitFromForm, setSplitFromForm] = useState(false);
  const toast = useToast();
  /**
   * A SAVED EDIT THAT MOVED BILLED HOURS HAS TO BE READ, NOT GLIMPSED.
   *
   * This warning names an invoice and two figures the office has to act on (adjust the document
   * by hand, or leave it), and it used to go out as an info toast — 2.8 seconds, on a page that
   * refreshes underneath it, on a laptop in a truck. The edit IS saved; the note stays on screen
   * until it is closed.
   */
  const [billedNote, setBilledNote] = useState<string | null>(null);
  const close = () => {
    setBilledNote(null);
    setOpen(false);
    setSplitting(false);
    setSplitFromForm(false);
    onClosed?.();
  };
  const cancelSplit = () => {
    if (!splitFromForm) return close();
    setSplitting(false);
    setSplitFromForm(false);
    setOpen(true);
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
  // The crew's doors offer one 30-minute checkbox (Erik 2026-09-08, off by default); THIS
  // field is the office's precision instrument — any number of minutes, 0 included, and
  // nothing on the server second-guesses it.
  const [lunchMin, setLunchMin] = useState(entry.lunch_minutes ?? 0);
  const [miles, setMiles] = useState(entry.miles ?? 0);
  // rate_override is only WRITTEN when the user actually edits the Rate field — an unrelated
  // save must never silently clear a supervisor override back to base pay.
  const [rate, setRate] = useState(entry.rate_override == null ? 0 : Number(entry.rate_override));
  const [rateDirty, setRateDirty] = useState(false);
  const [notes, setNotes] = useState(entry.notes ?? "");
  // Pay-rate guardrails: anchor the free Rate input to the selected person's REAL
  // base rate, and trip a non-blocking amber warning when the typed value is their
  // BILL rate — the $75-in-the-pay-slot mistake can never happen silently again.
  // Rates stay human-stated (never inferred); nothing here blocks a save.
  const person = members.find((m) => m.id === (profileId || entry.profile_id));
  const baseRate = Number(person?.hourly_rate ?? 0);
  const billRate = Number(person?.bill_rate ?? 0);
  const billRateTyped =
    rate > 0 && billRate > 0 && Math.abs(rate - billRate) <= 0.01 && Math.abs(billRate - baseRate) > 0.01;
  // THE OWNER'S SHIFT HAS NO PAY RATE (0286): he is paid by owner's draw. The field is not offered,
  // and an edit never sends a new one for him; whatever the row already holds round-trips untouched,
  // so an unrelated edit to an old row can never be refused over it.
  const ownerShift = person?.paid_by_draw === true;

  // Payroll locks — surfaced up front so the office doesn't discover them as a save error.
  const basePaid = !!entry.paid_at;
  const mileageSettled = !!entry.mileage_paid_at;

  // Span-aware: an end time earlier in the day than the start means the shift ran past
  // midnight, so it ends on the FOLLOWING day. Rebuilding both stamps on the single Date
  // field meant an overnight shift could never be saved OR corrected here — the modal
  // (and updateTimeEntry) rejected it with "End must be after start" every time.
  const span = buildShiftSpan(date, startT, endT, endDate);

  function save() {
    setError(null);
    setBilledNote(null);
    if (!span) return setError("Invalid date/time.");
    const { clockIn: ci, clockOut: co } = span;
    if (co <= ci) return setError("End must be after start.");
    start(async () => {
      // A REJECTED action must not tear the page down (v800). The office edits timecards on a
      // laptop in a truck as often as at a desk; an unhandled throw inside a transition drops
      // them on the error boundary and the edit is gone.
      let res: { ok: boolean; error?: string; warning?: string };
      try {
        res = await updateTimeEntry({
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
        // The owner's shift never takes a NEW rate (0286), even one typed before the person was
        // switched to him: the stored value round-trips instead. A shift MOVED onto him drops its
        // crew override: he is paid by draw, the Rate field is hidden for him, and 0286's trigger
        // refuses an override riding along on the move (a save the office could never fix here).
        rate_override:
          ownerShift && (profileId || entry.profile_id) !== entry.profile_id
            ? null
            : rateDirty && !ownerShift
              ? rate > 0
                ? rate
                : null
              : entry.rate_override == null
                ? null
                : Number(entry.rate_override),
          profile_id: profileId || undefined,
        });
      } catch {
        return setError("No connection — that didn't go through. Try again in a moment.");
      }
      if (!res.ok) return setError(res.error ?? "Could not save.");
      // A saved edit can still carry a warning (a billed shift whose hours changed) — said, not
      // swallowed, and not on a timer: the modal stays up holding it until the office closes it.
      if (res.warning) {
        setBilledNote(res.warning);
        router.refresh();
        return;
      }
      close();
      router.refresh();
    });
  }

  function remove() {
    if (!confirm("Delete this time entry? This can't be undone.")) return;
    setError(null);
    start(async () => {
      let res: { ok: boolean; error?: string; warning?: string };
      try {
        res = await deleteTimeEntry(entry.id);
      } catch {
        setError("No connection — that didn't go through. Try again in a moment.");
        return;
      }
      if (!res.ok) return setError(res.error ?? "Could not delete.");
      close();
      router.refresh();
    });
  }

  /**
   * THE SPLIT, AND ITS WAY BACK. A split is saved the moment it is tapped (two ordinary entries), so
   * the toast carries Undo, which joins them again: the NOT-annoying law, no save game and no dead
   * end. A carried invoice claim is said out loud, never folded away.
   */
  function afterSplit(r: { left_id?: string; right_id?: string; warning?: string }) {
    close();
    router.refresh();
    const left = r.left_id;
    const right = r.right_id;
    toast(
      "Split into 2 entries.",
      "success",
      left && right
        ? {
            label: "Undo",
            onClick: () => {
              void joinTimeEntries({ left_id: left, right_id: right })
                .then((j) => {
                  toast(j.ok ? "Joined back into one shift." : (j.error ?? "Couldn't join them back."), j.ok ? "success" : "error");
                  router.refresh();
                })
                .catch(() => toast("No connection — the split is still there. Try Join Back from the entry.", "error"));
            },
          }
        : undefined,
    );
    // A carried claim names an invoice: it stays on screen until someone has read it.
    if (r.warning) toast(r.warning, "info", undefined, { sticky: true });
  }

  // MOVE THE SPLIT (slide the time between two touching pieces; never reorders) and JOIN BACK.
  const [moveHm, setMoveHm] = useState<Record<string, string>>({});
  const boundaries = [
    neighbors?.prev ? { key: "prev", left: neighbors.prev.id, right: entry.id, at: entry.clock_in, other: neighbors.prev } : null,
    neighbors?.next && entry.clock_out
      ? { key: "next", left: entry.id, right: neighbors.next.id, at: entry.clock_out, other: neighbors.next }
      : null,
  ].filter(Boolean) as { key: string; left: string; right: string; at: string; other: SplitNeighbor }[];

  function moveCut(b: (typeof boundaries)[number]) {
    setError(null);
    const hm = moveHm[b.key] ?? clockInputValue(b.at, tz);
    const leftStart = b.key === "prev" ? b.other.clock_in : entry.clock_in;
    const rightEnd = b.key === "prev" ? (entry.clock_out ?? b.at) : b.other.clock_out;
    const at = atFromClockTime({ clock_in: leftStart, clock_out: rightEnd }, hm, tz);
    if (!at) return setError(`Pick a time between ${splitClock(leftStart, tz)} and ${splitClock(rightEnd, tz)}.`);
    start(async () => {
      let res: { ok: boolean; error?: string; warning?: string };
      try {
        res = await moveTimeEntryCut({ left_id: b.left, right_id: b.right, at });
      } catch {
        return setError("No connection — that didn't go through. Try again in a moment.");
      }
      if (!res.ok) return setError(res.error ?? "Couldn't move the split.");
      if (res.warning) {
        setBilledNote(res.warning);
        router.refresh();
        return;
      }
      close();
      router.refresh();
      toast(`Moved the split to ${splitClock(at, tz)}.`, "success");
    });
  }

  /**
   * JOIN BACK, SAID OUT LOUD AND UNDOABLE. The joined shift keeps the FIRST part's job, so on a
   * cross-job split the second part's hours change customers: the sheet names that before the tap
   * (joinConsequence) and the toast carries an Undo that cuts the shift again at the same time, on
   * the same job, with the lunch and miles back where they were.
   */
  const joinParts = (b: (typeof boundaries)[number]) => {
    const me = {
      id: entry.id,
      clock_in: entry.clock_in,
      clock_out: entry.clock_out ?? b.at,
      label: entry.job ? jobLabel(entry.job) : entry.job_code || "no job",
      job_id: entry.job_id ?? null,
      job_code: entry.job_code ?? null,
      lunch_minutes: entry.lunch_minutes,
      miles: entry.miles ?? 0,
    };
    return b.key === "prev" ? { left: b.other, right: me } : { left: me, right: b.other };
  };
  const joinConsequence = (b: (typeof boundaries)[number]): string | null => {
    const { left, right } = joinParts(b);
    if ((left.job_id ?? null) === (right.job_id ?? null) && (left.job_code ?? null) === (right.job_code ?? null)) return null;
    const h = hoursBetween(right.clock_in, right.clock_out, Number(right.lunch_minutes) || 0);
    return `Joining puts the ${Math.round(h * 100) / 100} h on ${right.label} onto ${left.label}.`;
  };

  function joinBack(b: (typeof boundaries)[number]) {
    setError(null);
    const { left, right } = joinParts(b);
    const sentence = joinConsequence(b);
    start(async () => {
      let res: { ok: boolean; error?: string };
      try {
        res = await joinTimeEntries({ left_id: b.left, right_id: b.right });
      } catch {
        return setError("No connection — that didn't go through. Try again in a moment.");
      }
      if (!res.ok) return setError(res.error ?? "Couldn't join them back.");
      close();
      router.refresh();
      // The Undo is the split that made the second part: same time, same job or code. Lunch and
      // miles go back to the side that had them (a lunch on both sides was added together and
      // comes back whole on the first).
      const canUndo = !!(right.job_id || right.job_code);
      const rightLunch = (Number(right.lunch_minutes) || 0) > 0 && !((Number(left.lunch_minutes) || 0) > 0);
      const rightMiles = (Number(right.miles) || 0) > 0 && !((Number(left.miles) || 0) > 0);
      toast(
        sentence ? `Joined back into one shift. ${sentence.replace("Joining puts", "It put")}` : "Joined back into one shift.",
        "success",
        canUndo
          ? {
              label: "Undo",
              onClick: () => {
                void splitTimeEntry({
                  entry_id: left.id,
                  at: right.clock_in,
                  job_id: right.job_id ?? null,
                  job_code: right.job_code ?? null,
                  lunch_on: rightLunch ? "right" : "left",
                  miles_on: rightMiles ? "right" : "left",
                })
                  .then((s) => {
                    toast(s.ok ? "Split again, as it was." : (s.error ?? "Couldn't split it again."), s.ok ? "success" : "error");
                    router.refresh();
                  })
                  .catch(() => toast("No connection — the shift is still joined. Split it again from the entry.", "error"));
              },
            }
          : undefined,
      );
    });
  }

  if (!isStaff) return null; // techs can't edit times/job after the fact — office only

  if (isOpen) {
    return (
      <>
        {!hideTrigger && (
          // Wrapped: the week list's controls row sizes every DIRECT child button to a 44px square
          // for the pencil (timecard-stack), which clipped this label to "The C".
          <span className="inline-flex shrink-0">
            <Button
              type="button"
              variant="outline"
              className="h-11 shrink-0 px-3"
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
            >
              {clockOutWords}
            </Button>
          </span>
        )}
        {open && (
          <StopClockSheet
            entry={entry}
            jobs={jobs}
            jobCodes={jobCodes}
            jobCodesEnabled={jobCodesEnabled}
            tz={tz}
            workDayEnd={workDayEnd}
            open={open}
            onClose={close}
            onDelete={remove}
            deleting={pending}
            externalError={error}
            viewerId={viewerId}
          />
        )}
      </>
    );
  }

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

      {/* ── PORTAL, BECAUSE THE PENCIL NOW LIVES INSIDE THE WEEK STACK ────────────────────────
          Erik, 2026-09-18, iPhone, /timecards?week=0: "Alignment and visibility" — the edit form
          drawn INSIDE the week list, wedged between a pay-period break line and the next week's
          card, Job code and Miles squeezed into a sliver, and Delete / Cancel / Save Changes cut
          off past the bottom edge. He could not reach Save.

          Modal renders IN PLACE by default, and until wave 3 that was harmless here: the pencil
          sat in a per-person card BELOW the stack, in ordinary page flow. Wave 3 moved it onto the
          row, which put the overlay inside `<Card className="overflow-clip">` (a ROUNDED, clipping
          box) inside the stack's own `max-h-[70dvh] overflow-y-auto` scroller. That pair is what
          catches the overlay on his phone. Nothing else in the chain explains it — there is no
          transform / filter / backdrop-filter ancestor between the row and <body>, so the classic
          containing-block trap is NOT what is happening, and on desktop Chromium a fixed overlay
          escapes both an `overflow: clip` box and a scroller (hit-tested), which is exactly why
          five waves went by without anyone seeing this.

          Portaling ends the argument instead of tuning it: the overlay renders into <body>, out of
          the scroller, out of the clipping Card, and out of the row's `pointer-events-none`
          wrapper as well. Safe here by the documented rule — NO <form> wraps this Modal, so
          nothing depends on DOM nesting to submit (ModalActions saves through onSave). The same
          mount on the job hub gets the fix for free.
          See Modal's `portal` prop and [[modal-in-glass-menu-portal]]. */}
      <Modal
        open={open}
        onClose={close}
        title="Edit time entry"
        portal
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
          {billedNote && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <div className="font-semibold">Saved. One thing about the invoice:</div>
              <div className="mt-1">{billedNote}</div>
              <Button variant="outline" size="sm" onClick={close} className="mt-2">
                Got It
              </Button>
            </div>
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
          </div>

          {/* SPLIT THIS SHIFT (0288): a day on two jobs is two entries. One cut opens its own sheet,
              and the pieces of a split shift can slide their shared time or join back into one. */}
          {entry.clock_out && (entry.status ?? "closed") === "closed" && (
            <div className="space-y-2 rounded-lg border border-slate-200 p-3">
              <Button type="button" variant="outline" className="h-11 w-full" onClick={() => { setOpen(false); setSplitFromForm(true); setSplitting(true); }} disabled={pending}>
                <Scissors className="h-4 w-4" /> Split This Shift
              </Button>
              <p className="text-xs text-slate-500">
                Worked two jobs, or drove part of it? Cut it at the time you switched. Each part becomes its own entry.
              </p>
              {(entry.split_how === "converted" || rebuiltFromOldSplit) && (
                <p className="text-xs text-slate-500">
                  Rebuilt From An Old Split: this shift was split the old way and has been turned into separate entries.
                </p>
              )}
              {boundaries.map((b) => (
                <div key={b.key} className="space-y-2 border-t border-slate-100 pt-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {b.key === "prev" ? "Split from the part before" : "Split from the part after"} · {b.other.label}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      aria-label="Split time"
                      value={moveHm[b.key] ?? clockInputValue(b.at, tz)}
                      onChange={(e) => setMoveHm((m) => ({ ...m, [b.key]: e.target.value }))}
                      className="h-11 min-w-0 flex-1"
                    />
                    <Button type="button" variant="outline" className="h-11 shrink-0" onClick={() => moveCut(b)} disabled={pending}>
                      Move The Split
                    </Button>
                  </div>
                  <p className="text-xs text-slate-400">Moving the split slides the time between the two parts. Their order stays the same.</p>
                  <Button type="button" variant="ghost" className="h-11 w-full" onClick={() => joinBack(b)} disabled={pending}>
                    <Link2 className="h-4 w-4" /> Join Back Into One Shift
                  </Button>
                  {joinConsequence(b) && <p className="text-xs text-amber-800">{joinConsequence(b)}</p>}
                </div>
              ))}
            </div>
          )}

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
            {!ownerShift && (
              <div>
                <Label htmlFor="e-rate">Rate ($/hr, blank/0 = default)</Label>
                <NumberInput id="e-rate" value={rate} onValueChange={(v) => { setRate(v); setRateDirty(true); }} step={0.5} />
                {baseRate > 0 && (
                  <p className="mt-1 text-xs text-slate-400">{`Base $${baseRate.toFixed(2)}/hr — leave blank to use it`}</p>
                )}
              </div>
            )}
          </div>
          {billRateTyped && !ownerShift && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {`That's ${person?.full_name ?? "this person"}'s bill rate (what customers are charged)${baseRate > 0 ? ` — their pay rate is $${baseRate.toFixed(2)}/hr.` : "."}`}
            </div>
          )}
          {/* The crew's doors carry one 30-minute box, off by default (Erik 2026-09-08).
              This plain minutes field is the OFFICE instrument — 0 = worked through lunch,
              45/60 = a longer one — and nothing on the server second-guesses it. */}
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <span className="text-slate-700">Unpaid lunch</span>
            <span className="ml-auto flex items-center gap-1 text-slate-600">
              <span className="w-16"><NumberInput value={lunchMin} onValueChange={setLunchMin} step={15} aria-label="Lunch minutes" /></span>
              min
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Whatever was ticked at the punch — 0 unless someone said a lunch was taken. Change it here to correct an entry.
          </p>
          <div>
            <Label htmlFor="e-notes">Notes</Label>
            <Textarea id="e-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
      </Modal>
      {splitting && (
        <SplitShiftSheet
          entry={entry}
          jobs={jobs}
          jobCodes={jobCodes}
          tz={tz}
          open={splitting}
          onClose={cancelSplit}
          onSplit={afterSplit}
          prefill={initialSplit}
        />
      )}
    </>
  );
}
