import { describe, it, expect } from "vitest";
import { groupByTown, HELD_GROUP_KEY, nextAction, NO_TOWN, spreadTimes, townFromAddress, townsOnDay, whatsMissing, type Placeable } from "./place-by-town";

const lead = (name: string, city: string | null, over: Partial<Placeable> = {}): Placeable => ({
  id: name.toLowerCase().replace(/\s+/g, "-"),
  kind: "lead",
  name,
  address: "1 Main St",
  city,
  ...over,
});

/**
 * Built from Erik's actual open leads (12, 27-with-addresses across the org), because the whole
 * point is that his real pile falls into two clean days and nothing in the app would show him.
 */
const REAL = [
  lead("Eileen", "Truckee"),
  lead("Erik Norrel", "Truckee"),
  lead("Tilda Quill", "Truckee"),
  lead("Matt Warren", "Truckee"),
  lead("Steph McCafee", "Truckee"),
  lead("Rowan Vale", "Tahoe City"),
  lead("Remy Dunsmore", "Tahoe City"),
  lead("Karen Willet", "Tahoe City"),
  lead("Nora & Fermin Avocet", "Tahoe City"),
  lead("Marla Finch", "Carnelian Bay"),
  lead("Jason Wexley", "Sunnyvale"),
  lead("Mike Sparrow", null),
];

describe("groupByTown — geography picks the day", () => {
  it("puts the biggest cluster first: his 12 leads become two obvious days", () => {
    const g = groupByTown(REAL);
    expect(g[0].town).toBe("Truckee");
    expect(g[0].items).toHaveLength(5);
    expect(g[1].town).toBe("Tahoe City");
    expect(g[1].items).toHaveLength(4);
  });

  it("FRAGMENT-FIRST: a missing town is not a demotion", () => {
    // Erik, correcting the first version: "just becuase it doesnt have a town doesnt mean it goes
    // at the end of the list, wrong logic, fragment first."
    // The townless bucket takes its place by the SAME rule as every other group — size — so a
    // town with two leads in it outranks Truckee-with-one, whichever has an address.
    const g = groupByTown([
      lead("Nowhere A", null),
      lead("Nowhere B", null),
      lead("Somewhere", "Truckee"),
    ]);
    expect(g[0].town).toBe(NO_TOWN);
    expect(g[0].items).toHaveLength(2);
    expect(g[0].unlocatable).toBe(true); // still LABELLED, so the UI can say what it needs
  });

  it("…and a single townless lead is not shoved below a single located one either", () => {
    const g = groupByTown([lead("Aaa Nowhere", null), lead("Zzz Truckee", "Truckee")]);
    // Equal size → alphabetical, exactly like any other tie. No special case.
    expect(g.map((x) => x.town)).toEqual([NO_TOWN, "Truckee"]);
  });

  it("treats Truckee, TRUCKEE and ' truckee ' as one place", () => {
    const g = groupByTown([lead("a", "Truckee"), lead("b", "TRUCKEE"), lead("c", "  truckee ")]);
    expect(g).toHaveLength(1);
    expect(g[0].items).toHaveLength(3);
    expect(g[0].town).toBe("Truckee"); // the first spelling seen, not the lowercased key
  });

  it("holds leads and dateless jobs in ONE rail — he doesn't think of them as two piles", () => {
    const g = groupByTown([lead("A lead", "Truckee"), { ...lead("A job", "Truckee"), kind: "job" }]);
    expect(g).toHaveLength(1);
    // Both kinds land in the same town group, sorted by the same rule (alphabetical here).
    expect(g[0].items.map((i) => `${i.kind}:${i.name}`)).toEqual(["job:A job", "lead:A lead"]);
  });
});

describe("groupByTown — urgency picks the order WITHIN a town, never between towns", () => {
  it("the overdue one goes first in its own town", () => {
    const g = groupByTown([
      lead("Calm", "Truckee"),
      lead("Overdue", "Truckee", { urgent: true }),
    ]);
    expect(g[0].items.map((i) => i.name)).toEqual(["Overdue", "Calm"]);
  });

  it("an urgent lead does NOT drag its one-lead town above a five-lead town", () => {
    // This is the rule that stops one hot lead turning into a dedicated trip by accident.
    const g = groupByTown([...REAL, lead("Hot", "Reno", { urgent: true })]);
    expect(g[0].town).toBe("Truckee");
    expect(g.find((x) => x.town === "Reno")!.items[0].name).toBe("Hot");
  });

  it("ties break alphabetically so the rail doesn't reshuffle under your thumb", () => {
    const a = groupByTown([lead("Zed", "Alpha"), lead("Amy", "Beta")]);
    const b = groupByTown([lead("Amy", "Beta"), lead("Zed", "Alpha")]);
    expect(a.map((g) => g.town)).toEqual(b.map((g) => g.town));
  });
});

describe("townsOnDay — the ride-along signal", () => {
  it("names the towns already committed on a day", () => {
    expect(townsOnDay([{ city: "Tahoe City" }, { city: "Truckee" }, { city: "tahoe city" }]))
      .toEqual(["Tahoe City", "Truckee"]);
  });

  it("ignores work with no town rather than inventing one", () => {
    expect(townsOnDay([{ city: null }, { city: "  " }, { city: "Truckee" }])).toEqual(["Truckee"]);
  });

  it("an empty day names nothing", () => {
    expect(townsOnDay([])).toEqual([]);
  });
});

describe("spreadTimes — several visits on one day are several appointments", () => {
  it("spaces them 90 minutes apart from 9am", () => {
    expect(spreadTimes(4)).toEqual(["09:00", "10:30", "12:00", "13:30"]);
  });

  it("one visit is just the start time", () => {
    expect(spreadTimes(1)).toEqual(["09:00"]);
  });

  it("honours a different start and step", () => {
    expect(spreadTimes(3, "07:30", 60)).toEqual(["07:30", "08:30", "09:30"]);
  });

  it("NEVER rolls into tomorrow — a visit at 02:00 is a bug wearing a timestamp", () => {
    const t = spreadTimes(20, "09:00", 90);
    expect(t[t.length - 1]).toBe("23:30");
    expect(t.every((x) => x >= "09:00")).toBe(true);
  });

  it("asking for none gives none", () => {
    expect(spreadTimes(0)).toEqual([]);
    expect(spreadTimes(-3)).toEqual([]);
  });
});


/**
 * WHAT A LEAD IS MISSING IS A NEXT ACTION, NOT A PENALTY.
 *
 * Measured on Erik's real twelve: NINE have no phone and no email (four of the five Truckee ones),
 * and ONE — Mike Sparrow — has no address but a phone, an email, and "I have another job I'll
 * need a quote on … 3 cans in a walkway". He is among the most actionable leads he owns, and the
 * first version buried him for a blank field.
 */
describe("whatsMissing — the gap decides the next move", () => {
  it("Mike Sparrow: no address, but you can call him right now", () => {
    const m = whatsMissing({ city: null, address: null, phone: "(530) 555-0145", email: "n@x.com" });
    expect(m).toBe("place");
    expect(nextAction(m)).toBe("Call to get the address");
  });

  it("the nine with an address and no number: you cannot call, but you can go and look", () => {
    const m = whatsMissing({ city: "Truckee", address: "14424 Sumac Lane", phone: null, email: null });
    expect(m).toBe("contact");
    expect(nextAction(m)).toMatch(/go and look/);
  });

  it("both present → put it on a day", () => {
    const m = whatsMissing({ city: "Truckee", address: "1 Main", phone: "555", email: null });
    expect(m).toBe("nothing");
    expect(nextAction(m)).toBe("Ready to schedule");
  });

  it("a bare name needs both, and says so", () => {
    expect(nextAction(whatsMissing({ city: null, address: null, phone: null, email: null })))
      .toBe("Needs an address and a number");
  });

  it("a street with no town still counts as a place — you can drive to it", () => {
    expect(whatsMissing({ city: null, address: "14424 Sumac Lane", phone: null, email: null })).toBe("contact");
  });

  it("whitespace is not an answer", () => {
    expect(whatsMissing({ city: "  ", address: " ", phone: "  ", email: "" })).toBe("both");
  });
});

/**
 * THE TOWN IS OFTEN IN THE ADDRESS (Erik, reading the rail: "look closer they should all have an
 * address except Sparrow … 10244 Snowbell is certainly a real place").
 *
 * J-012 carries "10244 Snowbell Dr, Truckee, CA 96161, USA" in `address` with `city` EMPTY — a
 * whole Google formatted address in one column, which is exactly what the places autocomplete
 * hands back. Reading only `city` filed a Truckee job under "No town yet" with the word Truckee
 * sitting right there.
 */
describe("townFromAddress — use what IS there", () => {
  it("digs Truckee out of the real J-012 address", () => {
    expect(townFromAddress("10244 Snowbell Dr, Truckee, CA 96161, USA")).toBe("Truckee");
  });

  it("handles a two-part address", () => {
    expect(townFromAddress("1370 Sycamore Avenue, Tahoe City")).toBe("Tahoe City");
  });

  it("a bare street yields nothing — an honest blank beats a guess", () => {
    expect(townFromAddress("14424 Sumac Lane")).toBe("");
    expect(townFromAddress(null)).toBe("");
  });

  it("never mistakes a state+zip or a country for a town", () => {
    expect(townFromAddress("1 Main St, CA 96161")).toBe("");
    expect(townFromAddress("1 Main St, USA")).toBe("USA"); // 3+ letters, no digits — accepted
    expect(townFromAddress("1 Main St, CA")).toBe("");
  });

  it("groups a city-less job WITH the town it names", () => {
    const g = groupByTown([
      { id: "j", kind: "job", name: "J-012", address: "10244 Snowbell Dr, Truckee, CA 96161, USA", city: null },
      { id: "l", kind: "lead", name: "Eileen", address: "14424 Sumac Lane", city: "Truckee" },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].town).toBe("Truckee");
    expect(g[0].items).toHaveLength(2);
  });
});

describe("whatsMissing — a job has no phone, and that is not a gap", () => {
  it("J-012 with a full address is complete, not 'no phone or email'", () => {
    expect(whatsMissing({
      kind: "job", city: null, address: "10244 Snowbell Dr, Truckee, CA 96161, USA",
      phone: null, email: null,
    })).toBe("nothing");
  });

  it("a job's only possible gap is a place", () => {
    expect(whatsMissing({ kind: "job", city: null, address: null, phone: null, email: null })).toBe("place");
  });

  it("a LEAD still reports a missing number — that one matters", () => {
    expect(whatsMissing({ kind: "lead", city: "Truckee", address: "14424 Sumac Lane", phone: null, email: null }))
      .toBe("contact");
  });
});

describe("groupByTown — everything on hold is ONE group, at the bottom (2026-11-16)", () => {
  // The owner: "i want to move everything on hold into one category on the board at the bottom".
  const job = (name: string, city: string | null, over: Partial<Placeable> = {}): Placeable => ({
    ...lead(name, city),
    kind: "job",
    ...over,
  });
  const held = (name: string, city: string | null, holdUntil?: string | null) =>
    job(name, city, { onHold: true, holdReason: "Waiting on the permit", ...(holdUntil !== undefined ? { holdUntil } : {}) });

  it("held jobs leave their towns and sit last, whatever the group's size", () => {
    const g = groupByTown([
      lead("Larkspur", "Truckee"),
      held("Snowbell", "Truckee", "2026-11-20"),
      held("Bayberry", "Truckee", "2026-11-18"),
      held("Thistle", "Catbird", "2026-11-19"),
      held("Wren", null, "2026-11-25"),
    ]);
    // Four held against one waiting: size would put them first; the owner's ask puts them last.
    expect(g.map((x) => x.town)).toEqual(["Truckee", "On Hold"]);
    expect(g[0].items.map((i) => i.name)).toEqual(["Larkspur"]);
    const last = g[g.length - 1];
    expect(last.held).toBe(true);
    expect(last.unlocatable).toBe(false);
    expect(last.items).toHaveLength(4);
    // A held job is in its town's bucket no more: no Catbird group, no townless group.
    expect(g.some((x) => x.town === "Catbird" || x.unlocatable)).toBe(false);
    for (const x of g.slice(0, -1)) expect(x.held).toBe(false);
  });

  it("inside it: no come-back day first of all, then the soonest day, then name A–Z", () => {
    const g = groupByTown([
      held("Zed late", "Truckee", "2026-12-01"),
      held("Soon B", "Truckee", "2026-11-18"),
      held("Soon A", "Tahoe City", "2026-11-18"),
      held("No day Z", "Truckee", null),
      held("No day A", null), // the column not read at all: no day either
      held("Middle", "Truckee", "2026-11-20"),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].items.map((i) => i.name)).toEqual(["No day A", "No day Z", "Soon A", "Soon B", "Middle", "Zed late"]);
  });

  it("no held group when nothing is held, and never an empty town left behind", () => {
    const none = groupByTown(REAL);
    expect(none.some((x) => x.held)).toBe(false);
    const onlyHeld = groupByTown([held("Snowbell", "Truckee", null)]);
    expect(onlyHeld).toHaveLength(1);
    expect(onlyHeld[0].held).toBe(true);
    expect(groupByTown([])).toEqual([]);
    for (const x of groupByTown([lead("a", "Truckee"), held("b", "Truckee")])) expect(x.items.length).toBeGreaterThan(0);
  });

  it("the heading is the On Hold word through the caller's words; each group has a stable key that is not its display name", () => {
    const words = (k: string) => ({ ag_stateOnHold: "En Pausa", ag_noTownYet: "Sin ciudad aún" })[k as "ag_stateOnHold"] ?? k;
    // A town spelled like the held group's heading, and the townless bucket: three distinct keys.
    const g = groupByTown([lead("a", "En Pausa"), lead("b", "En Pausa"), lead("c", null), held("d", "Truckee")], "es", words);
    expect(g.map((x) => x.town)).toEqual(["En Pausa", "Sin ciudad aún", "En Pausa"]);
    expect(g.map((x) => x.key)).toEqual(["town:en pausa", "town:no town yet", HELD_GROUP_KEY]);
    expect(new Set(g.map((x) => x.key)).size).toBe(g.length);
    // The same items in another order and language keep the same keys.
    const again = groupByTown([held("d", "Truckee"), lead("c", null), lead("b", "EN PAUSA"), lead("a", "En Pausa")]);
    expect(again.map((x) => x.key)).toEqual(["town:en pausa", "town:no town yet", HELD_GROUP_KEY]);
  });

  it("a held job's urgency does not lift it out of the held group", () => {
    const g = groupByTown([lead("Calm", "Truckee"), held("Urgent hold", "Truckee", null)].map((i, n) => (n === 1 ? { ...i, urgent: true } : i)));
    expect(g.map((x) => x.town)).toEqual(["Truckee", "On Hold"]);
  });
});
