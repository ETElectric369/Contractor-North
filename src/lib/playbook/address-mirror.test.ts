import { describe, it, expect } from "vitest";
import { isSiteAddressAsk, mirrorAnswers, mirrorValue, siteAddressWhens } from "./address-mirror";
import type { Need } from "@/lib/playbook/types";

const when = [{ key: "describe", known: true }] as Need["when"];
const designerWhen = [{ in: ["Yes"], key: "has_designer" }] as Need["when"];

// Andrew's actual shape: four address questions on one trigger, a designer block on another.
const NEEDS: Need[] = [
  { key: "addr", ask: "Project Address", slot: { type: "text" }, when } as Need,
  { key: "city", ask: "City", slot: { type: "text" }, when } as Need,
  { key: "state", ask: "State", slot: { type: "text" }, when } as Need,
  { key: "zip", ask: "Zip", slot: { type: "number" }, when } as Need,
  { key: "designer_address", ask: "Address", slot: { type: "text" }, when: designerWhen } as Need,
  { key: "designer_city", ask: "City", slot: { type: "text" }, when: designerWhen } as Need,
];

const EFF = { address: "10234 Truckee Way", city: "Truckee", state: "CA", zip: "96161" };

describe("address mirror — the form owns the project address", () => {
  it("a QUALIFIED street ask mirrors; a bare 'Address' never does", () => {
    expect(isSiteAddressAsk("Project Address")).toBe(true);
    expect(isSiteAddressAsk("Site address?")).toBe(true);
    expect(isSiteAddressAsk("Address")).toBe(false);
    expect(isSiteAddressAsk("What is the gate code for the address")).toBe(false);
  });

  it("City/State/Zip mirror only on the SAME trigger as a mirrored street question", () => {
    const whens = siteAddressWhens(NEEDS);
    expect(mirrorValue(NEEDS[1], whens, EFF)).toBe("Truckee");
    expect(mirrorValue(NEEDS[2], whens, EFF)).toBe("CA");
    // The designer block's City rides has_designer — a different party's city, editable.
    expect(mirrorValue(NEEDS[5], whens, EFF)).toBeNull();
    expect(mirrorValue(NEEDS[4], whens, EFF)).toBeNull();
  });

  it("mirrorAnswers overlays all four, typing the zip for its number slot", () => {
    expect(mirrorAnswers(NEEDS, EFF)).toEqual({ addr: "10234 Truckee Way", city: "Truckee", state: "CA", zip: 96161 });
  });

  it("empty form values contribute nothing (no blank overwrites)", () => {
    expect(mirrorAnswers(NEEDS, { address: "", city: "", state: "", zip: "" })).toEqual({});
  });

  it("a playbook with NO street question mirrors nothing — plain City questions stay questions", () => {
    const solo: Need[] = [{ key: "c", ask: "City", slot: { type: "text" }, when } as Need];
    expect(mirrorAnswers(solo, EFF)).toEqual({});
  });
});
