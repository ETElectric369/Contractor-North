import { describe, it, expect } from "vitest";
import {
  bucketInspections,
  captureQuoteId,
  hasCaptureData,
  inspectionRowTags,
  type InspectionBucketRow,
} from "@/lib/inspections";
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES } from "@/lib/statuses";

/** The Walk-Throughs tab's promise (/inspections; W2-10's one word) is TRUTHFUL buckets — pin the
 *  classification rules (Erik's design 2026-07-14) so a refactor can't quietly re-hide open
 *  write-ups or bury a not-yet-visited walk-through behind the Completed toggle. */

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

  it("past WITHOUT capture stays upcoming — it may not have happened; hiding it would lie", () => {
    const r = row({ starts_at: past });
    expect(bucketInspections([r], none, none, NOW).upcoming).toEqual([r]);
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

  // The lead-less "Start A Walk-Through" path: no inquiry_id/job_id ever exists, so the ONLY
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
