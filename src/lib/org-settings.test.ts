import { describe, it, expect } from "vitest";
import { parseGeoFromMapUrl } from "@/lib/org-settings";

describe("parseGeoFromMapUrl — geo from a pasted Google Maps link", () => {
  it("prefers the place marker (!3d/!4d) — the actual business pin", () => {
    // Tahoe Deck's real GBP link: viewport @39.36494,-120.872 but the pin is !3d39.3657!4d-120.2128
    const url =
      "https://www.google.com/maps/place/Tahoe+Deck/@39.36494,-120.8721941,9z/data=!4m6!3m5!1s0x6388e5d9d7bd993d:0xdff3dd665d9ac349!8m2!3d39.3657384!4d-120.212828!16s%2Fg%2F11vwz3kfh_";
    expect(parseGeoFromMapUrl(url)).toEqual({ lat: 39.3657384, lng: -120.212828 });
  });

  it("falls back to the @viewport center when there's no marker", () => {
    expect(parseGeoFromMapUrl("https://maps.google.com/@39.328,-120.183,14z")).toEqual({ lat: 39.328, lng: -120.183 });
  });

  it("returns null for a link with no coordinates (bare ?cid=)", () => {
    expect(parseGeoFromMapUrl("https://www.google.com/maps?cid=16137485321525445449")).toBeNull();
  });

  it("returns null for empty/garbage input", () => {
    expect(parseGeoFromMapUrl("")).toBeNull();
    expect(parseGeoFromMapUrl(null)).toBeNull();
    expect(parseGeoFromMapUrl("not a url")).toBeNull();
  });

  it("rejects out-of-range coordinates", () => {
    expect(parseGeoFromMapUrl("@200,-400,10z")).toBeNull();
  });
});
