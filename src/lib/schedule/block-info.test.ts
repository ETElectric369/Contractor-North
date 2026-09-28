import { describe, it, expect } from "vitest";
import { blockRows, crewChips, hmShort, initialsOf, nameSays, placeLine, spanShort, streetOf, townOf } from "./block-info";

/**
 * THE BLOCK SAYS WHERE AND WHO (Erik, 2026-09-28: "we definitly need the address showing up on the job
 * block with info too"). The words every block and agenda row reads from one place: the street number
 * and name (never the city or the zip), or WHO when the job's name already is the street (Erik's naming
 * rule, "street number and name as always"), the time short, and the crew as initials.
 */
describe("the place line", () => {
  it("a job named for the work: its street number and name, never the city or the zip", () => {
    expect(placeLine({ name: "Seiler · 3-way switches", street: "123 Main St", customer: "Rich Seiler" })).toEqual({ text: "123 Main St", kind: "street" });
    expect(placeLine({ name: "Seiler · 3-way switches", street: "123 Main St, Truckee, CA 96161", customer: "Rich Seiler" })).toEqual({ text: "123 Main St", kind: "street" });
  });

  it("a job named for its street (the new rule): who instead of the street twice", () => {
    expect(placeLine({ name: "498 Mil Drae Lane", street: "498 Mil Drae Lane", customer: "Jackie Burks" })).toEqual({ text: "Jackie Burks", kind: "customer" });
    // "Ln." and "Lane" are one street; a unit on the name is still the street.
    expect(placeLine({ name: "498 Mil Drae Ln.", street: "498 Mil Drae Lane", customer: "Jackie Burks" })?.kind).toBe("customer");
    expect(placeLine({ name: "300 West Lake Boulevard #56", street: "300 W Lake Blvd", customer: "TTP" })).toEqual({ text: "TTP", kind: "customer" });
  });

  it("no street: who, unless the name already says who; nothing to add is nothing", () => {
    expect(placeLine({ name: "Seiler · 3-way switches", street: null, customer: "Rich Seiler" })).toEqual({ text: "Rich Seiler", kind: "customer" });
    expect(placeLine({ name: "Jackie Burks · Panel Upgrade", street: "", customer: "Jackie Burks" })).toBeNull();
    expect(placeLine({ name: "New Job · Sep 28", street: null, customer: null })).toBeNull();
  });

  it("a visit: its street from the one-line location; a town-only line has no street", () => {
    expect(streetOf("12 Elm St, Testville, CA 96161")).toBe("12 Elm St");
    expect(streetOf("Testville, CA 96161")).toBe("");
    expect(streetOf("96161")).toBe("");
    expect(streetOf(null)).toBe("");
    expect(townOf("12 Elm St, Testville, CA 96161")).toBe("Testville");
    expect(townOf("12 Elm St, Unit 4, Testville, CA 96161")).toBe("Testville");
    expect(townOf("Testville, CA 96161")).toBe("Testville");
    expect(townOf("12 Elm St")).toBe("");
    expect(placeLine({ name: "Site inspection: Rita Moss", street: streetOf("12 Elm St, Testville, CA 96161"), customer: "Rita Moss" })).toEqual({
      text: "12 Elm St",
      kind: "street",
    });
  });

  it("says: case, punctuation and street words aside", () => {
    expect(nameSays("12 ELM STREET remodel", "12 Elm St.")).toBe(true);
    expect(nameSays("Seiler", "")).toBe(false);
  });
});

describe("the crew and the time, short", () => {
  it("initials chips in the crew's order, each carrying the whole name; someone not on the roster is Unnamed", () => {
    const team = [
      { id: "p-erik", full_name: "Erik Taylor" },
      { id: "p-brian", full_name: "Brian" },
    ];
    expect(crewChips(["p-brian", "p-erik", "p-erik", "", "p-gone"], team)).toEqual([
      { id: "p-brian", initials: "B", name: "Brian" },
      { id: "p-erik", initials: "ET", name: "Erik Taylor" },
      { id: "p-gone", initials: "U", name: "Unnamed" },
    ]);
    expect(crewChips(null, team)).toEqual([]);
    expect(initialsOf("  ")).toBe("?");
  });

  it("start to end as few letters as it reads", () => {
    expect(spanShort(600, 720)).toBe("10a–12p");
    expect(spanShort(570, 780)).toBe("9:30a–1p");
    expect(spanShort(720, 1440)).toBe("12p–12a");
    expect(hmShort(0)).toBe("12a");
  });
});

describe("a small block says less, in order: the name, the place, the crew, the time, the town", () => {
  const all = { place: true, crew: true, time: true, town: true };
  it("a half hour (24px) is its name; three quarters (36px) the name and the place", () => {
    expect(blockRows(24, all)).toEqual({ place: false, crew: false, time: false, town: false });
    expect(blockRows(36, all)).toEqual({ place: true, crew: false, time: false, town: false });
  });

  it("an hour (48px) is the name, the place and the crew; two hours (96px) everything", () => {
    expect(blockRows(48, all)).toEqual({ place: true, crew: true, time: false, town: false });
    expect(blockRows(96, all)).toEqual(all);
  });

  it("a line it doesn't have gives its room to the next", () => {
    expect(blockRows(36, { place: false, crew: true, time: true, town: false })).toEqual({ place: false, crew: true, time: false, town: false });
    expect(blockRows(48, { place: false, crew: false, time: true, town: true })).toEqual({ place: false, crew: false, time: true, town: true });
  });
});
