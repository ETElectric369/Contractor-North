import { describe, it, expect } from "vitest";
import { BECAME_CAP, BECAME_UNREAD, becameHref, leadBecame } from "./became";

/**
 * WHAT A CONVERTED LEAD BECAME (cn-v1157). The owner, 2026-11-10: "i had no way to get back to his
 * estimate even though it says right on the screen Became An Estimate". The row's doors are read off
 * the estimates and jobs made from the lead; this is the one rule that turns the two reads into an
 * answer — the doors, none, or unread.
 */
const ok = <T,>(data: T[]) => ({ data, error: null });

describe("the lead's doors", () => {
  it("the job first, then the estimates in the order they were read", () => {
    const got = leadBecame(
      ok([
        { id: "q-new", quote_number: "E-036", title: "Panel Upgrade" },
        { id: "q-old", quote_number: "E-031", title: "Panel Upgrade (first pass)" },
      ]),
      ok([{ id: "j-1", job_number: "J-061", name: "Panel Upgrade — Larkspur" }]),
    );
    expect(got).toEqual([
      { kind: "job", id: "j-1", number: "J-061", title: "Panel Upgrade — Larkspur" },
      { kind: "estimate", id: "q-new", number: "E-036", title: "Panel Upgrade" },
      { kind: "estimate", id: "q-old", number: "E-031", title: "Panel Upgrade (first pass)" },
    ]);
  });

  it("an estimate alone is one door", () => {
    expect(leadBecame(ok([{ id: "q-1", quote_number: "E-036", title: "Panel Upgrade" }]), ok([]))).toEqual([
      { kind: "estimate", id: "q-1", number: "E-036", title: "Panel Upgrade" },
    ]);
  });

  it("a failed read is UNREAD, never nothing", () => {
    const boom = { data: null, error: { message: "timeout" } };
    expect(leadBecame(boom, ok([]))).toBe(BECAME_UNREAD);
    expect(leadBecame(ok([]), boom)).toBe(BECAME_UNREAD);
    // An error beside rows is still a read nobody can trust.
    expect(leadBecame({ data: [{ id: "q-1", quote_number: "E-1", title: null }], error: { message: "partial" } }, ok([]))).toBe(BECAME_UNREAD);
    // No error and no rows array is not an answer either.
    expect(leadBecame({ data: null, error: null }, ok([]))).toBe(BECAME_UNREAD);
  });

  it("nothing made from it (or nothing this reader may see) is null", () => {
    expect(leadBecame(ok([]), ok([]))).toBeNull();
  });

  it("a blank number or title is null, never an empty string", () => {
    expect(leadBecame(ok([{ id: "q-1", quote_number: "  ", title: "" }]), ok([{ id: "j-1", job_number: null, name: " " }]))).toEqual([
      { kind: "job", id: "j-1", number: null, title: null },
      { kind: "estimate", id: "q-1", number: null, title: null },
    ]);
  });

  it("each door goes to its own record", () => {
    expect(becameHref({ kind: "estimate", id: "q-1" })).toBe("/quotes/q-1");
    expect(becameHref({ kind: "job", id: "j-1" })).toBe("/jobs/j-1");
  });

  it("the cap is small: a row offers the newest few", () => {
    expect(BECAME_CAP).toBeGreaterThanOrEqual(2);
    expect(BECAME_CAP).toBeLessThanOrEqual(6);
  });
});
