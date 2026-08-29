"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MapPin, Phone, Mail, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { setLeadContact, sizeLead } from "../leads/actions";
import { setJobHold, sizeAppointment, sizeJob } from "./actions";
import { usePlacement } from "./placement-context";
import { WorkShapeControls } from "@/components/work-shape-controls";
import { armedInstruction } from "@/lib/schedule/placement-plan";
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
 * bridged it in his head.
 *
 * TAP THE WORK, THEN TAP THE DAY. He picked this himself — "tap the job then tap the day sounds
 * like a great path" — and it beats drag-and-drop where it matters: one-handed, in a truck, on a
 * phone. Dragging a lead onto a day on a six-inch screen means a long-press, a scroll mid-drag,
 * and a drop target under your thumb. Two taps work everywhere and are the same gesture whether
 * you have a pointer or not. (Drag can be added on top later; it must never be the only way.)
 *
 * Grouped by town, biggest cluster first, because geography picks the day — his five Truckee
 * leads are a Tuesday. What a lead is MISSING shows as its next action rather than demoting it:
 * Mike Scrivano has no address but a phone and a real note, so his next move is a call, not the
 * bottom of the list. See lib/schedule/place-by-town.
 */
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

export function PlaceRail({ items }: { items: Placeable[] }) {
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

  /** Which job is typing its hold reason. */
  const [holdFor, setHoldFor] = useState<string | null>(null);
  const [holdReason, setHoldReason] = useState("");

  /** The driveway entry — a phone heard out loud goes straight in. Blank never erases. */
  function contact(id: string, patch: { phone?: string; email?: string }) {
    if (!String(patch.phone ?? patch.email ?? "").trim()) return;
    start(async () => {
      const res = await setLeadContact(id, patch);
      if (!res.ok) { toast(res.error ?? "Couldn't save that.", "error"); return; }
      router.refresh();
    });
  }

  /** Park with a reason, or wake. */
  function hold(id: string, reason: string | null) {
    start(async () => {
      const res = await setJobHold(id, reason);
      if (!res.ok) { toast(res.error ?? "Couldn't change that.", "error"); return; }
      setHoldFor(null);
      setHoldReason("");
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
                    matching the tree React thought it had. Karen Wucher's "3 hrs" went nowhere —
                    typed, apparently accepted, never saved.
                    A control nested inside a control is a bug waiting for its second control. */}
                  <div
                    className={`rounded-lg border px-3 py-2 transition-colors ${
                      on ? "border-brand bg-brand-light/40" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(i.id)}
                      aria-pressed={on}
                      className="flex w-full items-start gap-2 text-left"
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          on ? "border-brand bg-brand text-white" : "border-slate-300"
                        }`}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
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
                        </span>
                        {i.address && (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                            <MapPin className="h-3 w-3 shrink-0" /> {i.address}
                          </span>
                        )}
                        {/* THE SPOT, NOT THE SERMON. Erik: "i dont like the red letters telling
                            me to go look it up lets make it a spot that just says Phone that i can
                            enter one on the spot same with email and in the same spot it should be
                            displayed once entered." He also caught the inversion: the card
                            announced a missing phone and said NOTHING about one it had. One line,
                            both jobs: shows the value when there is one, shows a quiet dash when
                            there isn't — and picking the card turns the dashes into inputs. */}
                        {/* Every kind shows the contact it HAS (a job's rides its customer);
                            only a lead shows dashes for the gaps, because only a lead's contact
                            is entered here — a job's belongs to the customer record. */}
                        {(i.kind === "lead" || i.phone || i.email) && (
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                            {(i.kind === "lead" || i.phone) && (
                              <span className="inline-flex items-center gap-1">
                                <Phone className="h-3 w-3 shrink-0" />
                                {i.phone || <span className="text-slate-300">—</span>}
                              </span>
                            )}
                            {(i.kind === "lead" || i.email) && (
                              <span className="inline-flex items-center gap-1">
                                <Mail className="h-3 w-3 shrink-0" />
                                {i.email || <span className="text-slate-300">—</span>}
                              </span>
                            )}
                          </span>
                        )}
                        {miss === "place" && (
                          <span className={`mt-0.5 flex items-center gap-1 text-xs ${on ? "font-medium text-amber-700" : "text-slate-400"}`}>
                            {on ? nextAction(miss) : "no address yet"}
                          </span>
                        )}
                      </span>
                    </button>

                    {/* SIZE IT RIGHT HERE. Erik: "editable on the schedule page". The moment you
                        NEED the number is while filling a day; making him leave, find the lead,
                        edit and come back is the round trip he says costs the most. A sibling of
                        the tap target now, not a descendant. */}
                    {on && (
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
                          {/* THE RECORD, ONE TAP AWAY — Erik: "it would be great to access the job
                              or appt". The board edits the common things in place; the record page
                              holds everything else. */}
                          <Link
                            href={i.kind === "job" ? `/jobs/${i.id}` : i.kind === "appointment" ? `/appointments/${i.id}` : `/leads?focus=${i.id}`}
                            className="text-xs font-medium text-brand hover:underline"
                          >
                            Open →
                          </Link>
                        </div>

                        {/* Enter the phone/email ON THE SPOT — the driveway moment. Saves on Enter
                            or when the field loses focus; blank never erases. */}
                        {i.kind === "lead" && (!i.phone || !i.email) && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {!i.phone && (
                              <input
                                inputMode="tel"
                                placeholder="Phone"
                                aria-label="Phone — enter it on the spot"
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                onBlur={(e) => contact(i.id, { phone: e.target.value })}
                                className="h-7 w-32 rounded-md border border-slate-200 px-1.5 text-xs"
                              />
                            )}
                            {!i.email && (
                              <input
                                inputMode="email"
                                placeholder="Email"
                                aria-label="Email — enter it on the spot"
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                onBlur={(e) => contact(i.id, { email: e.target.value })}
                                className="h-7 w-40 rounded-md border border-slate-200 px-1.5 text-xs"
                              />
                            )}
                          </div>
                        )}

                        {/* PARK IT OR WAKE IT, from right here — with the reason, because "on hold"
                            alone is a shrug and the reason is what tells you what un-parks it. */}
                        {i.kind === "job" &&
                          (i.onHold ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                              {/* THE REASON, EDITABLE WHERE IT LIVES. Erik: "the already on hold
                                  job isnt editable in place" — a pre-0234 hold (no reason) had no
                                  way to gain one without waking and re-parking. Type it, Enter or
                                  blur saves; blank leaves it alone. */}
                              <input
                                defaultValue={i.holdReason ?? ""}
                                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  if (v && v !== (i.holdReason ?? "")) hold(i.id, v);
                                }}
                                placeholder="Why? — waiting on the permit"
                                aria-label="Why is this on hold"
                                className="h-7 w-56 rounded-md border border-slate-200 px-1.5 text-xs"
                              />
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => hold(i.id, null)}
                                className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                              >
                                Take off hold
                              </button>
                            </span>
                          ) : holdFor === i.id ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <input
                                autoFocus
                                value={holdReason}
                                onChange={(e) => setHoldReason(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); hold(i.id, holdReason); }
                                  if (e.key === "Escape") setHoldFor(null);
                                }}
                                placeholder="Why? — waiting on the permit"
                                aria-label="Why is this on hold"
                                className="h-7 w-56 rounded-md border border-brand/60 px-1.5 text-xs"
                              />
                              <button
                                type="button"
                                onClick={() => hold(i.id, holdReason)}
                                className="h-7 rounded-md bg-brand px-2 text-xs font-semibold text-white"
                              >
                                Hold it
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => { setHoldFor(i.id); setHoldReason(""); }}
                              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                            >
                              Put on hold…
                            </button>
                          ))}
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
          a running total rather than a form. */}
      {chosen.length > 0 && (
        <div className="sticky bottom-0 space-y-2 rounded-xl border border-brand/40 bg-white/95 p-3 shadow-lg backdrop-blur">
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
            className="w-full rounded-lg border-2 border-dashed border-brand/50 bg-brand-light/30 px-3 py-2 text-sm font-semibold text-brand lg:hidden"
          >
            Jump to the calendar ↓
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
                  className={`px-3 py-1.5 text-xs font-semibold uppercase ${
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
              className={`h-8 rounded-lg border px-1.5 text-xs ${
                startAt ? "border-brand text-brand" : "border-slate-200 text-slate-400"
              }`}
            />
            {startAt && (
              <button
                type="button"
                onClick={() => setStartAt("")}
                className="text-xs font-medium text-slate-400 hover:text-slate-700"
              >
                clear time
              </button>
            )}
            <span className="w-full text-xs text-slate-400">
              {/* HIS working day (Settings → Crew & time), never a literal — the rail used to
                  promise 8am to a shop that opens at 9. */}
              Starting {prettyTime(startAt || (half === "am" ? halfTimes.am : halfTimes.pm))}, in the order shown.
            </span>
            <button
              type="button"
              onClick={clear}
              className="ml-auto text-xs font-medium text-slate-500 hover:text-slate-800"
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
