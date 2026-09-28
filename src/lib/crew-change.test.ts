import { describe, it, expect } from "vitest";
import { applyCrewChange } from "./crew-change";

/**
 * The job page's crew chips send one change, applied to the crew as the server has it now, so a page
 * that has gone stale can never take off someone another person put on in the meantime.
 */
describe("applyCrewChange", () => {
  it("adding Mike keeps Brian, whom the page never saw (a foreman put him on from the time clock)", () => {
    // The page loaded [erik]; the server now has [erik, brian]; the office adds mike.
    expect(applyCrewChange(["erik", "brian"], { add: "mike" })).toEqual(["erik", "brian", "mike"]);
  });

  it("taking Erik off keeps everyone else, in order", () => {
    expect(applyCrewChange(["erik", "brian", "mike"], { remove: "erik" })).toEqual(["brian", "mike"]);
  });

  it("adding someone already on the job lists them once", () => {
    expect(applyCrewChange(["erik", "brian"], { add: "brian" })).toEqual(["erik", "brian"]);
  });

  it("taking off someone already gone changes nothing", () => {
    expect(applyCrewChange(["erik"], { remove: "brian" })).toEqual(["erik"]);
  });

  it("no crew yet", () => {
    expect(applyCrewChange(null, { add: "erik" })).toEqual(["erik"]);
    expect(applyCrewChange(undefined, { remove: "erik" })).toEqual([]);
  });

  it("drops blanks and duplicates already in the stored list", () => {
    expect(applyCrewChange(["erik", "", "erik", "brian"], {})).toEqual(["erik", "brian"]);
  });
});
