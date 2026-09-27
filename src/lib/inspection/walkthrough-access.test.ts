import { describe, it, expect } from "vitest";
import { answersWithoutPrices, isMissingRpc, keepStoredPhotos, walkthroughAccess } from "./walkthrough-access";

/**
 * "crew leader yes tech no" (Erik, 2026-09-26), as the page decides it. The database decides it again
 * (save_walkthrough_capture, 0356; its DB suite is walkthrough-crew-lead.integration.test.ts).
 */
describe("who fills in the walk-through", () => {
  const base = { isStaff: false, crewLead: false, onThisVisit: false, rpcReady: true };

  it("the office, always, whatever else is true", () => {
    expect(walkthroughAccess({ ...base, isStaff: true })).toBe("office");
    expect(walkthroughAccess({ ...base, isStaff: true, rpcReady: false })).toBe("office");
  });

  it("a crew lead on this visit, once the database has the door", () => {
    expect(walkthroughAccess({ ...base, crewLead: true, onThisVisit: true })).toBe("crewLead");
  });

  it("everyone else reads: a plain tech, a crew lead on someone else's visit, a crew lead before 0356", () => {
    expect(walkthroughAccess({ ...base, onThisVisit: true })).toBe("view");
    expect(walkthroughAccess({ ...base, crewLead: true })).toBe("view");
    expect(walkthroughAccess({ ...base, crewLead: true, onThisVisit: true, rpcReady: false })).toBe("view");
  });

  it("the missing function reads as missing, from PostgREST or Postgres; a refusal does not", () => {
    expect(isMissingRpc({ code: "PGRST202" })).toBe(true);
    expect(isMissingRpc({ code: "42883" })).toBe(true);
    expect(isMissingRpc({ code: "42501" })).toBe(false);
    expect(isMissingRpc(null)).toBe(false);
  });
});

describe("the answers a crew lead's page carries have no price in them", () => {
  it("drops `price` from a scope pick list and keeps what was picked and how many", () => {
    const stored = {
      work: "Remodel",
      scope: [
        { code: "R1", qty: 2, price: 500 },
        { code: "R2", qty: 1, price: 0 },
      ],
      rooms: ["Kitchen", "Bath"],
      count: 3,
      done: true,
      obj: { price: 9, note: "x" },
      none: null,
    };
    const out = answersWithoutPrices(stored);
    expect(out).toEqual({
      work: "Remodel",
      scope: [
        { code: "R1", qty: 2 },
        { code: "R2", qty: 1 },
      ],
      rooms: ["Kitchen", "Bath"],
      count: 3,
      done: true,
      obj: { note: "x" },
      none: null,
    });
    expect(JSON.stringify(out)).not.toMatch(/price|500/);
    // The stored answers are not touched: the office's page reads the same object.
    expect(stored.scope[0].price).toBe(500);
  });

  it("is safe on nothing", () => {
    expect(answersWithoutPrices(null)).toEqual({});
    expect(answersWithoutPrices(undefined)).toEqual({});
  });
});

describe("a crew lead adds photos and never takes one off", () => {
  it("keeps every stored photo, in place, and appends the new ones", () => {
    expect(keepStoredPhotos(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    // His page dropped one (or never had the office's newest): it is kept.
    expect(keepStoredPhotos(["a", "b", "office-new"], ["a", "c"])).toEqual(["a", "b", "office-new", "c"]);
    expect(keepStoredPhotos([], ["x"])).toEqual(["x"]);
  });
});
