import { describe, it, expect } from "vitest";
import { familyWasConverted, splitFamilies, splitNeighbors } from "./split-family";

// Jul 14's shape after 0289, on a date nobody worked: the first entry kept its id (11:30-16:30),
// the Herringbone hour is its own entry pointing back at it (16:30-17:30).
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
