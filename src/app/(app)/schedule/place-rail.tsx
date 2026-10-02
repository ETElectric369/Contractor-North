"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Phone, Mail, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PhoneInput } from "@/components/ui/phone-input";
import { formatPhone } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { setLeadContact, sizeLead } from "../leads/actions";
import { setJobContact, setJobHold, sizeAppointment, sizeJob, snoozeJobHold } from "./actions";
import { usePlacement } from "./placement-context";
import { WorkShapeControls } from "@/components/work-shape-controls";
import { ComeBackPicker } from "@/components/come-back-picker";
import { RowMoreSheet, SheetLink, SHEET_ROW } from "@/components/row-more-sheet";
import { backWords, comeBackDue } from "@/lib/come-back-days";
import { armedInstruction } from "@/lib/schedule/placement-plan";
import { placeLine } from "@/lib/schedule/block-info";
import { CrewInitials } from "@/components/crew-initials";
import {
  groupByTown,
  nextAction,
  whatsMissing,
  type Placeable,
} from "@/lib/schedule/place-by-town";
import {
  dayLoad,
  durationLabel,
  KIND_LABEL,
  KIND_TONE,
  workKind,
} from "@/lib/schedule/work-shape";

/**
 * EVERYTHING WAITING FOR A DAY, next to the calendar.
 *
 * Erik's bug report: "how do I put these on the schedule is the big denny … i dont know what."
 * He had 32 open leads, 27 with addresses, and ZERO future appointments — because nothing anywhere
 * put "the leads" and "the calendar" in the same view. The calendar's old "To schedule" tray held
 * only dateless JOBS; a lead had never been in it. He scanned one list, then the other, and
 * bridged it in his head. This rail is the ONE door for waiting work: the tray was cut in W2-05
 * (every job it held was already here), and the place's toast carries the Undo it had.
 *
 * ONE ⋯ PER CARD (W2-05). A card's verbs (open the record; put a job on hold, snooze it, change why,
 * take it off hold) sit behind one 44px ⋯ (the app's one row sheet), so ticking five jobs no longer
 * unfolds five status dropdowns beside the job page's one status control. Status changes (Done,
 * Cancelled…) happen on the job page's pill.
 *
 * TAP THE WORK, THEN TAP THE DAY. He picked this himself — "tap the job then tap the day sounds
 * like a great path" — and it beats drag-and-drop where it matters: one-handed, in a truck, on a
 * phone. Dragging a lead onto a day on a six-inch screen means a long-press, a scroll mid-drag,
 * and a drop target under your thumb. Two taps work everywhere and are the same gesture whether
 * you have a pointer or not. (Drag can be added on top later; it must never be the only way.)
 *
 * Grouped by town, biggest cluster first, because geography picks the day — his five Truckee
 * leads are a Tuesday. What a lead is MISSING shows as its next action rather than demoting it:
 * Mike Sparrow has no address but a phone and a real note, so his next move is a call, not the
 * bottom of the list. See lib/schedule/place-by-town.
 */
/** A job's or a visit's place line and crew, for its card: the words its block on the calendar says
 *  (lib/schedule/block-info). "14161 Tupelo Ln." the job and "14161 Tupelo Lane" the address are the
 *  same fact, so a job named for its street reads who instead of the street twice. */
function PlaceAndCrew({ i }: { i: Placeable }) {
  const place = placeLine({ name: i.name, street: i.address, customer: i.customer });
  return (
    <>
      {place && (
        <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
          {place.kind === "street" && <MapPin className="h-3 w-3 shrink-0" />} {place.text}
        </span>
      )}
      {Array.isArray(i.crew) && (
        <span className="mt-1 flex">
          <CrewInitials crew={i.crew} />
        </span>
      )}
    </>
  );
}

/** Where a card's record lives, and the row that opens it. */
function openRow(i: Placeable): { href: string; label: string } {
  if (i.kind === "job") return { href: `/jobs/${i.id}`, label: "Open The Job" };
  if (i.kind === "appointment") return { href: `/appointments/${i.id}`, label: "Open The Visit" };
  return { href: `/leads?focus=${i.id}`, label: "Open The Lead" };
}

/**
 * A CARD'S ⋯ SHEET (W2-05): titled with the card's name, the address under it. Every kind opens its
 * record. A job not on hold can be put on hold (why, and the day it comes back: ComeBackPicker, "Hold
 * It"); a held job can be snoozed to another day, have its why changed (its day kept), or be taken off
 * hold. Each closes the sheet when it lands; a refusal is said in its words, right where it was asked.
 * No glass menu nests inside it (the modal-in-glass-menu lesson): the pickers are inline.
 */
export function RailCardMore({ i, todayStr }: { i: Placeable; todayStr?: string }) {
  return (
    <RowMoreSheet title={i.name} subline={i.address ?? null}>
      {/* The rows mount with the sheet, so a half-picked hold never survives a close. */}
      {({ close }) => <RailCardRows i={i} todayStr={todayStr} close={close} />}
    </RowMoreSheet>
  );
}

/** The rows of a card's ⋯ sheet (exported for its render test). */
export function RailCardRows({ i, todayStr, close }: { i: Placeable; todayStr?: string; close: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"hold" | "snooze" | "why" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [why, setWhy] = useState(i.holdReason ?? "");
  const open = openRow(i);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, said?: string) =>
    start(async () => {
      setErr(null);
      try {
        const res = await fn();
        if (!res.ok) {
          setErr(res.error ?? "That didn't change. Try again.");
          return;
        }
        close();
        setMode(null);
        if (said) toast(said, "success");
        router.refresh();
      } catch {
        setErr("That didn't reach the server. Check your connection and try again.");
      }
    });

  return (
    <>
      <SheetLink href={open.href}>{open.label}</SheetLink>
      {i.kind === "job" && !i.onHold && (
        mode === "hold" ? (
          <ComeBackPicker
            label="Hold It"
            requireWhy
            autoFocus
            todayStr={todayStr}
            pending={pending}
            error={err}
            onCancel={() => {
              setMode(null);
              setErr(null);
            }}
            onSubmit={({ why: w, when }) => run(() => setJobHold(i.id, w, when), `${i.name} is on hold.`)}
          />
        ) : (
          <button type="button" className={SHEET_ROW} onClick={() => { setErr(null); setMode("hold"); }}>
            Put On Hold…
          </button>
        )
      )}
      {i.kind === "job" && i.onHold && (
        <>
          {mode === "snooze" ? (
            <ComeBackPicker
              label="Snooze"
              askWhy={!i.holdReason}
              autoFocus={!i.holdReason}
              todayStr={todayStr}
              pending={pending}
              error={err}
              onCancel={() => {
                setMode(null);
                setErr(null);
              }}
              onSubmit={({ why: w, when }) => run(() => snoozeJobHold(i.id, when, w || null))}
            />
          ) : (
            <button type="button" className={SHEET_ROW} onClick={() => { setErr(null); setMode("snooze"); }}>
              Snooze…
            </button>
          )}
          {mode === "why" ? (
            <div className="space-y-2">
              {/* THE WHY ALONE: its day is kept, so no day chips are offered that would do nothing. */}
              <input
                autoFocus
                value={why}
                onChange={(e) => setWhy(e.target.value)}
                placeholder="Waiting on the permit"
                aria-label="Why?"
                className="h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" disabled={pending || !why.trim()} onClick={() => run(() => setJobHold(i.id, why.trim()))}>
                  {pending ? "Saving…" : "Change Why"}
                </Button>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => { setMode(null); setErr(null); }}>
                  Cancel
                </Button>
              </div>
              {err && <p className="text-xs font-medium text-red-600">{err}</p>}
            </div>
          ) : (
            <button type="button" className={SHEET_ROW} onClick={() => { setErr(null); setWhy(i.holdReason ?? ""); setMode("why"); }}>
              Change Why…
            </button>
          )}
          <button
            type="button"
            className={SHEET_ROW}
            disabled={pending}
            onClick={() =>
              run(
                () => setJobHold(i.id, null),
                // A held job that still carries a day goes back on the calendar on it; one with none
                // stays here, waiting for a day. Said, either way.
                i.hasDay ? `${i.name} is off hold and back on the calendar.` : `${i.name} is off hold. It stays here until it has a day.`,
              )
            }
          >
            Take Off Hold
          </button>
          {mode === null && err && <p className="text-xs font-medium text-red-600">{err}</p>}
        </>
      )}
    </>
  );
}

/** "13:30" is a database. "1:30pm" is a person. The footer reads back what will happen, so it
 *  speaks the second one. */
function prettyTime(hm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return hm;
  const h = Number(m[1]);
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m[2] === "00" ? `${h12}${suffix}` : `${h12}:${m[2]}${suffix}`;
}

export function PlaceRail({
  items,
  todayStr,
}: {
  items: Placeable[];
  /** The company's today (YYYY-MM-DD): a held card's "Back Oct 3", and the day the hold picker works out. */
  todayStr?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  /* WHO IS PICKED IS NOT THE RAIL'S SECRET ANY MORE. The second tap now lands on the calendar next
     door, so the picked set lives in a context both can see. AM/PM likewise: chosen here, applied
     by whichever surface commits. Erik: "put them on a day am or pm … i can see that the visit is
     on the way and choose to plan it/its for before or after." Morning starts 8, afternoon 1 — the
     two halves a contractor's day actually has, not a time picker demanding a precision nobody has
     while planning. */
  const { picked, toggle, clear, half, setHalf, startAt, setStartAt, halfTimes, pending: placing } = usePlacement();

  const groups = useMemo(() => groupByTown(items), [items]);
  const chosen = useMemo(
    () => items.filter((i) => picked.has(i.id)),
    [items, picked],
  );
  const load = dayLoad(chosen);
  const jobs = chosen.filter((i) => i.kind === "job");

  /** Which card is unfolded for editing — SEPARATE from the pick. Erik: "when i click on the
   *  card it checks the checkbox automatically, lets make it so i have to check the check box to
   *  check the check box." Tapping the body now opens the card's controls without arming the
   *  calendar; only the box picks. Editing and placing are different intents, one card. */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /** The driveway entry — a phone heard out loud goes straight in. Blank never erases. A lead's
   *  contact is its own; a job's rides its customer (setJobContact's fill-only rule). */
  function contact(i: Placeable, patch: { phone?: string; email?: string }) {
    if (!String(patch.phone ?? patch.email ?? "").trim()) return;
    start(async () => {
      const res = i.kind === "job" ? await setJobContact(i.id, patch) : await setLeadContact(i.id, patch);
      if (!res.ok) { toast(res.error ?? "Couldn't save that.", "error"); return; }
      router.refresh();
    });
  }

  /** ONE CONTROL, THREE TABLES. A floater's size lives on `jobs`, a lead's on `inquiries`, an
   *  already-booked visit's on `appointments`. The card doesn't make him care which — but the
   *  dispatch has to be exhaustive, because sending one kind's id to another kind's writer updates
   *  zero rows and, by the silent-write law, that reads as an error about the wrong record. */
  function size(i: Placeable, patch: { workKind?: string; plannedMinutes?: number | null }) {
    start(async () => {
      const res =
        i.kind === "job"
          ? await sizeJob(i.id, patch.plannedMinutes ?? null)
          : i.kind === "appointment"
            ? await sizeAppointment(i.id, patch)
            : await sizeLead(i.id, patch);
      if (!res.ok) { toast(res.error ?? "Couldn't save that.", "error"); return; }
      router.refresh();
    });
  }

  if (!items.length) {
    return (
      <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-400">
        Nothing waiting for a day. Leads with no visit booked show up here.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.town}>
          <div className="mb-1.5 flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-slate-900">{g.town}</h3>
            <span className="text-xs text-slate-400">
              {g.items.length} waiting
              {/* The townless group is labelled, never demoted — it sorts by size like the rest. */}
              {g.unlocatable && " · no address yet"}
            </span>
          </div>
          <ul className="space-y-1">
            {g.items.map((i) => {
              const miss = whatsMissing(i); // `i` carries kind — a job is never asked for a phone
              const on = picked.has(i.id);
              return (
                <li key={i.id}>
                {/* THE CARD IS NOT A BUTTON — the summary inside it is.
                    It used to be one, with the selects nested inside it and a stopPropagation to
                    keep them alive. That held right up until the custom sizer added an <input> and
                    a <button>: a <button> inside a <button> is invalid HTML, and the parser closes
                    the outer one where the inner begins, so the DOM the browser built stopped
                    matching the tree React thought it had. Karen Willet's "3 hrs" went nowhere —
                    typed, apparently accepted, never saved.
                    A control nested inside a control is a bug waiting for its second control. */}
                  <div
                    className={`rounded-lg border px-3 py-2 transition-colors ${
                      on ? "border-brand bg-brand-light/40" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex w-full items-start">
                      {/* THE BOX PICKS. Its own control, a sibling of the body tap — never nested
                          (the Karen lesson), and sized for a thumb: a 44px target around the box. */}
                      <button
                        type="button"
                        onClick={() => toggle(i.id)}
                        aria-pressed={on}
                        aria-label={on ? `Unpick ${i.name}` : `Pick ${i.name} to place on a day`}
                        className="-my-2 -ml-3 -mr-1 flex h-11 w-11 shrink-0 items-center justify-center"
                      >
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded border ${
                            on ? "border-brand bg-brand text-white" : "border-slate-300 hover:border-brand/60"
                          }`}
                        >
                          {on && <Check className="h-3.5 w-3.5" />}
                        </span>
                      </button>
                      {/* THE BODY OPENS. Editing and placing are different intents: a tap here
                          unfolds the in-place controls without arming the calendar. */}
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === i.id ? null : i.id)}
                        aria-expanded={on || expandedId === i.id}
                        className="min-h-11 min-w-0 flex-1 text-left"
                      >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-sm font-medium text-slate-900">{i.name}</span>
                          {/* THE TAG AND THE CLOCK — Erik: "a tag showing service call, job,
                              inspection/walk through, or office … and how much time they are going
                              to take". Between them a day is plannable by eye. */}
                          <Badge tone={KIND_TONE[workKind(i)]}>{KIND_LABEL[workKind(i)]}</Badge>
                          <span
                            className={`font-mono text-xs tabular-nums ${
                              i.planned_minutes ? "text-slate-600" : "text-slate-300"
                            }`}
                            title={i.planned_minutes ? "Expected time" : "Nobody has sized this yet"}
                          >
                            {durationLabel(i.planned_minutes)}
                          </span>
                          {i.urgent && <Badge tone="amber">overdue</Badge>}
                          {i.onHold && (
                            <Badge tone="slate">
                              {/* THE REASON IS THE ACTION. "on hold" alone is a shrug; "on hold —
                                  waiting on the permit" tells you what wakes it. */}
                              on hold{i.holdReason ? ` — ${i.holdReason}` : ""}
                            </Badge>
                          )}
                          {/* THE DAY IT COMES BACK, ON THE CARD (text to visual, 0366): "Back Oct 3",
                              amber "Back Today" once it has come (or "No Day Set" for a hold from
                              before the day existed). No chip while the database has no day yet. */}
                          {i.onHold && todayStr && i.holdUntil !== undefined && (
                            <Badge tone={comeBackDue(i.holdUntil, todayStr) ? "amber" : "slate"}>{backWords(i.holdUntil, todayStr)}</Badge>
                          )}
                        </span>
                        {/* WHERE AND WHO, as the job's block on the calendar says it: a job or a
                            visit reads its street number and name (never the city: the group above
                            is the town), or who when its name already is the street, then who's on
                            it as initials (a dashed Nobody). A lead keeps the address it was given. */}
                        {i.kind === "lead" ? (
                          i.address && (
                            <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                              <MapPin className="h-3 w-3 shrink-0" /> {i.address}
                            </span>
                          )
                        ) : (
                          <PlaceAndCrew i={i} />
                        )}
                        {/* THE SPOT, NOT THE SERMON. Erik: "i dont like the red letters telling
                            me to go look it up lets make it a spot that just says Phone that i can
                            enter one on the spot same with email and in the same spot it should be
                            displayed once entered." He also caught the inversion: the card
                            announced a missing phone and said NOTHING about one it had. One line,
                            both jobs: shows the value when there is one, shows a quiet dash when
                            there isn't — and picking the card turns the dashes into inputs. */}
                        {miss === "place" && (
                          <span className={`mt-0.5 flex items-center gap-1 text-xs ${on ? "font-medium text-amber-700" : "text-slate-400"}`}>
                            {on ? nextAction(miss) : "no address yet"}
                          </span>
                        )}
                      </span>
                      </button>
                      {/* THE CARD'S ⋯: its record, and a job's hold verbs (RailCardMore). A sibling
                          of the box and the body, never inside either. */}
                      <span className="-my-2 -mr-2 ml-1 shrink-0">
                        <RailCardMore i={i} todayStr={todayStr} />
                      </span>
                    </div>

                    {/* THE CONTACT LINE — a SIBLING of the body button, because the phone is a
                        LINK now (Erik: "give him a call from a tap" — tel:/mailto: dial from the
                        browser and the PWA alike) and a link inside a button is the Karen lesson.
                        Every kind shows what it has; leads and jobs show dashes for the gaps,
                        because both can take a number here (a lead's own, a job's via its
                        customer). Appointments display-only. */}
                    {(i.kind !== "appointment" || i.phone || i.email) && (
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-7 text-xs text-slate-500">
                        {(i.kind !== "appointment" || i.phone) && (
                          <span className="inline-flex items-center gap-1">
                            <Phone className="h-3 w-3 shrink-0" />
                            {i.phone ? (
                              <a href={`tel:${i.phone.replace(/[^\d+]/g, "")}`} className="hover:text-brand hover:underline">
                                {formatPhone(i.phone)}
                              </a>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </span>
                        )}
                        {(i.kind !== "appointment" || i.email) && (
                          <span className="inline-flex items-center gap-1">
                            <Mail className="h-3 w-3 shrink-0" />
                            {i.email ? (
                              <a href={`mailto:${i.email}`} className="hover:text-brand hover:underline">{i.email}</a>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </span>
                        )}
                      </span>
                    )}

                    {/* SIZE IT RIGHT HERE. Erik: "editable on the schedule page". The moment you
                        NEED the number is while filling a day; making him leave, find the lead,
                        edit and come back is the round trip he says costs the most. A sibling of
                        the tap target now, not a descendant. */}
                    {(on || expandedId === i.id) && (
                      <div className="mt-1.5 space-y-1.5 pl-6">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* THE SAME control the lead row carries — see work-shape-controls. */}
                          <WorkShapeControls
                            workKind={i.workKind ?? null}
                            plannedMinutes={i.planned_minutes ?? null}
                            showKind={i.kind !== "job"}
                            disabled={pending}
                            onPatch={(patch) => size(i, patch)}
                          />
                          {/* The record is one tap away in the card's ⋯ (Open The Job, Open The Visit,
                              Open The Lead), never a second link here. */}
                        </div>

                        {/* Enter the phone/email ON THE SPOT — the driveway moment. Saves on Enter
                            or when the field loses focus; blank never erases. A JOB's entry rides
                            its customer (fill-the-gap only; a customer-less job mints a minimal
                            card from the fragment — see setJobContact). */}
                        {(i.kind === "lead" || i.kind === "job") && (!i.phone || !i.email) && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {!i.phone && (
                              /* The app's ONE phone control — formats "(530) 555-0133" as you
                                 type. A bare input here stored 4153703682 beside formatted
                                 numbers: the hand-copied-control bug, caught by Erik in a day. */
                              <PhoneInput
                                name="phone"
                                autoComplete="tel"
                                placeholder="Phone"
                                aria-label="Phone — enter it on the spot"
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                onBlur={(e) => contact(i, { phone: e.target.value })}
                                className="h-11 w-36 rounded-md px-1.5 text-sm"
                              />
                            )}
                            {!i.email && (
                              <input
                                name="email"
                                type="email"
                                autoComplete="email"
                                inputMode="email"
                                placeholder="Email"
                                aria-label="Email — enter it on the spot"
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                onBlur={(e) => contact(i, { email: e.target.value })}
                                className="h-11 w-40 rounded-md border border-slate-200 px-1.5 text-sm"
                              />
                            )}
                          </div>
                        )}
                        {/* No status control here (W2-05): the job page's status pill is the one;
                            putting a job on hold, snoozing it, changing why and taking it off hold
                            live in the card's ⋯. */}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/* THE SECOND TAP IS ON THE CALENDAR NOW.
          Erik: "i cant see the whole calendar on the bottom to pick the day, wondering about what
          you said before about being able to click the day on the calendar to pick it once the jobs
          are checked."
          The date field that used to sit here opened its native month popup downward off the bottom
          of the window — he could see four rows of it. But the field was the wrong idea even
          unclipped: a second, BLIND calendar with no towns and no existing work on it, asking him
          to choose a day with everything hidden, while the calendar carrying exactly that sat four
          inches to the right. So the real one is the picker, and this bar is now a instruction and
          a running total rather than a form.
          bottom-20 on phones: the glass dock floats over bottom-0, and this bar carries the only
          "place it" instructions — pinned under the dock it was unreadable at 60mph. */}
      {chosen.length > 0 && (
        <div className="sticky bottom-20 space-y-2 rounded-xl border border-brand/40 bg-white/95 p-3 shadow-lg backdrop-blur lg:bottom-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-slate-900">
              {chosen.length} picked
            </span>
            {jobs.length > 0 && (
              <span className="text-xs text-slate-500">
                {jobs.length} {jobs.length === 1 ? "floater" : "floaters"}
              </span>
            )}
            {/* WHAT THE DAY WILL HOLD, before he commits to it — the whole reason the sizes exist.
                Unsized items are counted separately rather than assumed to take nothing. */}
            {load.label && <span className="text-xs text-slate-500">· about {load.label}</span>}
          </div>

          <p className="text-sm font-medium text-brand">{armedInstruction(chosen.length)}</p>

          {/* ON A PHONE THE CALENDAR IS BELOW EVERY WAITING CARD — thousands of pixels of rail
              between the first tap and the second. "Tap the day" is not a gesture if the days are
              off-screen; this jump makes the second tap one tap away on any screen. Hidden on lg,
              where the calendar is already beside the rail. */}
          <button
            type="button"
            onClick={() => document.getElementById("schedule-calendar")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="min-h-11 w-full rounded-lg border-2 border-dashed border-brand/50 bg-brand-light/30 px-3 py-2 text-sm font-semibold text-brand lg:hidden"
          >
            Jump To The Calendar ↓
          </button>

          <div className="flex flex-wrap items-center gap-2">
            {/* A HALF OR A TIME — never both lit at once.
                They answer the same question, so a screen showing AM selected AND 12:30 PM entered
                is a screen telling him two things and letting him guess which one the app will
                use. Picking a half clears the exact time; entering a time dims the halves, so
                whichever he touched last is visibly the one that counts. */}
            <span className="inline-flex overflow-hidden rounded-lg border border-slate-200">
              {(["am", "pm"] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => { setHalf(h); setStartAt(""); }}
                  className={`inline-flex h-11 items-center px-3 text-xs font-semibold uppercase ${
                    half === h && !startAt
                      ? "bg-brand text-white"
                      : "bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {h}
                </button>
              ))}
            </span>
            {/* OR AN EXACT TIME. The halves stay the two-tap default; this is the escape hatch for
                the times he already knows — 7am before the supply house, the 10:30 she asked for. */}
            <input
              type="time"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              aria-label="Start at an exact time instead"
              className={`h-11 rounded-lg border px-1.5 text-sm ${
                startAt ? "border-brand text-brand" : "border-slate-200 text-slate-400"
              }`}
            />
            {startAt && (
              <button
                type="button"
                onClick={() => setStartAt("")}
                className="inline-flex min-h-11 items-center px-1 text-xs font-medium text-slate-400 hover:text-slate-700"
              >
                Clear Time
              </button>
            )}
            <span className="w-full text-xs text-slate-400">
              {/* HIS working day (Settings → Crew & time), never a literal — the rail used to
                  promise 8am to a shop that opens at 9. */}
              Starting {prettyTime(startAt || (half === "am" ? halfTimes.am : halfTimes.pm))}, in the order shown.
              {/* THE DEFAULT, SAID BEFORE THE TAP (lib/schedule/job-block): a job with no length
                  lands as two hours, never the rest of the day. Size it above to land it longer. */}
              {jobs.some((j) => !j.planned_minutes) && " A job with no length goes down as 2 hours."}
            </span>
            <button
              type="button"
              onClick={clear}
              className="ml-auto inline-flex min-h-11 items-center px-2 text-xs font-medium text-slate-500 hover:text-slate-800"
            >
              Clear
            </button>
          </div>
          {placing && <p className="text-xs font-medium text-brand">Placing…</p>}
        </div>
      )}
    </div>
  );
}
