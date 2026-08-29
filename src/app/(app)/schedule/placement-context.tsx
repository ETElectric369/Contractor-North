"use client";

import { createContext, useCallback, useContext, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { scheduleLeadsOnDay } from "../leads/actions";
import { placeAppointmentOnDay, placeJobOnDay, planDayTimes } from "./actions";
import { groupByTown, spreadTimes, type Placeable } from "@/lib/schedule/place-by-town";
import { workKind } from "@/lib/schedule/work-shape";
import { dayLabelFrom, placeMessage } from "@/lib/schedule/placement-plan";
import { halves } from "@/lib/schedule/fit-day";

/**
 * WHAT IS PICKED, SHARED BY THE RAIL AND THE CALENDAR.
 *
 * The rail and the calendar are siblings on /schedule, and the whole gesture Erik asked for — tick
 * the work on the left, tap the day on the right — crosses between them. One of them had to hold
 * the picked set, or the second tap could never know what it was placing.
 *
 * It lives in a context rather than in the page because the page is a SERVER component: it can pass
 * data down, but it cannot hold a click. This provider is the smallest client shell that both sides
 * can reach, and it owns the WRITE too — so there is exactly one place that turns a day into
 * bookings, whichever surface the tap came from. Two copies of that logic is how the rail's button
 * and the calendar's day quietly start behaving differently.
 *
 * ── INERT WITHOUT A PROVIDER ───────────────────────────────────────────────────────────────
 *
 * The same CalendarView renders on /calendar, where no rail exists. The default value below is a
 * real, empty context — armed is 0, so a day tap keeps its old meaning and drills in. No provider,
 * no behaviour change, no crash.
 */

type PlacementValue = {
  /** Ids currently ticked in the rail. */
  picked: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
  /** How many are waiting for a day to be tapped. 0 = the calendar behaves normally. */
  armedCount: number;
  /** Morning or afternoon — chosen in the rail, applied by whichever surface commits. */
  half: "am" | "pm";
  setHalf: (h: "am" | "pm") => void;
  /** An exact "HH:MM" when he wants one. Empty = the half decides, from the org's working day. */
  startAt: string;
  setStartAt: (hm: string) => void;
  /** The org's own morning and afternoon starts — never hardcoded clock times. */
  halfTimes: { am: string; pm: string };
  /** The second tap. Books every picked lead and dates every picked floater onto this day. */
  placeOn: (dateISO: string) => void;
  pending: boolean;
};

const INERT: PlacementValue = {
  picked: new Set(),
  toggle: () => {},
  clear: () => {},
  armedCount: 0,
  half: "am",
  setHalf: () => {},
  startAt: "",
  setStartAt: () => {},
  halfTimes: { am: "08:00", pm: "13:00" },
  placeOn: () => {},
  pending: false,
};

const Ctx = createContext<PlacementValue>(INERT);

export const usePlacement = (): PlacementValue => useContext(Ctx);

export function PlacementProvider({
  items,
  todayISO,
  workDay,
  children,
}: {
  items: Placeable[];
  /** Settings → Crew & time, resolved on the server. */
  workDay: { start: string; end: string };
  /** The org's today, computed on the server in the org's timezone — never from the browser. */
  todayISO: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [half, setHalf] = useState<"am" | "pm">("am");
  /* AM/PM is the right DEFAULT — nobody planning a week knows the minute, and asking for one is
     asking for precision that doesn't exist yet. But it can't be a ceiling: a 7am start before the
     supply house opens, or a 10:30 the customer asked for, is a real thing he already knows and
     had nowhere to put. Empty means the half still decides. */
  const [startAt, setStartAt] = useState("");
  const halfTimes = useMemo(() => halves(workDay.start, workDay.end), [workDay.start, workDay.end]);

  const toggle = useCallback((id: string) => {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const clear = useCallback(() => setPicked(new Set()), []);

  /**
   * Only what is BOTH picked and still on the board. A stale id — something placed in another tab,
   * or a lead someone else converted — can't resurrect itself into a booking.
   *
   * IN THE ORDER SHOWN, which the footer promises out loud. The rail renders groupByTown (towns
   * biggest-first, urgent then alphabetical inside); raw `items` is leads-by-newest, then jobs,
   * then appointments. Times are handed out by POSITION, so reading the unsorted list meant the
   * most recently entered lead took 8am — which could be the Tahoe City one sitting last on his
   * screen, sending him Truckee → Tahoe City → Truckee. That routing is the exact thing the town
   * grouping exists to prevent, so the grouping has to survive all the way to the clock.
   */
  const chosen = useMemo(
    () => groupByTown(items).flatMap((g) => g.items).filter((i) => picked.has(i.id)),
    [items, picked],
  );

  const placeOn = useCallback(
    (dateISO: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || !chosen.length || pending) return;
      const leads = chosen.filter((i) => i.kind === "lead");
      const jobs = chosen.filter((i) => i.kind === "job");
      const appts = chosen.filter((i) => i.kind === "appointment");

      /* ONE CLOCK FOR THE WHOLE DAY, and it starts from what is ALREADY on the day.
         Appointments take the front of the sequence and the leads carry on from where they stop, so
         nothing doubles up with itself; planDayTimes then slides the whole run past whatever is
         already booked. A phone call is marked pinned — it goes to the top of the day and takes no
         room, so it never pushes a real visit later. */
      /* Jobs ride at the END of the fitted sequence: two floaters placed on one afternoon used
         to both get times[0] — the same-slot collision, re-created for jobs a version after it
         was fixed for visits. */
      const visits = [...appts, ...leads, ...jobs];
      const firstAt = /^\d{2}:\d{2}$/.test(startAt) ? startAt : half === "am" ? halfTimes.am : halfTimes.pm;

      start(async () => {
        const planned = await planDayTimes(
          dateISO,
          visits.map((v) => ({
            minutes: v.planned_minutes ?? null,
            pinned: workKind(v) === "call",
          })),
          firstAt,
        ).catch(() => ({ ok: false as const, times: [] as string[] }));

        // FALL BACK, NEVER FAIL. If the day couldn't be read, place at the old fixed spread rather
        // than refusing — a booking he asked for must not be lost to a lookup.
        const times = planned.ok && planned.times.length === visits.length
          ? planned.times
          : spreadTimes(visits.length, firstAt, 90);
        const startHHMM = times[0] ?? firstAt;
        // THREE KINDS, THREE WRITES, REPORTED SEPARATELY. A lead that fails to convert must not
        // take a floater's date down with it, and none of them share a table.
        //
        // Each call catches its own rejection. These fire from a phone in a truck — the app ships
        // an offline queue for exactly that — and a dropped request rejects rather than returning
        // ok:false, which would take the whole Promise.all down and skip every line below,
        // including the toast written to explain what happened.
        const jobResults = await Promise.all(
          // The half he chose, honoured. placeJobOnDay took no time at all, so a floater — which by
          // definition carries no prior time — fell through to the org's all-day window and landed
          // at 8am while both the rail and the armed strip said "afternoon".
          jobs.map((j, i) =>
            placeJobOnDay(j.id, dateISO, times[appts.length + leads.length + i] ?? startHHMM).catch(
              () => ({ ok: false as const }),
            ),
          ),
        );
        const jobsFailed = jobResults.filter((r) => !r.ok).length;

        const apptResults = await Promise.all(
          appts.map((a, i) =>
            placeAppointmentOnDay(a.id, dateISO, times[i] ?? startHHMM, a.planned_minutes).catch(
              () => ({ ok: false as const }),
            ),
          ),
        );
        const apptsFailed = apptResults.filter((r) => !r.ok).length;

        const res = leads.length
          ? await scheduleLeadsOnDay(
              leads.map((l) => l.id),
              dateISO,
              {
                startTime: times[appts.length] ?? startHHMM,
                // The fitter planned EVERY lead individually (sized gaps included) — hand the
                // whole plan over, or the booking re-spreads blind and overlaps itself.
                times: times.slice(appts.length, appts.length + leads.length),
              },
            ).catch(() => ({
              ok: false as const,
              error: "That didn't reach the server — check your connection and try again.",
              booked: 0,
              failures: [] as { id: string; error: string }[],
            }))
          : { ok: true as const, booked: 0, failures: [] as { id: string; error: string }[] };

        // A hard failure of the whole lead call is not "0 booked" — it is an error with a reason,
        // and the reason is more useful than a count.
        if (!res.ok && !jobs.length && !appts.length) {
          toast(res.error ?? "Couldn't book those.", "error");
          return;
        }

        const msg = placeMessage({
          leadsBooked: res.ok ? res.booked : 0,
          leadsFailed: res.ok ? res.failures.length : leads.length,
          // Floaters and already-agreed visits both land as "placed" — from where he is standing
          // they are the same deed, and splitting them in the toast would be the app explaining its
          // own table layout.
          jobsPlaced: jobs.length - jobsFailed + (appts.length - apptsFailed),
          jobsFailed: jobsFailed + apptsFailed,
          dayLabel: dayLabelFrom(dateISO, todayISO),
        });
        toast(msg.text, msg.tone);

        /* KEEP EXACTLY WHAT DIDN'T LAND — which is what the old comment claimed and the old code
           did not do. It kept the whole set on any partial failure, successes included, so the
           obvious retry on another day re-placed things that were already placed. The ids are
           right here: res.failures carries the leads, and the two result arrays are index-aligned
           with their inputs. */
        const failedIds = new Set<string>([
          ...(res.ok ? res.failures.map((f) => f.id) : leads.map((l) => l.id)),
          ...jobs.filter((_, i) => !jobResults[i]?.ok).map((j) => j.id),
          ...appts.filter((_, i) => !apptResults[i]?.ok).map((a) => a.id),
        ]);
        setPicked(failedIds);
        router.refresh();
      });
    },
    [chosen, half, startAt, halfTimes, pending, router, toast, todayISO],
  );

  const value = useMemo<PlacementValue>(
    () => ({ picked, toggle, clear, armedCount: chosen.length, half, setHalf, startAt, setStartAt, halfTimes, placeOn, pending }),
    [picked, toggle, clear, chosen.length, half, startAt, halfTimes, placeOn, pending],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
