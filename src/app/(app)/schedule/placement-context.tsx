"use client";

import { createContext, useCallback, useContext, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { scheduleLeadsOnDay } from "../leads/actions";
import { placeAppointmentOnDay, placeJobOnDay } from "./actions";
import { groupByTown, spreadTimes, type Placeable } from "@/lib/schedule/place-by-town";
import { dayLabelFrom, placeMessage } from "@/lib/schedule/placement-plan";

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
  placeOn: () => {},
  pending: false,
};

const Ctx = createContext<PlacementValue>(INERT);

export const usePlacement = (): PlacementValue => useContext(Ctx);

export function PlacementProvider({
  items,
  todayISO,
  children,
}: {
  items: Placeable[];
  /** The org's today, computed on the server in the org's timezone — never from the browser. */
  todayISO: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [half, setHalf] = useState<"am" | "pm">("am");

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

      /* ONE CLOCK FOR THE WHOLE DAY, not one per kind. Leads were staggered 90 minutes apart by
         spreadTimes while every appointment got the same literal start — so two inspections and a
         lead all landed on 08:00, drawn as three slivers in one slot, with three customers each
         told "Thursday at 8". place-by-town says it plainly: "one blob at 9am would put every visit
         at the same instant and tell nobody anything." Appointments take the front of the sequence
         and the leads carry on from where they stop. */
      const visits = appts.length + leads.length;
      const times = spreadTimes(visits, half === "am" ? "08:00" : "13:00", 90);
      const startHHMM = times[0] ?? (half === "am" ? "08:00" : "13:00");

      start(async () => {
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
          jobs.map((j) => placeJobOnDay(j.id, dateISO, startHHMM).catch(() => ({ ok: false as const }))),
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
              // Carry on from where the appointments stopped, so nothing doubles up.
              { startTime: times[appts.length] ?? startHHMM },
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
    [chosen, half, pending, router, toast, todayISO],
  );

  const value = useMemo<PlacementValue>(
    () => ({ picked, toggle, clear, armedCount: chosen.length, half, setHalf, placeOn, pending }),
    [picked, toggle, clear, chosen.length, half, placeOn, pending],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
