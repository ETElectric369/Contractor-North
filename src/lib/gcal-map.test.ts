import { describe, expect, it } from "vitest";
import {
  isCnEvent,
  mapGoogleEvent,
  allDayEventDays,
  jobEventBody,
  apptEventBody,
} from "./gcal-map";

describe("isCnEvent (echo-skip filter)", () => {
  it("skips events we pushed (cn=1)", () => {
    expect(isCnEvent({ extendedProperties: { private: { cn: "1" } } })).toBe(true);
    expect(isCnEvent({ extendedProperties: { private: { cn: "1", cn_kind: "job", cn_id: "x" } } })).toBe(true);
  });
  it("mirrors genuine Google events", () => {
    expect(isCnEvent({})).toBe(false);
    expect(isCnEvent({ extendedProperties: { private: {} } })).toBe(false);
    expect(isCnEvent({ extendedProperties: { private: { cn: "0" } } })).toBe(false);
    expect(isCnEvent(undefined)).toBe(false);
    expect(isCnEvent(null)).toBe(false);
  });
});

describe("mapGoogleEvent", () => {
  it("maps a timed event", () => {
    const row = mapGoogleEvent(
      {
        id: "ev1",
        status: "confirmed",
        summary: "Dentist",
        start: { dateTime: "2026-07-20T09:00:00-07:00" },
        end: { dateTime: "2026-07-20T10:00:00-07:00" },
      },
      "primary",
    );
    expect(row).toEqual({
      google_calendar_id: "primary",
      google_event_id: "ev1",
      title: "Dentist",
      starts_at: "2026-07-20T16:00:00.000Z",
      ends_at: "2026-07-20T17:00:00.000Z",
      all_day: false,
    });
  });

  it("maps an all-day event with the DATE preserved verbatim (no tz parse)", () => {
    const row = mapGoogleEvent(
      { id: "ev2", summary: "Vacation", start: { date: "2026-08-03" }, end: { date: "2026-08-08" } },
      "cal@x",
    );
    expect(row).toMatchObject({
      all_day: true,
      starts_at: "2026-08-03T00:00:00Z",
      ends_at: "2026-08-08T00:00:00Z",
    });
  });

  it("returns null for cancelled / id-less / start-less / unparseable events", () => {
    expect(mapGoogleEvent({ id: "e", status: "cancelled", start: { date: "2026-08-03" } }, "c")).toBeNull();
    expect(mapGoogleEvent({ start: { date: "2026-08-03" } }, "c")).toBeNull();
    expect(mapGoogleEvent({ id: "e" }, "c")).toBeNull();
    expect(mapGoogleEvent({ id: "e", start: { dateTime: "not-a-date" } }, "c")).toBeNull();
  });

  it("drops a non-positive end and titles an untitled event '(busy)'", () => {
    const row = mapGoogleEvent(
      { id: "e", start: { dateTime: "2026-07-20T09:00:00Z" }, end: { dateTime: "2026-07-20T09:00:00Z" } },
      "c",
    );
    expect(row?.ends_at).toBeNull();
    expect(row?.title).toBe("(busy)");
  });
});

describe("allDayEventDays", () => {
  it("one-day event (Google end is exclusive)", () => {
    expect(allDayEventDays("2026-07-20", "2026-07-21")).toEqual(["2026-07-20"]);
  });
  it("multi-day span", () => {
    expect(allDayEventDays("2026-07-20", "2026-07-23")).toEqual(["2026-07-20", "2026-07-21", "2026-07-22"]);
  });
  it("missing end = single day; crosses month boundaries by UTC math", () => {
    expect(allDayEventDays("2026-07-31", null)).toEqual(["2026-07-31"]);
    expect(allDayEventDays("2026-07-31", "2026-08-02")).toEqual(["2026-07-31", "2026-08-01"]);
  });
  it("garbage start = no days; runaway ranges are capped at 60", () => {
    expect(allDayEventDays("nope", "2026-08-02")).toEqual([]);
    expect(allDayEventDays("2026-01-01", "2027-01-01")).toHaveLength(60);
  });
});

describe("jobEventBody", () => {
  const job = {
    id: "j1",
    job_number: "JOB-0042",
    name: "Panel swap",
    address: "123 Main St",
    description: "200A upgrade",
    scheduled_start: "2026-07-20T15:00:00.000Z",
    scheduled_end: "2026-07-20T23:00:00.000Z",
  };

  it("builds summary/window/tag", () => {
    const b = jobEventBody(job, { linkUrl: "https://app/jobs/j1" });
    expect(b.summary).toBe("JOB-0042 — Panel swap");
    expect(b.location).toBe("123 Main St");
    expect(b.description).toContain("200A upgrade");
    expect(b.description).toContain("https://app/jobs/j1");
    expect(b.start.dateTime).toBe("2026-07-20T15:00:00.000Z");
    expect(b.end.dateTime).toBe("2026-07-20T23:00:00.000Z");
    expect(b.extendedProperties.private).toMatchObject({ cn: "1", cn_kind: "job", cn_id: "j1" });
  });

  it("marks multi-segment jobs '(multi-day)' (v1: one event over the overall window)", () => {
    expect(jobEventBody(job, { multiSegment: true }).summary).toBe("JOB-0042 — Panel swap (multi-day)");
  });

  it("defaults a missing/inverted end to start + 8h", () => {
    const noEnd = jobEventBody({ ...job, scheduled_end: null });
    expect(noEnd.end.dateTime).toBe("2026-07-20T23:00:00.000Z");
    const inverted = jobEventBody({ ...job, scheduled_end: "2026-07-20T10:00:00.000Z" });
    expect(inverted.end.dateTime).toBe("2026-07-20T23:00:00.000Z");
  });
});

describe("apptEventBody", () => {
  const appt = {
    id: "a1",
    type: "inspection",
    title: "Rough-in walk",
    starts_at: "2026-07-21T16:00:00.000Z",
    ends_at: null,
    location: "456 Oak Ave",
    notes: "bring ladder",
  };

  it("prefixes non-generic types, defaults end to +1h, tags cn", () => {
    const b = apptEventBody(appt, { linkUrl: "https://app/appointments/a1" });
    expect(b.summary).toBe("[inspection] Rough-in walk");
    expect(b.end.dateTime).toBe("2026-07-21T17:00:00.000Z");
    expect(b.description).toContain("bring ladder");
    expect(b.description).toContain("https://app/appointments/a1");
    expect(b.extendedProperties.private).toMatchObject({ cn: "1", cn_kind: "appointment", cn_id: "a1" });
  });

  it("plain 'appointment' type gets no prefix; underscores read as spaces", () => {
    expect(apptEventBody({ ...appt, type: "appointment" }).summary).toBe("Rough-in walk");
    expect(apptEventBody({ ...appt, type: "final_inspection" }).summary).toBe("[final inspection] Rough-in walk");
  });

  it("keeps a real end when it's after the start", () => {
    const b = apptEventBody({ ...appt, ends_at: "2026-07-21T18:30:00.000Z" });
    expect(b.end.dateTime).toBe("2026-07-21T18:30:00.000Z");
  });
});
