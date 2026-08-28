"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Phone, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { sizeLead } from "../leads/actions";
import { sizeAppointment, sizeJob } from "./actions";
import { usePlacement } from "./placement-context";
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
  parseDuration,
  WORK_KINDS,
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
/** The durations the dropdown offers. Anything stored that isn't one of these still renders — see
 *  the synthetic option below. */
const SIZE_BUCKETS = [30, 60, 120, 240, 480, 960, 1440, 2400];

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
  /** Which card is typing its own duration. Erik: "we definitly need a custom option." */
  const [customFor, setCustomFor] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");

  const groups = useMemo(() => groupByTown(items), [items]);
  const chosen = useMemo(
    () => items.filter((i) => picked.has(i.id)),
    [items, picked],
  );
  const load = dayLoad(chosen);
  const jobs = chosen.filter((i) => i.kind === "job");

  /** ONE CONTROL, THREE TABLES. A floater's size lives on `jobs`, a lead's on `inquiries`, an
   *  already-booked visit's on `appointments`. The card doesn't make him care which — but the
   *  dispatch has to be exhaustive, because sending one kind's id to another kind's writer updates
   *  zero rows and, by the silent-write law, that reads as an error about the wrong record. */
  /** Read what he typed, or say plainly that it couldn't be read. Never a silent round. */
  function saveCustom(i: Placeable) {
    const minutes = parseDuration(customText);
    if (!minutes) {
      toast(`I couldn't read "${customText.trim()}" — try 45m, 1.5h, or 2d.`, "error");
      return;
    }
    setCustomFor(null);
    setCustomText("");
    size(i, { plannedMinutes: minutes });
  }

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
                          {i.onHold && <Badge tone="slate">on hold</Badge>}
                        </span>
                        {i.address && (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                            <MapPin className="h-3 w-3 shrink-0" /> {i.address}
                          </span>
                        )}
                        {/* THE GAP, QUIET UNTIL IT IS IN THE WAY. A warning on nine of twelve cards
                            is wallpaper; this speaks up in full only once the card is picked, which
                            is the moment the missing piece actually stands in the way. */}
                        {miss !== "nothing" && (
                          <span
                            className={`mt-0.5 flex items-center gap-1 text-xs ${
                              on ? "font-medium text-amber-700" : "text-slate-400"
                            }`}
                          >
                            {miss === "place" && <Phone className="h-3 w-3 shrink-0" />}
                            {on ? nextAction(miss) : miss === "place" ? "no address yet" : "no phone or email"}
                          </span>
                        )}
                      </span>
                    </button>

                    {/* SIZE IT RIGHT HERE. Erik: "editable on the schedule page". The moment you
                        NEED the number is while filling a day; making him leave, find the lead,
                        edit and come back is the round trip he says costs the most. A sibling of
                        the tap target now, not a descendant. */}
                    {on && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
                        {/* A JOB IS A JOB — no kind to pick. Only a lead or a booked visit can be
                            several things. */}
                        {i.kind !== "job" && (
                          <select
                            value={i.workKind ?? ""}
                            onChange={(e) => size(i, { workKind: e.target.value })}
                            disabled={pending}
                            className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs disabled:opacity-50"
                            aria-label="What kind of work"
                          >
                            {/* From the one list — see work-shape. An option that exists is an
                                option the validator accepts. */}
                            <option value="">Kind?</option>
                            {WORK_KINDS.map((k) => (
                              <option key={k} value={k}>{KIND_LABEL[k]}</option>
                            ))}
                          </select>
                        )}
                        <select
                          value={i.planned_minutes ? String(i.planned_minutes) : ""}
                          onChange={(e) => {
                            if (e.target.value === "custom") {
                              setCustomFor(i.id);
                              setCustomText("");
                              return;
                            }
                            setCustomFor(null);
                            size(i, { plannedMinutes: Number(e.target.value) || null });
                          }}
                          disabled={pending}
                          className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs disabled:opacity-50"
                          aria-label="How long will it take"
                        >
                          <option value="">How long?</option>
                          {/* A SIZE THAT ISN'T ON THE LIST STILL HAS TO SHOW. A select whose value
                              matches no option falls back to the first, so the card would read
                              "3h" in the badge and "How long?" in the control, about itself. */}
                          {!!i.planned_minutes && !SIZE_BUCKETS.includes(i.planned_minutes) && (
                            <option value={String(i.planned_minutes)}>
                              {durationLabel(i.planned_minutes)}
                            </option>
                          )}
                          <option value="30">30m</option>
                          <option value="60">1h</option>
                          <option value="120">2h</option>
                          <option value="240">Half day</option>
                          <option value="480">Full day</option>
                          <option value="960">2 days</option>
                          <option value="1440">3 days</option>
                          {/* A WEEK IS FIVE WORKING DAYS — Erik: "lets make that the 5 working days by default".
                              Said out loud on the option so it never has to be inferred. */}
                          <option value="2400">A week (5 days)</option>
                          {/* NO CEILING. A service call is 45 minutes and a panel swap is 6 hours;
                              rounding either to the nearest bucket puts a number on the calendar
                              that nobody chose. */}
                          <option value="custom">Custom…</option>
                        </select>

                        {customFor === i.id && (
                          <>
                            {/* TYPE IT THE WAY YOU'D SAY IT — "45m", "1.5h", "3 hrs", "2d", or bare
                                minutes. parseDuration reads all of those and returns null rather
                                than a guess for anything else, so an unreadable entry leaves the
                                old value alone and says so. */}
                            <input
                              autoFocus
                              value={customText}
                              onChange={(e) => setCustomText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); saveCustom(i); }
                                if (e.key === "Escape") { setCustomFor(null); setCustomText(""); }
                              }}
                              placeholder="45m, 1.5h, 2d"
                              aria-label="Type how long it will take"
                              className="h-7 w-24 rounded-md border border-brand/60 px-1.5 text-xs"
                            />
                            <button
                              type="button"
                              onClick={() => saveCustom(i)}
                              className="h-7 rounded-md bg-brand px-2 text-xs font-semibold text-white"
                            >
                              Set
                            </button>
                            {/* Says what it read BEFORE he commits — never a silent round. */}
                            <span className="text-xs text-slate-400">
                              {customText.trim()
                                ? parseDuration(customText)
                                  ? durationLabel(parseDuration(customText))
                                  : "can't read that"
                                : ""}
                            </span>
                          </>
                        )}
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
