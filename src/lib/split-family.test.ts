import { describe, it, expect } from "vitest";
import { familyWasConverted, splitFamilies, splitNeighbors } from "./split-family";

// Jul 14's shape after 0289, on a date nobody worked: the first entry kept its id (11:30-16:30),
// the Honeysuckle hour is its own entry pointing back at it (16:30-17:30).
const first = { id: "first", profile_id: "erik", clock_in: "2001-07-14T18:30:00Z", clock_out: "2001-07-14T23:30:00Z", split_from: null };
const last = { id: "last", profile_id: "erik", clock_in: "2001-07-14T23:30:00Z", clock_out: "2001-07-15T00:30:00Z", split_from: "first", split_how: "converted" };
const other = { id: "other", profile_id: "brian", clock_in: "2001-07-14T15:00:00Z", clock_out: "2001-07-14T23:00:00Z" };

describe("splitFamilies", () => {
  it("groups the first entry with every piece that points at it, and nothing else", () => {
    const fam = splitFamilies([first, last, other]);
    expect(fam.get("first")).toBe("first");
    expect(fam.get("last")).toBe("first");
    expect(fam.has("other")).toBe(false);
  });

  it("a lone first entry whose pieces are not in the read is not a family on its own", () => {
    expect(splitFamilies([first]).has("first")).toBe(false);
  });

  it("knows a family 0289 rebuilt", () => {
    expect(familyWasConverted([first, last], "first")).toBe(true);
    expect(familyWasConverted([first, { ...last, split_how: "after" }], "first")).toBe(false);
  });
});

describe("splitNeighbors", () => {
  it("finds the touching piece on each side", () => {
    expect(splitNeighbors([first, last, other], "first")).toEqual({ prev: null, next: last });
    expect(splitNeighbors([first, last, other], "last")).toEqual({ prev: first, next: null });
  });

  it("a three-part day has both sides for the middle piece", () => {
    const mid = { ...last, id: "mid", clock_out: "2001-07-15T00:00:00Z", split_how: "after" };
    const tail = { ...last, id: "tail", clock_in: "2001-07-15T00:00:00Z", split_how: "after" };
    const n = splitNeighbors([first, mid, tail], "mid");
    expect(n.prev?.id).toBe("first");
    expect(n.next?.id).toBe("tail");
  });

  it("never offers another person's shift, or a piece that does not touch", () => {
    const stranger = { ...last, id: "x", profile_id: "brian" };
    expect(splitNeighbors([first, stranger], "first").next).toBeNull();
    const gap = { ...last, clock_in: "2001-07-14T23:45:00Z" };
    expect(splitNeighbors([first, gap], "first").next).toBeNull();
  });

  it("an ordinary entry has no neighbors", () => {
    expect(splitNeighbors([other], "other")).toEqual({ prev: null, next: null });
  });
});

/**
 * AFTER THE FIRST PIECE IS DELETED (Erik, 2026-10-02: he split a shift, deleted one half, and could not
 * rejoin the other). A family is built from split_from pointers ALONE — touching clocks are never enough
 * — and split_from is `on delete set null`, so deleting the first entry nulls every survivor's pointer
 * at once. These two cases are the contract deleteTimeEntry's re-root relies on: without it the pieces
 * are strangers that happen to touch, with it they are one shift again.
 */
describe("the family after its first entry is deleted", () => {
  const mid = { id: "mid", profile_id: "erik", clock_in: "2001-07-14T23:30:00Z", clock_out: "2001-07-15T00:00:00Z", split_from: "first", split_how: "live" };
  const tail = { id: "tail", profile_id: "erik", clock_in: "2001-07-15T00:00:00Z", clock_out: "2001-07-15T00:30:00Z", split_from: "first", split_how: "live" };

  it("THE DEFECT: the survivors still touch, and are no family at all", () => {
    const orphans = [{ ...mid, split_from: null }, { ...tail, split_from: null }];
    expect(orphans[0].clock_out).toBe(orphans[1].clock_in); // they touch to the second
    expect(splitFamilies(orphans).size).toBe(0);
    // So no bracket on Timecards, no Move The Split, and no Join Back Into One Shift on either of them.
    expect(splitNeighbors(orphans, "mid")).toEqual({ prev: null, next: null });
    expect(splitNeighbors(orphans, "tail")).toEqual({ prev: null, next: null });
  });

  it("re-rooted on the earliest survivor, it is one shift again", () => {
    const rerooted = [{ ...mid, split_from: null }, { ...tail, split_from: "mid" }];
    expect(splitFamilies(rerooted).get("mid")).toBe("mid");
    expect(splitFamilies(rerooted).get("tail")).toBe("mid");
    expect(splitNeighbors(rerooted, "mid").next?.id).toBe("tail");
    expect(splitNeighbors(rerooted, "tail").prev?.id).toBe("mid");
  });
});
