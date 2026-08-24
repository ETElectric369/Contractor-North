import { describe, it, expect } from "vitest";
import { describeGbpChanges, diffGbp, studioInstructionFor, type GbpSnapshot } from "./gbp-sync";

const snap = (over: Partial<GbpSnapshot> = {}): GbpSnapshot => ({
  placeId: "places/X",
  displayName: "ET Electric",
  nationalPhoneNumber: "(530) 933-6686",
  websiteUri: "https://etelectricity.com",
  primaryType: "Electrician",
  hours: ["Monday: 8 AM–5 PM", "Tuesday: 8 AM–5 PM"],
  rating: null,
  reviewCount: 0,
  at: "2026-08-24T00:00:00Z",
  ...over,
});

describe("diffGbp — the nightly listing watch", () => {
  it("the FIRST sight is a baseline, never an alert", () => {
    // Otherwise every org gets a "your listing changed" the first night, about nothing.
    expect(diffGbp(null, snap())).toEqual([]);
  });

  it("an unchanged listing is silent", () => {
    expect(diffGbp(snap(), snap({ at: "2026-08-25T00:00:00Z" }))).toEqual([]);
  });

  it("a phone change is WIRING — the site should just match it", () => {
    const d = diffGbp(snap(), snap({ nationalPhoneNumber: "(530) 555-0000" }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ field: "nationalPhoneNumber", kind: "wiring", from: "(530) 933-6686", to: "(530) 555-0000" });
  });

  it("a name or category change is COPY — a person decides what the page should say", () => {
    const d = diffGbp(snap(), snap({ displayName: "ET Electric & Lighting", primaryType: "Lighting contractor" }));
    expect(d.map((c) => c.kind)).toEqual(["copy", "copy"]);
    expect(studioInstructionFor(d)).toContain('was "ET Electric", now "ET Electric & Lighting"');
    expect(studioInstructionFor(d)).toContain("Keep the layout and the photos as they are");
  });

  it("new reviews are a SIGNAL, and carry the new count and stars", () => {
    // Erik's listing reads "No reviews" today and he has clients queued to leave them — this is
    // the moment the site should offer to show them off.
    const d = diffGbp(snap(), snap({ reviewCount: 3, rating: 5 }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ field: "reviews", kind: "signal", from: "0", to: "3 (5★)" });
  });

  it("a review disappearing is reported too, not hidden", () => {
    const d = diffGbp(snap({ reviewCount: 4, rating: 4.8 }), snap({ reviewCount: 3, rating: 4.8 }));
    expect(d[0]).toMatchObject({ label: "Reviews removed", from: "4", to: "3" });
  });

  it("hours are compared as a whole week, not day by day", () => {
    const d = diffGbp(snap(), snap({ hours: ["Monday: 7 AM–6 PM", "Tuesday: 8 AM–5 PM"] }));
    expect(d).toHaveLength(1);
    expect(d[0].field).toBe("hours");
    expect(d[0].kind).toBe("wiring");
  });

  it("wiring is listed before copy, so the easy fixes read first", () => {
    const d = diffGbp(snap(), snap({ displayName: "New Name", nationalPhoneNumber: "(530) 555-0000" }));
    expect(d.map((c) => c.kind)).toEqual(["wiring", "copy"]);
  });

  it("describes itself in one plain sentence", () => {
    const d = diffGbp(snap(), snap({ nationalPhoneNumber: "(530) 555-0000", displayName: "New Name" }));
    expect(describeGbpChanges(d)).toBe("Your Google listing changed: phone number and business name.");
    expect(describeGbpChanges([])).toBe("");
  });

  it("a review-only change produces NO studio instruction — nothing is written wrong", () => {
    const d = diffGbp(snap(), snap({ reviewCount: 2 }));
    expect(studioInstructionFor(d)).toBe("");
  });
});
