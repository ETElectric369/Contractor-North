import { describe, it, expect } from "vitest";
import { MAX_NEAR_M, distanceWords, haversineM, rankByDistance, usableFix } from "./nearest-job";

/** WHICH JOB IS THE PHONE STANDING AT, pinned without a phone (the owner, 2026-11-04). */
const HERE = { lat: 39.3, lng: -120.2 };
const north = (id: string, m: number) => ({ id, lat: HERE.lat + m / 111_195, lng: HERE.lng });

describe("rankByDistance", () => {
  it("keeps the jobs within 2 km, nearest first, each with its distance and whether it is inside the fence", () => {
    const r = rankByDistance(HERE, [north("snowbell", 1500), north("larkspur", 120), north("bayberry", 2500), north("catbird", 280)], { radiusM: 300 });
    expect(r.map((j) => j.id)).toEqual(["larkspur", "catbird", "snowbell"]);
    expect(r.map((j) => j.within)).toEqual([true, true, false]);
    expect(r[0].distanceM).toBeGreaterThanOrEqual(119);
    expect(r[0].distanceM).toBeLessThanOrEqual(121);
    expect(MAX_NEAR_M).toBe(2000);
  });

  it("maxM narrows it; a job with no place is skipped", () => {
    const r = rankByDistance(HERE, [north("larkspur", 500), { id: "thistlewood", lat: NaN, lng: 1 }], { radiusM: 300, maxM: 400 });
    expect(r).toEqual([]);
  });

  it("haversine: a degree of latitude is about 111 km", () => {
    expect(Math.round(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) / 1000)).toBe(111);
  });
});

describe("usableFix", () => {
  it("refuses nothing-fixes: missing, non-numbers, off the globe, null island, too blurred", () => {
    expect(usableFix(null)).toBeNull();
    expect(usableFix({ lat: NaN, lng: 1 })).toBeNull();
    expect(usableFix({ lat: 91, lng: 1 })).toBeNull();
    expect(usableFix({ lat: 0, lng: 0 })).toBeNull();
    expect(usableFix({ ...HERE, accuracy: 2500 })).toBeNull();
    expect(usableFix({ ...HERE, accuracy: 15 })).toEqual({ ...HERE, accuracy: 15 });
    expect(usableFix(HERE)).toEqual({ ...HERE, accuracy: null });
  });
});

describe("distanceWords", () => {
  it("English: feet, then miles", () => {
    expect(distanceWords(36.6)).toBe("120 ft away");
    expect(distanceWords(1)).toBe("10 ft away");
    expect(distanceWords(1287)).toBe("0.8 mi away");
    expect(distanceWords(1287, "en")).toBe("0.8 mi away");
  });
  it("Spanish: metres, then kilometres", () => {
    expect(distanceWords(118, "es")).toBe("a 120 m");
    expect(distanceWords(1287, "es")).toBe("a 1,3 km");
  });
});
