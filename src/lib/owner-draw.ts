/**
 * HOW THE OWNER'S MONEY IS SPOKEN ABOUT, IN ONE PLACE (migration 0286).
 *
 * Erik, 2026-09-23: "get rid of the owners wages and make everything not a cost part of the owners
 * draw". The owner is paid by owner's draw, so several screens now say something about HIS hours
 * and HIS money: the job's Costs tab ("Your Hours"), /analytics ("Left For You"), the Pay board ("You
 * are paid by owner's draw..."). Each one has two readers, the owner and his office, and the
 * sentence has to be in the register of whoever is reading it: Erik reads "you", Alexa reads
 * "Erik". Written once here so the three screens cannot drift into three different phrasings of the
 * same fact, which is the pattern payroll-view.tsx's ownerIsViewer started.
 *
 * Pure: no I/O, no React. Techs never reach any of these screens (they are staff-only), so there is
 * no third register.
 */

export type OwnerRef = { id: string; name: string | null | undefined };

/** "Erik" out of "Erik Taylor"; "the owner" when there is no name to say. */
export function ownerFirstName(name: string | null | undefined): string {
  const first = String(name ?? "").trim().split(/\s+/)[0];
  return first || "the owner";
}

export type OwnerRegister = {
  /** True when the one owner in question is the person reading. */
  viewerIsOwner: boolean;
  /** How many distinct owners are in question. */
  count: number;
  /** "Your Hours" / "Erik's Hours" / "Owners' Hours". A label, so Title Case. */
  hoursLabel: string;
  /** "per hour you worked" / "per hour Erik worked" / "per hour the owners worked". */
  perHourPhrase: string;
  /** "about $X for each hour you worked" uses this: "you" / "Erik" / "the owners". */
  who: string;
  /** "Owner's Draw": the Analytics card's heading and the chart's series, the same words for every
   *  viewer (Erik, 2026-09-24: "instead of 'Left for you' lets call it 'Owner's Draw'"). */
  leftFor: string;
  /** The Pay board's one quiet sentence about why the owner is not on it. */
  notOnPayBoard: string;
};

/**
 * The register for a set of owners and a viewer. Duplicates (the same owner listed twice, e.g. once
 * per shift) collapse by id. One owner who is the viewer speaks as "you"; one owner who is not
 * speaks by first name; two or more speak as "the owners" whoever is reading.
 */
export function ownerRegister(owners: OwnerRef[], viewerId: string | null | undefined): OwnerRegister {
  const byId = new Map<string, OwnerRef>();
  for (const o of owners ?? []) if (o?.id && !byId.has(String(o.id))) byId.set(String(o.id), o);
  const list = [...byId.values()];
  if (list.length >= 2) {
    return {
      viewerIsOwner: false,
      count: list.length,
      hoursLabel: "Owners' Hours",
      perHourPhrase: "per hour the owners worked",
      who: "the owners",
      leftFor: "Owner's Draw",
      notOnPayBoard: "The owners are paid by owner's draw, so their hours are not on this board.",
    };
  }
  const one = list[0];
  if (one && viewerId && String(one.id) === String(viewerId)) {
    return {
      viewerIsOwner: true,
      count: 1,
      hoursLabel: "Your Hours",
      perHourPhrase: "per hour you worked",
      who: "you",
      leftFor: "Owner's Draw",
      notOnPayBoard: "You are paid by owner's draw, so your hours are not on this board.",
    };
  }
  const first = ownerFirstName(one?.name);
  const named = first !== "the owner";
  return {
    viewerIsOwner: false,
    count: list.length,
    hoursLabel: named ? `${first}'s Hours` : "Owner's Hours",
    perHourPhrase: `per hour ${first} worked`,
    who: first,
    leftFor: "Owner's Draw",
    notOnPayBoard: named
      ? `${first} is paid by owner's draw, so ${first}'s hours are not on this board.`
      : "The owner is paid by owner's draw, so the owner's hours are not on this board.",
  };
}
