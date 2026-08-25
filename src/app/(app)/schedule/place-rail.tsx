"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, MapPin, Phone, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { scheduleLeadsOnDay } from "../leads/actions";
import {
  groupByTown,
  nextAction,
  whatsMissing,
  type Placeable,
} from "@/lib/schedule/place-by-town";

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
export function PlaceRail({ items, onPickDay }: { items: Placeable[]; onPickDay?: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [day, setDay] = useState("");

  const groups = useMemo(() => groupByTown(items), [items]);
  const chosen = useMemo(
    () => items.filter((i) => picked.has(i.id)),
    [items, picked],
  );
  // Only LEADS can be booked as walk-throughs by this action; a dateless job needs a date set on
  // the job itself, which is a different write. Say so rather than silently ignoring them.
  const leads = chosen.filter((i) => i.kind === "lead");
  const jobs = chosen.filter((i) => i.kind === "job");

  function toggle(id: string) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function place() {
    if (!day || !leads.length) return;
    start(async () => {
      const res = await scheduleLeadsOnDay(leads.map((l) => l.id), day);
      if (!res.ok) {
        toast(res.error ?? "Couldn't book those.", "error");
        return;
      }
      // ANNOUNCE THE DEED, and name any that didn't land — a batch that says "done" while one of
      // four silently failed is how somebody stops trusting the button.
      toast(
        res.failures.length
          ? `Booked ${res.booked}. ${res.failures.length} didn't — open them and try again.`
          : `Booked ${res.booked} ${res.booked === 1 ? "visit" : "visits"} for ${day}.`,
        res.failures.length ? "info" : "success",
      );
      setPicked(new Set());
      setDay("");
      onPickDay?.();
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
                  <button
                    type="button"
                    onClick={() => toggle(i.id)}
                    aria-pressed={on}
                    className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                      on ? "border-brand bg-brand-light/40" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        on ? "border-brand bg-brand text-white" : "border-slate-300"
                      }`}
                    >
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="text-sm font-medium text-slate-900">{i.name}</span>
                        {i.kind === "job" && <Badge tone="slate">job</Badge>}
                        {i.urgent && <Badge tone="red">overdue</Badge>}
                      </span>
                      {i.address && (
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                          <MapPin className="h-3 w-3 shrink-0" /> {i.address}
                        </span>
                      )}
                      {/* THE GAP, QUIET UNTIL IT IS IN THE WAY.
                          Erik: "all the red letters everywhere take all the clarity out of the
                          whole page … maybe we dont need what we dont need until we need it."
                          Nine of his twelve leads have no phone — so on his data the amber
                          sentence fired on nearly every card, and a warning on almost everything
                          is wallpaper, not a signal. It also had it backwards: the COMMON state
                          was loud and the rare one was quiet.
                          Now the gap is a small grey note, and it only speaks up in full when the
                          card is PICKED — the moment you are about to act, which is the moment
                          the missing piece actually stands in your way. */}
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
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/* THE SECOND TAP. Appears only once something is picked, so it is never chrome in the way. */}
      {chosen.length > 0 && (
        <div className="sticky bottom-0 space-y-2 rounded-xl border border-brand/30 bg-white/95 p-3 shadow-lg backdrop-blur">
          <div className="text-sm font-medium text-slate-900">
            {chosen.length} picked
            {jobs.length > 0 && (
              <span className="ml-1 font-normal text-slate-500">
                ({jobs.length} {jobs.length === 1 ? "is a job" : "are jobs"} — set their dates on the job itself)
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 px-2 text-sm"
              aria-label="Day to place them on"
            />
            <Button size="sm" onClick={place} disabled={pending || !day || !leads.length}>
              <CalendarPlus className="h-4 w-4" />
              {pending ? "Booking…" : `Put ${leads.length} on this day`}
            </Button>
            <button
              type="button"
              onClick={() => setPicked(new Set())}
              className="text-xs font-medium text-slate-500 hover:text-slate-800"
            >
              Clear
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Walk-throughs, 90 minutes apart from 9am, in the order shown.
          </p>
        </div>
      )}
    </div>
  );
}
