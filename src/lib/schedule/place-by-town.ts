/**
 * WHAT IS UNPLACED, AND WHERE IS IT.
 *
 * Erik's bug report, filed while entering his real lead list: "how do I put these on the schedule
 * is the big denny, im looking for something (a process for CN) and I don't know what."
 *
 * He has 32 open leads, 27 with addresses, and zero future appointments. The path from a lead to
 * the calendar exists (2 taps), but nothing anywhere puts "the leads" and "the calendar" in the
 * same view — so he scans one, then the other, and bridges it in his head. And the calendar's
 * "To schedule" tray holds only dateless JOBS; a lead has never been in it.
 *
 * ── THE RULE THIS ENCODES ──────────────────────────────────────────────────────────────────
 *
 * Asked what decides which lead he visits first, he said "geography and urgency". Those are not
 * two competing sorts — they answer different questions, and the order matters:
 *
 *     GEOGRAPHY PICKS THE DAY.    Five Truckee addresses is a Tuesday. One in Graeagle is most of
 *                                 a day on its own. So towns are the groups, biggest first: the
 *                                 largest cluster is the easiest day to fill.
 *     URGENCY PICKS THE ORDER.    Within Truckee, the overdue one goes first. It does not earn a
 *                                 separate trip unless he says so.
 *
 * A lead with no town sorts LAST regardless of how urgent it is — not a demotion, a fact: you
 * cannot put it in a run when you don't know where it is. Naming that bucket honestly ("No town
 * yet") is what makes it fixable rather than invisible.
 */

export type Placeable = {
  id: string;
  /** A lead needs a walk-through; a job is work already sold and waiting for a date. Both want a
   *  day, which is why one rail holds them — Erik doesn't think of them as two piles. */
  kind: "lead" | "job";
  name: string;
  address: string | null;
  city: string | null;
  /** Follow-up overdue, or the office flagged it. Moves it up WITHIN its town, never between. */
  urgent?: boolean;
  note?: string | null;
};

export type TownGroup = {
  town: string;
  items: Placeable[];
  /** True for the "no town yet" bucket — the UI should say why it can't be routed. */
  unlocatable: boolean;
};

/** The bucket for anything we can't put on a map. Named, not hidden. */
export const NO_TOWN = "No town yet";

const norm = (s: string | null | undefined): string => String(s ?? "").trim().replace(/\s+/g, " ");
/** Truckee, TRUCKEE and " truckee " are one place. */
const key = (s: string | null | undefined): string => norm(s).toLowerCase();

/**
 * Group by town, biggest cluster first, urgent first inside each.
 *
 * Ties break alphabetically so the rail doesn't reshuffle between renders — a list that reorders
 * under your thumb is worse than one sorted slightly wrong.
 */
export function groupByTown(items: Placeable[]): TownGroup[] {
  const buckets = new Map<string, { town: string; items: Placeable[] }>();
  for (const it of items) {
    const k = key(it.city) || NO_TOWN.toLowerCase();
    const town = key(it.city) ? norm(it.city) : NO_TOWN;
    const b = buckets.get(k) ?? { town, items: [] };
    b.items.push(it);
    buckets.set(k, b);
  }

  const groups: TownGroup[] = [...buckets.values()].map((b) => ({
    town: b.town,
    unlocatable: b.town === NO_TOWN,
    items: [...b.items].sort(
      (a, z) => Number(!!z.urgent) - Number(!!a.urgent) || a.name.localeCompare(z.name),
    ),
  }));

  return groups.sort((a, z) => {
    // The unlocatable bucket is always last — it is not a place you can drive to.
    if (a.unlocatable !== z.unlocatable) return a.unlocatable ? 1 : -1;
    return z.items.length - a.items.length || a.town.localeCompare(z.town);
  });
}

/**
 * Which towns already have work on a given day?
 *
 * This is the ride-along signal, and it is deliberately a LABEL rather than a capacity model.
 * Erik: "if a walk through makes more sense to wait until thursday and do that job nearby that
 * day then that one gets filtered". Seeing "Thursday · Tahoe City" next to a rail that says
 * "Tahoe City (4)" answers that question without the app needing to know how long anything takes
 * — which is knowledge it does not have and would have to invent.
 */
export function townsOnDay(dayItems: { city: string | null }[]): string[] {
  const seen = new Map<string, string>();
  for (const d of dayItems) {
    const k = key(d.city);
    if (k && !seen.has(k)) seen.set(k, norm(d.city));
  }
  return [...seen.values()].sort((a, z) => a.localeCompare(z));
}

/**
 * Sequential times for several visits on one day.
 *
 * Erik: "i want to be able to schedule them together". Four walk-throughs on Tuesday are four
 * appointments, not one — a customer expects "Tuesday around 10", and one blob at 9am would put
 * every visit at the same instant and tell nobody anything.
 *
 * The order handed in is the order driven, so the caller's sort (town, then urgency) survives
 * into the day itself.
 */
export function spreadTimes(count: number, startHHMM = "09:00", stepMinutes = 90): string[] {
  const [h0, m0] = startHHMM.split(":").map((n) => Number(n) || 0);
  const out: string[] = [];
  for (let i = 0; i < Math.max(0, count); i++) {
    const total = h0 * 60 + m0 + i * stepMinutes;
    // Never roll past the end of the working day into tomorrow — a visit at 02:00 is a bug
    // wearing a timestamp. Clamp and let the caller see they overfilled the day.
    const clamped = Math.min(total, 23 * 60 + 30);
    out.push(`${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`);
  }
  return out;
}
