import { describe, it, expect } from "vitest";
import { getOrgSettings, parseGeoFromMapUrl } from "@/lib/org-settings";

/**
 * timeclock_job_codes (owner: "I don't want job code…") — the default MUST reproduce
 * today's behavior byte-identically: an org that never touched the setting keeps the
 * code pickers everywhere. Only an explicit false turns them off.
 */
describe("timeclock_job_codes default", () => {
  it("defaults ON for orgs that never saved the setting (today's behavior)", () => {
    expect(getOrgSettings(undefined).timeclock_job_codes).toBe(true);
    expect(getOrgSettings(null).timeclock_job_codes).toBe(true);
    expect(getOrgSettings({}).timeclock_job_codes).toBe(true);
    // a stored-but-retired key (auto_lunch_30 era) must not disturb defaults
    expect(getOrgSettings({ auto_lunch_30: true } as Record<string, unknown>).timeclock_job_codes).toBe(true);
  });

  it("honors an explicit stored choice", () => {
    expect(getOrgSettings({ timeclock_job_codes: false }).timeclock_job_codes).toBe(false);
    expect(getOrgSettings({ timeclock_job_codes: true }).timeclock_job_codes).toBe(true);
  });
});

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

/**
 * A BAD TIMEZONE IS A CROSS-TENANT KILL SWITCH (audit 6). The nightly engines loop every org in
 * one request and format each org's "today" in its own zone; one unparseable value throws inside
 * the loop and every org AFTER it silently gets no invoices and no reminders.
 */
describe("getOrgSettings — the timezone can never be unparseable", () => {
  const tz = (v: unknown) => getOrgSettings({ timezone: v }).timezone;

  it("keeps a real IANA zone", () => {
    expect(tz("America/New_York")).toBe("America/New_York");
    expect(tz("Europe/London")).toBe("Europe/London");
    expect(tz("America/Los_Angeles")).toBe("America/Los_Angeles");
  });

  it.each([["", "empty"], ["   ", "whitespace"], ["Mars/Olympus", "not a zone"], ["not a timezone", "prose"]])(
    "falls back for %s (%s)", (bad) => {
      expect(tz(bad)).toBe("America/Los_Angeles");
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz(bad) })).not.toThrow();
    });

  it.each([[null], [undefined], [123], [{}], [[]], [true]])("falls back for the non-string %s", (bad) => {
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz(bad) })).not.toThrow();
  });

  it("a poisoned row READS clean, so an already-broken tenant is healed without a migration", () => {
    const poisoned = { timezone: "", currency: "USD" };
    expect(getOrgSettings(poisoned).timezone).toBe("America/Los_Angeles");
  });
});
