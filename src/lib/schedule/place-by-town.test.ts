import { describe, it, expect } from "vitest";
import { groupByTown, NO_TOWN, spreadTimes, townsOnDay, type Placeable } from "./place-by-town";

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
  lead("Erik Nyborg", "Truckee"),
  lead("Macey Dade", "Truckee"),
  lead("Matt Warren", "Truckee"),
  lead("Steph McCafee", "Truckee"),
  lead("Braden Lang", "Tahoe City"),
  lead("Dino Dargenzio", "Tahoe City"),
  lead("Karen Wucher", "Tahoe City"),
  lead("Nora & Fermin Arnoso", "Tahoe City"),
  lead("Jackie Burks", "Carnelian Bay"),
  lead("Jason Waldow", "Sunnyvale"),
  lead("Mike Scrivano", null),
];

describe("groupByTown — geography picks the day", () => {
  it("puts the biggest cluster first: his 12 leads become two obvious days", () => {
    const g = groupByTown(REAL);
    expect(g[0].town).toBe("Truckee");
    expect(g[0].items).toHaveLength(5);
    expect(g[1].town).toBe("Tahoe City");
    expect(g[1].items).toHaveLength(4);
  });

  it("a lead with no town sorts LAST, however urgent — you can't route to it", () => {
    const g = groupByTown([lead("Nowhere", null, { urgent: true }), lead("Somewhere", "Truckee")]);
    expect(g[0].town).toBe("Truckee");
    expect(g[g.length - 1].town).toBe(NO_TOWN);
    expect(g[g.length - 1].unlocatable).toBe(true);
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
