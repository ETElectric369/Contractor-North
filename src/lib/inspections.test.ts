import { describe, it, expect } from "vitest";
import {
  bucketInspections,
  captureQuoteId,
  hasCaptureData,
  inspectionLabel,
  inspectionRowTags,
  isGenericInspectionTitle,
  type InspectionBucketRow,
} from "@/lib/inspections";
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES } from "@/lib/statuses";

/** The Inspections tab's promise (/inspections; the one word, lib/statuses) is TRUTHFUL buckets — pin the
 *  classification rules (Erik's design 2026-07-14) so a refactor can't quietly re-hide open
 *  write-ups or bury a not-yet-visited inspection behind the Completed toggle. */

const NOW = new Date("2026-07-14T18:00:00Z");
const past = "2026-07-13T16:00:00Z";
const future = "2026-07-16T16:00:00Z";
const cap = { notes: "100A Zinsco panel", measurements: "", materials: "", photos: [] };

let n = 0;
function row(over: Partial<InspectionBucketRow>): InspectionBucketRow {
  return {
    id: `a${++n}`,
    status: "scheduled",
    starts_at: future,
    inquiry_id: null,
    job_id: null,
    capture: null,
    ...over,
  };
}

const none = new Set<string>();

describe("hasCaptureData", () => {
  it("empty/blank capture is NOT data; any filled field or photo is", () => {
    expect(hasCaptureData(null)).toBe(false);
    expect(hasCaptureData({})).toBe(false);
    expect(hasCaptureData({ notes: "  ", measurements: "", materials: "", photos: [] })).toBe(false);
    expect(hasCaptureData({ notes: "attic access over garage" })).toBe(true);
    expect(hasCaptureData({ photos: ["org/appointments/a/1.jpg"] })).toBe(true);
  });
  it("a typed take-off row or an ad-hoc measure is data too (cn-v1069): the sheet is not blank", () => {
    expect(hasCaptureData({ items: [{ id: "i", description: "12-2 romex", quantity: 200, unit: "ft" }] })).toBe(true);
    expect(hasCaptureData({ measures: [{ id: "m", label: "Panel to garage", value: 85, unit: "ft" }] })).toBe(true);
    expect(hasCaptureData({ items: [], measures: [] })).toBe(false);
  });
});

describe("bucketInspections", () => {
  it("future scheduled → upcoming; proposed → upcoming (pending pick)", () => {
    const rows = [row({}), row({ status: "proposed" })];
    const b = bucketInspections(rows, none, none, NOW);
    expect(b.upcoming.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(b.toWriteUp).toEqual([]);
    expect(b.filed).toEqual([]);
  });

  it("past + capture (nobody tapped complete) counts as HAPPENED → to write up", () => {
    const r = row({ starts_at: past, capture: cap });
    expect(bucketInspections([r], none, none, NOW).toWriteUp).toEqual([r]);
  });

  it("a past DAY, still scheduled, WITHOUT capture is MISSED (Didn't Happen?) — never upcoming, never to write up", () => {
    const r = row({ starts_at: past });
    const b = bucketInspections([r], none, none, NOW);
    expect(b.missed).toEqual([r]);
    expect(b.upcoming).toEqual([]);
    expect(b.toWriteUp).toEqual([]);
  });

  it("missed needs ALL of: scheduled, before today, no capture, not settled", () => {
    const proposed = row({ status: "proposed", starts_at: past });
    const withNotes = row({ starts_at: past, capture: cap });
    const withOutcome = row({ starts_at: past, outcome: "lost" });
    const onAJob = row({ starts_at: past, job_id: "job1" });
    const quoted = row({ starts_at: past, inquiry_id: "inq1" });
    const waiting = row({ starts_at: null });
    const b = bucketInspections([proposed, withNotes, withOutcome, onAJob, quoted, waiting], new Set(["inq1"]), none, NOW);
    expect(b.missed).toEqual([]);
    expect(b.upcoming.map((r) => r.id).sort()).toEqual([proposed.id, waiting.id].sort());
    expect(b.toWriteUp).toEqual([withNotes]);
    expect(b.filed.map((r) => r.id).sort()).toEqual([withOutcome.id, onAJob.id, quoted.id].sort());
  });

  it("the day edge is the COMPANY's midnight: 11:30 PM yesterday Pacific is missed, 12:30 AM today Pacific is still upcoming", () => {
    const tz = "America/Los_Angeles"; // NOW = 11:00 AM Jul 14 Pacific; the company's midnight is 07:00Z
    const lastNight = row({ starts_at: "2026-07-14T06:30:00Z" });
    const earlyToday = row({ starts_at: "2026-07-14T07:30:00Z" });
    const b = bucketInspections([lastNight, earlyToday], none, none, NOW, none, none, tz);
    expect(b.missed).toEqual([lastNight]);
    expect(b.upcoming).toEqual([earlyToday]);
    // The same two instants on a UTC clock are both today: the zone is what moved the edge.
    const u = bucketInspections([lastNight, earlyToday], none, none, NOW);
    expect(u.missed).toEqual([]);
    expect(u.upcoming.length).toBe(2);
  });

  it("missed is newest first", () => {
    const a = row({ starts_at: "2026-06-01T16:00:00Z" });
    const b = row({ starts_at: "2026-07-01T16:00:00Z" });
    expect(bucketInspections([a, b], none, none, NOW).missed.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("completed with no estimate → to write up, even with no capture (the visit is DONE)", () => {
    const r = row({ status: "completed", starts_at: past });
    expect(bucketInspections([r], none, none, NOW).toWriteUp).toEqual([r]);
  });

  it("an estimate on the inquiry OR the job files the completed/past-captured visit away", () => {
    const viaInquiry = row({ status: "completed", starts_at: past, inquiry_id: "inq1" });
    const viaJob = row({ starts_at: past, capture: cap, job_id: "job1" });
    const b = bucketInspections([viaInquiry, viaJob], new Set(["inq1"]), new Set(["job1"]), NOW);
    expect(b.filed.map((r) => r.id).sort()).toEqual([viaInquiry.id, viaJob.id].sort());
    expect(b.toWriteUp).toEqual([]);
  });

  it("a FUTURE visit stays upcoming even when its inquiry already has an estimate", () => {
    const r = row({ inquiry_id: "inq1" });
    expect(bucketInspections([r], new Set(["inq1"]), none, NOW).upcoming).toEqual([r]);
  });

  it("cancelled always files away", () => {
    const r = row({ status: "cancelled", starts_at: past, capture: cap });
    expect(bucketInspections([r], none, none, NOW).filed).toEqual([r]);
  });

  // The lead-less "Start an Inspection" path: no inquiry_id/job_id ever exists, so the ONLY
  // write-up signal is the quote id saveQuote stamps onto the capture jsonb. Without it
  // the row sat in "To write up" forever (the only escape was cancelling — a lie).
  it("capture.quote_id files a lead-less write-up away (completed AND done-by-capture)", () => {
    const done = row({ status: "completed", starts_at: past, capture: { ...cap, quote_id: "q1" } });
    const byCapture = row({ starts_at: past, capture: { ...cap, quote_id: "q1" } });
    const b = bucketInspections([done, byCapture], none, none, NOW, new Set(["q1"]));
    expect(b.filed.map((r) => r.id).sort()).toEqual([done.id, byCapture.id].sort());
    expect(b.toWriteUp).toEqual([]);
  });

  it("a stamped quote that no longer EXISTS does not file the row (truthful un-file on delete)", () => {
    const r = row({ status: "completed", starts_at: past, capture: { ...cap, quote_id: "q-deleted" } });
    expect(bucketInspections([r], none, none, NOW, new Set(["q-other"])).toWriteUp).toEqual([r]);
  });

  it("a past visit with a BLANK capture but a stamped existing quote files (the estimate proves the visit)", () => {
    const r = row({ starts_at: past, capture: { quote_id: "q1" } });
    const b = bucketInspections([r], none, none, NOW, new Set(["q1"]));
    expect(b.filed).toEqual([r]);
    expect(b.upcoming).toEqual([]);
  });

  it("callers that don't pass quote ids keep the old behavior (default empty set)", () => {
    const r = row({ status: "completed", starts_at: past, capture: { ...cap, quote_id: "q1" } });
    expect(bucketInspections([r], none, none, NOW).toWriteUp).toEqual([r]);
  });

  it("ordering: write-ups oldest-first, upcoming soonest-first, filed newest-first", () => {
    const w1 = row({ status: "completed", starts_at: "2026-07-10T16:00:00Z" });
    const w2 = row({ status: "completed", starts_at: past });
    const u1 = row({ starts_at: "2026-07-20T16:00:00Z" });
    const u2 = row({ starts_at: future });
    const f1 = row({ status: "cancelled", starts_at: "2026-07-01T16:00:00Z" });
    const f2 = row({ status: "cancelled", starts_at: "2026-07-05T16:00:00Z" });
    const b = bucketInspections([u1, w2, f1, u2, w1, f2], none, none, NOW);
    expect(b.toWriteUp.map((r) => r.id)).toEqual([w1.id, w2.id]);
    expect(b.upcoming.map((r) => r.id)).toEqual([u2.id, u1.id]);
    expect(b.filed.map((r) => r.id)).toEqual([f2.id, f1.id]);
  });
});

/**
 * NO ROW IN AN OPEN PILE SAYS IT IS FINISHED (report 8592392b, 2026-10-02: "glaring on the front is
 * [a customer] tagged Done while it sits in the open box"). The green pill came off
 * `status === "completed"` alone, on the one row component that draws the OPEN piles and the filed
 * pile both — so every row of "To write up", Create Estimate button and all, wore a Done pill.
 */
describe("inspectionRowTags", () => {
  it("a completed visit with no estimate lands in To Write Up, and wears no done tag there", () => {
    const r = row({ status: "completed", starts_at: past, capture: cap });
    // The open pile, by the page's own bucketing…
    expect(bucketInspections([r], none, none, NOW).toWriteUp).toEqual([r]);
    // …and the row it draws says nothing about being done.
    expect(inspectionRowTags(r, true)).toEqual([]);
  });

  it("no status, in either pile, can produce a done tag or a green one", () => {
    for (const status of APPOINTMENT_STATUSES) {
      for (const type of APPOINTMENT_TYPES) {
        for (const writeUp of [true, false]) {
          const tags = inspectionRowTags({ type, status, capture: cap }, writeUp);
          expect(tags.map((t) => t.label).join("|").toLowerCase(), `${type}/${status}`).not.toContain("done");
          expect(tags.map((t) => t.tone), `${type}/${status}`).not.toContain("green");
        }
      }
    }
  });

  it("the tags that DO survive: the city's Final Inspection, pending pick, cancelled, no field notes", () => {
    // This list holds the city's inspection too (ESTIMATE_VISIT_TYPES), so that row says which it is.
    expect(inspectionRowTags({ type: "final_inspection", status: "scheduled" })).toEqual([
      { tone: "indigo", label: "Final Inspection" },
    ]);
    expect(inspectionRowTags({ type: "inspection", status: "proposed" })).toEqual([{ tone: "amber", label: "pending pick" }]);
    expect(inspectionRowTags({ type: "inspection", status: "cancelled" })).toEqual([{ tone: "slate", label: "cancelled" }]);
    // "no field notes" is worth saying only in the pile that is asking for the write-up.
    expect(inspectionRowTags({ type: "inspection", status: "completed", capture: null }, true)).toEqual([
      { tone: "slate", label: "no field notes" },
    ]);
    expect(inspectionRowTags({ type: "inspection", status: "completed", capture: cap }, true)).toEqual([]);
    expect(inspectionRowTags({ type: "inspection", status: "completed", capture: null })).toEqual([]);
  });
});

describe("captureQuoteId", () => {
  it("reads the stamped id and ignores junk shapes", () => {
    expect(captureQuoteId({ quote_id: "q1" })).toBe("q1");
    expect(captureQuoteId({ quote_id: "" })).toBeNull();
    expect(captureQuoteId({ quote_id: 42 })).toBeNull();
    expect(captureQuoteId(null)).toBeNull();
    expect(captureQuoteId("q1")).toBeNull();
  });
});


describe("isGenericInspectionTitle", () => {
  const cases: [string | null | undefined, string, boolean][] = [
    [null, "Inspection", true],
    [undefined, "Inspection", true],
    ["", "Inspection", true],
    ["   ", "Inspection", true],
    ["Inspection", "Inspection", true],
    ["inspection:", "Inspection", true],
    ["  INSPECTION :  ", "Inspection", true],
    ["Site Inspection", "Inspection", true],
    ["site inspection:", "Inspection", true],
    ["Inspección", "Inspección", true],
    ["inspeccion", "Inspección", true],
    ["Final Inspection", "Final Inspection", true],
    ["Inspección Final", "Inspección Final", true],
    ["Inspection: Dana Rook", "Inspection", false],
    ["Panel upgrade at Larkspur", "Inspection", false],
    ["Inspection of the roof", "Inspection", false],
    ["Final Inspection", "Inspection", false],
  ];
  it.each(cases)("%j (type label %j) -> %s", (title, typeLabel, want) => {
    expect(isGenericInspectionTitle(title, typeLabel)).toBe(want);
  });
});

describe("inspectionLabel", () => {
  const day = "Mon, Jul 13";
  const cases: [string, Parameters<typeof inspectionLabel>[0], { title: string; subtitle: string }][] = [
    ["real title keeps itself; subtitle is customer · street · day", { title: "Panel upgrade", typeLabel: "Inspection", customer: "Dana Rook", street: "12 Larkspur Ln", day }, { title: "Panel upgrade", subtitle: "Dana Rook · 12 Larkspur Ln · Mon, Jul 13" }],
    ["real title, only the day known", { title: "Panel upgrade", typeLabel: "Inspection", day }, { title: "Panel upgrade", subtitle: day }],
    ["real title, nothing else", { title: "Panel upgrade", typeLabel: "Inspection" }, { title: "Panel upgrade", subtitle: "" }],
    ["generic title becomes customer · street; the day moves under it", { title: "Inspection", typeLabel: "Inspection", customer: "Sam Tillery", street: "9 Snowbell Ct", day }, { title: "Sam Tillery · 9 Snowbell Ct", subtitle: day }],
    ["generic title, customer only", { title: "", typeLabel: "Inspection", customer: "Theo Vance", day }, { title: "Theo Vance", subtitle: day }],
    ["generic title, street only", { title: "Site inspection:", typeLabel: "Inspection", street: "4 Bayberry Rd", day }, { title: "4 Bayberry Rd", subtitle: day }],
    ["generic title and nobody known: the type label", { title: "Inspection", typeLabel: "Inspection", day }, { title: "Inspection", subtitle: day }],
    ["blank parts are skipped", { title: "Inspection", typeLabel: "Inspection", customer: "  ", street: "7 Thistlewood Dr", day: null }, { title: "7 Thistlewood Dr", subtitle: "" }],
    ["Spanish type label", { title: "Inspección", typeLabel: "Inspección", customer: "Casey Loam", day: "lun, 13 jul" }, { title: "Casey Loam", subtitle: "lun, 13 jul" }],
    // kindUnder (My Day's write-up row, which has no tag to say the KIND): the type's label leads the
    // second line once the title gave way to who and where; it is never said twice, and a real title
    // keeps the second line it always had.
    ["kindUnder: the title gave way, so the kind is line two", { title: "", typeLabel: "Quote / Estimate", customer: "Sam Tillery", street: "9 Snowbell Ct", kindUnder: true }, { title: "Sam Tillery · 9 Snowbell Ct", subtitle: "Quote / Estimate" }],
    ["kindUnder: the kind leads the day", { title: "Inspection", typeLabel: "Final Inspection", customer: "Dana Rook", day, kindUnder: true }, { title: "Dana Rook", subtitle: "Final Inspection · Mon, Jul 13" }],
    ["kindUnder: nobody known, the title IS the kind, said once", { title: "", typeLabel: "Quote / Estimate", kindUnder: true }, { title: "Quote / Estimate", subtitle: "" }],
    ["kindUnder: a real title is untouched", { title: "Panel upgrade", typeLabel: "Inspection", customer: "Theo Vance", kindUnder: true }, { title: "Panel upgrade", subtitle: "Theo Vance" }],
  ];
  it.each(cases)("%s", (_n, input, want) => {
    expect(inspectionLabel(input)).toEqual(want);
  });
});
