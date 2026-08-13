import { describe, it, expect } from "vitest";
import { extractJsonObject } from "./ai-json";

describe("reading a JSON object out of a model's reply", () => {
  it("takes the object out of a ```json fence", () => {
    expect(JSON.parse(extractJsonObject('```json\n{"items":[]}\n```'))).toEqual({ items: [] });
  });

  it("takes it out of a bare fence too", () => {
    expect(JSON.parse(extractJsonObject('```\n{"a":1}\n```'))).toEqual({ a: 1 });
  });

  it("ignores prose either side — the old slice did this much and no more", () => {
    expect(JSON.parse(extractJsonObject('Here you go:\n{"a":1}\nHope that helps!'))).toEqual({ a: 1 });
  });

  it("scrubs a trailing comma, in an object and in an array", () => {
    expect(JSON.parse(extractJsonObject('{"items":[1,2,],}'))).toEqual({ items: [1, 2] });
  });

  it("throws rather than returning junk when there is no object at all", () => {
    expect(() => extractJsonObject("I could not price that.")).toThrow(/No JSON/);
  });

  it("keeps the LAST closing brace, so a nested object survives", () => {
    expect(JSON.parse(extractJsonObject('{"a":{"b":1},"c":2}'))).toEqual({ a: { b: 1 }, c: 2 });
  });

  it("an unescaped inch mark still fails HERE — that is what the repair round trip is for", () => {
    // The everyday vocabulary of this trade: 3/4" EMT, 1/2" drywall. A model that forgets to
    // escape one produces a broken string, extractJsonObject cannot mend it, and the caller must
    // fall through to the repair. Pinned so nobody "fixes" this by mangling quotes blindly.
    expect(() => JSON.parse(extractJsonObject('{"description":"3/4" EMT"}'))).toThrow();
  });
});
