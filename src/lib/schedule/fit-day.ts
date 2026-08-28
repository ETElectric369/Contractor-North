/**
 * WHERE DOES THE NEXT ONE ACTUALLY GO.
 *
 * Erik: "when im filling in the next job after nora i choose morning then it should fill in the gap
 * inbetween not put it at the same time."
 *
 * Placing always started the clock at 8am (or 1pm) and spread from there, as though the day were
 * empty. It never was. Nora is already on Tuesday at 8; adding the next job to Tuesday morning put
 * it at 8 too — two pills side by side, two customers told the same hour, and a day that looks half
 * full while being double-booked. Every visit he added made the picture less true.
 *
 * "Morning" is not a time. It is a REGION, and the honest reading of it is "the first place in the
 * morning this actually fits" — which is what a person means when they say it and what they would
 * work out for themselves in two seconds by looking at the day. The app has the day in front of it.
 *
 * ── WHAT COUNTS AS A GAP ───────────────────────────────────────────────────────────────────
 *
 * The first opening at or after the requested start that the item fits inside, walking forward. Not
 * the smallest gap that fits, not the tightest pack — the FIRST one, because he reads the day
 * top-down and expects the next thing to land at the next opening, not squeezed into a hole at
 * three o'clock he had forgotten about.
 *
 * An item with no size still has to go somewhere, so it is fitted at a nominal slot width. That
 * assumption never becomes data: nothing writes planned_minutes from it, and the card keeps saying
 * "—" because nobody has sized it. Blank is not zero here either.
 */

export type Busy = { startMin: number; endMin: number };

/** The width assumed for an unsized item while fitting — a walk-through's usual hour and a half. */
export const NOMINAL_SLOT = 90;

/** A call is made from wherever you are, so it never occupies the day's clock. See fitIntoDay. */
export const PINNED_TO_TOP = -1;

export function mergeBusy(busy: Busy[]): Busy[] {
  const sorted = [...busy]
    .filter((b) => Number.isFinite(b.startMin) && Number.isFinite(b.endMin) && b.endMin > b.startMin)
    .sort((a, z) => a.startMin - z.startMin);
  const out: Busy[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.startMin <= last.endMin) last.endMin = Math.max(last.endMin, b.endMin);
    else out.push({ ...b });
  }
  return out;
}

/**
 * Place each item at the first opening that fits, from `fromMin` onward.
 *
 * Items are placed IN ORDER and each one becomes busy for the next, so a batch never collides with
 * itself. A `null` duration means unsized and is fitted at NOMINAL_SLOT.
 *
 * `PINNED_TO_TOP` comes back for anything pinned — a phone call. It takes no room and pushes
 * nothing later.
 *
 * NEVER DROPS ONE. If nothing fits before the end of the day, the item goes after everything else
 * rather than vanishing: he asked for it to be on this day, and the app's job is to say where it
 * ended up, not to quietly decline. The caller can see it landed late and move it.
 */
export function fitIntoDay(
  busy: Busy[],
  items: { minutes: number | null; pinned?: boolean }[],
  opts: { fromMin: number; endOfDayMin?: number; gapMin?: number },
): number[] {
  const endOfDay = opts.endOfDayMin ?? 22 * 60;
  const gap = opts.gapMin ?? 0;
  let taken = mergeBusy(busy);
  const out: number[] = [];

  for (const item of items) {
    if (item.pinned) {
      out.push(PINNED_TO_TOP);
      continue;
    }
    const width = Math.max(15, Number(item.minutes ?? 0) > 0 ? Number(item.minutes) : NOMINAL_SLOT);
    let at = opts.fromMin;

    // Walk forward past anything overlapping, until the space ahead is wide enough.
    for (let guard = 0; guard < 200; guard++) {
      const clash = taken.find((b) => at < b.endMin && at + width > b.startMin);
      if (!clash) break;
      at = clash.endMin + gap;
    }

    // Past the end of the day means the day is full. Land it anyway — after everything, where he
    // can see it — rather than silently refusing a placement he asked for.
    if (at + width > endOfDay) {
      const lastEnd = taken.length ? taken[taken.length - 1].endMin : opts.fromMin;
      at = Math.max(at, lastEnd + gap);
    }

    out.push(at);
    taken = mergeBusy([...taken, { startMin: at, endMin: at + width }]);
  }
  return out;
}

/** "HH:MM" → minutes past midnight. Returns null for anything that isn't one. */
export function hmToMinutes(hm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes past midnight → "HH:MM", clamped inside the day so nothing rolls into tomorrow. */
export function minutesToHm(minutes: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * WHEN THE AFTERNOON STARTS, ACCORDING TO THIS COMPANY.
 *
 * Erik: "so my company settings are 9-5 not 8-4."
 *
 * He set his working day in Settings → Crew & time, and the placement code was carrying "08:00" and
 * "13:00" as literals — so "morning" meant an hour before he opens, and every job placed from the
 * rail landed at 8. A setting the app asks for and then ignores is worse than one it never asked
 * for: he told it, twice over, and watched it do something else.
 *
 * The afternoon is the midpoint of HIS day, rounded down to the hour so it reads as a time a person
 * would say. For 9–5 that is 1pm, which is the number that was hardcoded — right for him by luck,
 * wrong the moment the shop opens at 7 or runs to 6, and wrong for every other org on the app.
 */
export function halves(workStartHm: string, workEndHm: string): { am: string; pm: string } {
  const start = hmToMinutes(workStartHm) ?? 8 * 60;
  const end = hmToMinutes(workEndHm) ?? 17 * 60;
  if (end <= start) return { am: minutesToHm(start), pm: minutesToHm(start) };
  const mid = Math.floor((start + (end - start) / 2) / 60) * 60;
  return { am: minutesToHm(start), pm: minutesToHm(Math.max(start, mid)) };
}
