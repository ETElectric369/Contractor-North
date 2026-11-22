import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PICK_LINK_CLOSED, pickErrorSaid } from "./pick-error";

/**
 * cn-v1180: a customer whose pick page was open when the office withdrew the link taps a time and the
 * database answers "This link was already used", which is untrue of a withdrawn link. The page says
 * one sentence that is true of a used link and of a withdrawn one.
 */
describe("what the pick page says when a tap is refused", () => {
  it("a link that is no longer pending reads as closed, never as used", () => {
    expect(pickErrorSaid("This link was already used")).toBe(PICK_LINK_CLOSED);
    expect(PICK_LINK_CLOSED).not.toMatch(/used/i);
    expect(PICK_LINK_CLOSED).toMatch(/call/i);
  });

  it("any other refusal is said as the database said it, and nothing at all is never drawn", () => {
    expect(pickErrorSaid("This appointment is no longer available")).toBe("This appointment is no longer available");
    expect(pickErrorSaid("")).toMatch(/try again/i);
    expect(pickErrorSaid(null)).toMatch(/try again/i);
    expect(pickErrorSaid(undefined)).toMatch(/try again/i);
  });

  it("the page draws the refusal through this one function, and reads no catalog", () => {
    const src = readFileSync(new URL("./date-picker.tsx", import.meta.url), "utf8");
    expect(src).toContain("setError(pickErrorSaid(");
    expect(src).not.toContain("@/lib/i18n");
  });
});
