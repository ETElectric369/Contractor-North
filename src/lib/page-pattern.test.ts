import { describe, it, expect } from "vitest";
import { pagePattern } from "@/lib/page-pattern";

/** The page-open counter (0353) never sends an id, a name or a search: only the route's shape. */
describe("pagePattern", () => {
  it("takes the ids out of a route", () => {
    expect(pagePattern("/jobs/6f1c2d3e-aaaa-bbbb-cccc-1234567890ab")).toBe("/jobs/[id]");
    expect(pagePattern("/customers/42/edit")).toBe("/customers/[id]/edit");
    expect(pagePattern("/i/abcdefghijklmnopqrstuvwxyzabc")).toBe("/i/[id]");
    expect(pagePattern("/quotes/new")).toBe("/quotes/new");
    expect(pagePattern("/")).toBe("/");
    expect(pagePattern("/Planner")).toBe("/planner");
  });

  it("keeps only the ?tab= of the query, lower-cased", () => {
    expect(pagePattern("/jobs/abc123", "Costs")).toBe("/jobs/[id]?tab=costs");
    expect(pagePattern("/settings", "features")).toBe("/settings?tab=features");
    expect(pagePattern("/settings", "a b")).toBe("/settings");
    expect(pagePattern("/settings", null)).toBe("/settings");
  });

  it("sends nothing for what isn't a plain app path", () => {
    expect(pagePattern(null)).toBeNull();
    expect(pagePattern("")).toBeNull();
    expect(pagePattern("jobs")).toBeNull();
    expect(pagePattern("/search/bob smith")).toBeNull();
    expect(pagePattern(`/${"a".repeat(201)}`)).toBeNull();
  });
});
