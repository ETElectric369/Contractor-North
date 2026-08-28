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
 * ── AND WHAT A MISSING TOWN IS NOT ─────────────────────────────────────────────────────────
 *
 * The first version sorted a townless lead LAST. Erik: "just becuase it doesnt have a town doesnt
 * mean it goes at the end of the list, wrong logic, fragment first."
 *
 * He is right and it was a real violation. Mike Scrivano has no address — and a phone, an email,
 * and "I have another job I'll need a quote on … 3 cans in a walkway". He is one of the most
 * actionable leads in the pile: you can call him RIGHT NOW, and the address comes out of the call.
 * Demoting him for a blank field is the app demanding data before it will treat him seriously,
 * which is the exact thing fragment-first exists to forbid.
 *
 * So position is decided by the SAME rule for everyone — cluster size — and what a lead is missing
 * becomes a NEXT ACTION rather than a penalty. A lead is never "not plannable"; it has a next
 * thing, and what is absent decides which:
 *
 *     has a place, no way to reach them  → you cannot call, but you can go and look (9 of his 12)
 *     has contact, no place              → call them; the address arrives with the call (Mike)
 *     has both                           → put it on a day
 */

export type Placeable = {
  id: string;
  /**
   * A lead needs a walk-through; a job is work already sold and waiting for a date; an appointment
   * is a visit already agreed that nobody has put on a day. All three want the same thing — a day —
   * which is why one rail holds them: Erik doesn't think of them as three piles.
   *
   * They are three kinds and not one because they are three different WRITES. Calling an
   * appointment a lead (which this did) sent its id through convertInquiry, which went looking for
   * an inquiry that was never there.
   */
  kind: "lead" | "job" | "appointment";
  name: string;
  address: string | null;
  city: string | null;
  /** Follow-up overdue, or the office flagged it. Moves it up WITHIN its town, never between. */
  urgent?: boolean;
  note?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Expected effort (0229). Null = nobody has sized it, which renders "—" and never "0h". */
  planned_minutes?: number | null;
  /** Parked (jobs.status = 'on_hold'). It may still carry a stale date; placing it takes it off
   *  hold, because giving something a day is the opposite of parking it. */
  onHold?: boolean;
  /** appointments.type, when this item IS one — drives the Walk-through / Service call / Office tag. */
  type?: string | null;
  /** A LEAD's own work_kind (0230), chosen on the lead where the caller already knew. Preferred
   *  over any inference: what he told the app beats what the app worked out. */
  workKind?: string | null;
};

export type TownGroup = {
  town: string;
  items: Placeable[];
  /** True for the "no town yet" bucket — the UI should say why it can't be routed. */
  unlocatable: boolean;
};

/** The bucket for anything with no town yet. Named, not hidden, and NOT demoted. */
export const NO_TOWN = "No town yet";

/** What this item still needs before it can be put on a day — the next action, not a penalty. */
export type Missing = "nothing" | "place" | "contact" | "both";

export function whatsMissing(
  i: Pick<Placeable, "city" | "address" | "phone" | "email"> & { kind?: Placeable["kind"] },
): Missing {
  const has = (v: unknown) => String(v ?? "").trim() !== "";
  const place = has(i.city) || has(i.address);
  // A JOB HAS NO PHONE, AND THAT IS NOT A GAP. Work already sold is waiting for a DATE; telling
  // the office a job has "no phone or email" is answering a question nobody asked, and it was
  // firing on J-012 — a job with a complete address. Its only gap can be a place. An appointment
  // is the same: the conversation that created it already happened.
  if (i.kind === "job" || i.kind === "appointment") return place ? "nothing" : "place";
  const contact = has(i.phone) || has(i.email);
  if (place && contact) return "nothing";
  if (!place && !contact) return "both";
  return place ? "contact" : "place";
}

/** The next thing a person would actually do, in their words. */
export function nextAction(m: Missing): string {
  return m === "nothing"
    ? "Ready to schedule"
    : m === "place"
      ? "Call to get the address"
      : m === "contact"
        ? "No phone or email — go and look, or find a number"
        : "Needs an address and a number";
}

const norm = (s: string | null | undefined): string => String(s ?? "").trim().replace(/\s+/g, " ");

/**
 * THE TOWN IS OFTEN IN THE ADDRESS, and refusing to look there is the app demanding a tidy field.
 *
 * Erik, reading the rail: "look closer they should all have an address except Scrivano … 10244
 * Schaffer is certainly a real place." He was right. J-012 carries
 * "10244 Schaffer Dr, Truckee, CA 96161, USA" in `address` with `city` EMPTY — a whole Google
 * formatted address in one column, which is exactly what the places autocomplete returns. Reading
 * only `city` put a Truckee job in "No town yet" while the word Truckee sat right there.
 *
 * Fragment-first again: use what IS there rather than insisting on the shape you wanted. The
 * standard formatted address is "street, city, ST zip, country", so the second comma-part is the
 * town. A one-part address yields nothing and that is correct — a bare street genuinely has no
 * town in it, and guessing would be worse than an honest blank.
 */
export function townFromAddress(address: string | null | undefined): string {
  const parts = String(address ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  const candidate = parts[1];
  // "CA 96161" or "USA" is not a town — a town has no digits and isn't a bare 2-letter code.
  if (/\d/.test(candidate) || /^[A-Z]{2}$/.test(candidate)) return "";
  return candidate;
}

/** The town for grouping: the structured column when it exists, otherwise dug out of the address. */
export const townOf = (i: { city?: string | null; address?: string | null }): string =>
  norm(i.city) || townFromAddress(i.address);
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
    const found = townOf(it);
    const k = key(found) || NO_TOWN.toLowerCase();
    const town = found || NO_TOWN;
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

  // ONE RULE FOR EVERY GROUP — size, then name. The townless bucket is NOT forced anywhere: it
  // takes its place by the same measure as Truckee, and says what it needs instead of being
  // punished for it. (See the fragment-first note above; forcing it last was the bug.)
  return groups.sort((a, z) => z.items.length - a.items.length || a.town.localeCompare(z.town));
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
export function townsOnDay(dayItems: { city: string | null; address?: string | null }[]): string[] {
  const seen = new Map<string, string>();
  for (const d of dayItems) {
    const t = townOf(d);
    const k = key(t);
    if (k && !seen.has(k)) seen.set(k, t);
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
