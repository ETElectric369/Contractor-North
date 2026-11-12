import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bucketInspections,
  captureQuoteId,
  filedUnder,
  hasCaptureData,
  inspectionLabel,
  inspectionRowTags,
  isGenericInspectionTitle,
  type FiledUnder,
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

  // AS IT STANDS (pinned 2026-11-10, cn-v1158, so the next change here is made on purpose). A visit
  // still scheduled or proposed is filed by its outcome only once its TIME HAS PASSED: one still
  // ahead, or still waiting for a day, stays with the upcoming ones even when it already says lost.
  // That is the one place this function is not "outcome first"; filedUnder is never asked about such
  // a row, because it never reaches `filed`.
  it("a visit still AHEAD, or waiting for a day, stays upcoming even with an outcome on it", () => {
    const ahead = row({ outcome: "lost" });
    const proposedAhead = row({ status: "proposed", outcome: "lost" });
    const noDay = row({ starts_at: null, outcome: "lost" });
    const b = bucketInspections([ahead, proposedAhead, noDay], none, none, NOW);
    expect(b.upcoming.map((r) => r.id).sort()).toEqual([ahead.id, proposedAhead.id, noDay.id].sort());
    expect(b.filed).toEqual([]);
    // Marked completed, it files whatever its time: the completed branch asks no clock.
    const doneAhead = row({ status: "completed", outcome: "lost" });
    expect(bucketInspections([doneAhead], none, none, NOW).filed).toEqual([doneAhead]);
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
 * THE FILED PILE'S HEADING IS BY OUTCOME FIRST (cn-v1158; the owner's standing rule: a visit that did
 * not become work is LOST, everywhere). The page split the filed pile on status alone, so a visit that
 * never happened and was answered Lost in the Didn't Happen? group, still 'scheduled', was drawn under
 * "Completed & written up". One rule now names the heading, and this is its whole table.
 */
describe("filedUnder: which heading a filed row is drawn under", () => {
  // THE WORDS THE APP STORES, read from where they are stored: 0205's check constraint, plus "nobody
  // said" (null). Nothing here is invented, and a fourth word cannot arrive quietly: the constraint is
  // named in one migration, so a later one that renames or widens it fails the first test below until
  // somebody says which heading the new word files under.
  const dir = join(process.cwd(), "supabase/migrations");
  const naming = readdirSync(dir).filter((f) => readFileSync(join(dir, f), "utf8").includes("appointments_outcome_check"));
  const sql = naming.length ? readFileSync(join(dir, naming[0]), "utf8") : "";
  const stored = (/outcome is null or outcome in \(([^)]*)\)/.exec(sql)?.[1] ?? "")
    .split(",")
    .map((w) => w.trim().replace(/'/g, ""))
    .filter(Boolean);

  const TABLE: [status: string, outcome: string | null, want: FiledUnder][] = [
    ["scheduled", null, "completed"],
    ["scheduled", "won", "completed"],
    ["scheduled", "lost", "lost"],
    ["scheduled", "no_bid", "lost"],
    ["proposed", null, "completed"],
    ["proposed", "won", "completed"],
    ["proposed", "lost", "lost"],
    ["proposed", "no_bid", "lost"],
    ["completed", null, "completed"],
    ["completed", "won", "completed"],
    ["completed", "lost", "lost"],
    ["completed", "no_bid", "lost"],
    ["cancelled", null, "cancelled"],
    ["cancelled", "won", "cancelled"],
    ["cancelled", "lost", "lost"],
    ["cancelled", "no_bid", "lost"],
  ];

  it("the table holds every status the app stores against every outcome it stores, each pair once", () => {
    expect(naming).toEqual(["0205_walkthrough_outcome.sql"]);
    expect(stored).toEqual(["won", "lost", "no_bid"]);
    // What Nort's door may write is the same three words.
    expect(readFileSync(join(process.cwd(), "src/lib/actions/entities/appointment.ts"), "utf8")).toContain('outcome: z.enum(["won", "lost", "no_bid"])');
    const pairs = APPOINTMENT_STATUSES.flatMap((s) => [null, ...stored].map((o) => `${s}/${o}`));
    expect(TABLE.map(([s, o]) => `${s}/${o}`).sort()).toEqual([...pairs].sort());
  });

  it.each(TABLE)("%s + outcome %s files under %s", (status, outcome, want) => {
    expect(filedUnder({ status, outcome })).toBe(want);
  });

  it("the four the rule turns on: lost outranks the status, and with no outcome the status says it", () => {
    expect(filedUnder({ status: "cancelled", outcome: "lost" })).toBe("lost");
    expect(filedUnder({ status: "completed", outcome: "lost" })).toBe("lost");
    expect(filedUnder({ status: "completed", outcome: null })).toBe("completed");
    expect(filedUnder({ status: "cancelled", outcome: null })).toBe("cancelled");
  });

  it("a row read without the column, or holding a word nobody stores, files by its status: never Lost on a guess", () => {
    expect(filedUnder({ status: "completed" })).toBe("completed");
    expect(filedUnder({ status: "cancelled" })).toBe("cancelled");
    expect(filedUnder({ status: "cancelled", outcome: "" })).toBe("cancelled");
    expect(filedUnder({ status: "completed", outcome: "LOST" })).toBe("completed");
  });

  it("the Didn't Happen? row answered Lost: it files (this page stops asking), and it files under Lost", () => {
    // Scheduled, a past day, nothing captured, no estimate: the row the Didn't Happen? group draws.
    const before = row({ starts_at: past });
    expect(bucketInspections([before], none, none, NOW).missed).toEqual([before]);
    // Lost is tapped. The outcome is all that changes: the status is still 'scheduled'.
    const after = { ...before, outcome: "lost" };
    const b = bucketInspections([after], none, none, NOW);
    expect(b.filed).toEqual([after]);
    expect([...b.missed, ...b.upcoming, ...b.toWriteUp]).toEqual([]);
    expect(after.status).toBe("scheduled");
    expect(filedUnder(after)).toBe("lost");
  });

  it("every filed row is under exactly one heading, and the three together hold the whole pile", () => {
    const rows = [
      row({ status: "completed", starts_at: past, job_id: "job1" }), // became work
      row({ status: "completed", starts_at: past, outcome: "won" }),
      row({ status: "completed", starts_at: past, outcome: "lost" }), // happened, and the bid was lost
      row({ starts_at: past, outcome: "lost" }), // never happened, answered Lost
      row({ starts_at: past, capture: cap, outcome: "no_bid" }), // the old word for the same ending
      row({ status: "cancelled", starts_at: past }),
      row({ status: "cancelled", starts_at: past, outcome: "lost" }), // called off AND lost: Lost
    ];
    const { filed } = bucketInspections(rows, none, none, NOW);
    expect(filed).toHaveLength(rows.length);
    const under = (g: FiledUnder) => filed.filter((r) => filedUnder(r) === g).map((r) => r.id).sort();
    expect(under("completed")).toEqual([rows[0].id, rows[1].id].sort());
    expect(under("lost")).toEqual([rows[2].id, rows[3].id, rows[4].id, rows[6].id].sort());
    expect(under("cancelled")).toEqual([rows[5].id]);
    expect(under("completed").length + under("lost").length + under("cancelled").length).toBe(filed.length);
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

/* ── The page's tiles ────────────────────────────────────────────────────────────────────────── */
import { FILED_TILES, OPEN_TILES, inspectionRowWords, openFirstTile, rowTagWords, tileInspections, tilesOf, type InspectionTile } from "./inspections";

describe("the seven tiles: every inspection under exactly one", () => {
  type R = { id: string; status: string; starts_at: string | null; inquiry_id: string | null; job_id: string | null; outcome?: string | null; created_at?: string | null };
  const row = (id: string, o: Partial<R> = {}): R => ({ id, status: "scheduled", starts_at: null, inquiry_id: null, job_id: null, ...o });

  it("names the tiles of each view in drawn order", () => {
    expect([...OPEN_TILES]).toEqual(["write_up", "coming_up", "needs_day", "missed"]);
    expect([...FILED_TILES]).toEqual(["completed", "lost", "cancelled"]);
    expect(tilesOf("open")).toBe(OPEN_TILES);
    expect(tilesOf("filed")).toBe(FILED_TILES);
  });

  it("splits upcoming by a start and by whether that start is before today, and orders the waiting ones by the day they were made", () => {
    // 1 PM Pacific on March 10: "today" began at 07:00Z.
    const now = new Date("2026-03-10T20:00:00Z");
    const tiles = tileInspections(
      {
        toWriteUp: [row("w1")],
        upcoming: [
          row("p-old", { starts_at: "2026-02-20T17:00:00Z", status: "proposed" }), // nobody picked; its day went by
          row("p-late", { starts_at: "2026-03-08T17:00:00Z", status: "proposed" }),
          row("d2", { created_at: "2026-03-09T10:00:00Z" }),
          row("d0"), // no stamp: keeps the end
          row("d1", { created_at: "2026-03-02T10:00:00Z" }),
          row("c0", { starts_at: "2026-03-10T15:00:00Z" }), // 8 AM today, already past: still today's
          row("c1", { starts_at: "2026-03-20T17:00:00Z" }),
          row("c2", { starts_at: "2026-03-22T17:00:00Z", status: "proposed" }),
        ],
        missed: [row("m1", { starts_at: "2026-03-01T17:00:00Z" })],
        filed: [
          row("f1", { status: "completed" }),
          row("f2", { status: "scheduled", outcome: "lost" }),
          row("f3", { status: "cancelled" }),
          row("f4", { status: "cancelled", outcome: "no_bid" }),
        ],
      },
      now,
      "America/Los_Angeles",
    );
    const ids = (t: InspectionTile) => tiles[t].map((r) => r.id);
    expect(ids("write_up")).toEqual(["w1"]);
    expect(ids("coming_up")).toEqual(["c0", "c1", "c2"]);
    expect(ids("needs_day")).toEqual(["d1", "d2", "d0"]);
    // A proposal whose day went by with no pick did not happen: with the missed, newest first.
    expect(ids("missed")).toEqual(["p-late", "m1", "p-old"]);
    expect(ids("completed")).toEqual(["f1"]);
    expect(ids("lost")).toEqual(["f2", "f4"]);
    expect(ids("cancelled")).toEqual(["f3"]);
    const all = [...OPEN_TILES, ...FILED_TILES].flatMap(ids);
    expect(all).toHaveLength(14);
    expect(new Set(all).size).toBe(14);
  });

  it("'before today' is the company's midnight: 11 PM yesterday in Truckee is not today, though UTC says it is", () => {
    const now = new Date("2026-03-10T20:00:00Z");
    const late = { toWriteUp: [], upcoming: [row("p", { starts_at: "2026-03-10T06:30:00Z", status: "proposed" })], missed: [], filed: [] };
    expect(tileInspections(late, now, "America/Los_Angeles").missed.map((r) => r.id)).toEqual(["p"]);
    expect(tileInspections(late, now, "UTC").coming_up.map((r) => r.id)).toEqual(["p"]);
  });

  it("opens the tile asked for when it is this view's and has rows, else the first with rows, else none", () => {
    const counts = (o: Partial<Record<InspectionTile, number>>): Record<InspectionTile, number> => ({ write_up: 0, coming_up: 0, needs_day: 0, missed: 0, completed: 0, lost: 0, cancelled: 0, ...o });
    expect(openFirstTile("open", counts({ coming_up: 2, missed: 1 }))).toBe("coming_up");
    expect(openFirstTile("open", counts({ coming_up: 2, missed: 1 }), "missed")).toBe("missed");
    expect(openFirstTile("open", counts({ coming_up: 2 }), "missed")).toBe("coming_up"); // asked for, but empty
    expect(openFirstTile("open", counts({ coming_up: 2, lost: 4 }), "lost")).toBe("coming_up"); // another view's tile
    expect(openFirstTile("open", counts({ coming_up: 2 }), "'; drop")).toBe("coming_up");
    expect(openFirstTile("filed", counts({ write_up: 9, lost: 4 }))).toBe("lost");
    expect(openFirstTile("filed", counts({ lost: 4, cancelled: 1 }), "cancelled")).toBe("cancelled");
    expect(openFirstTile("open", counts({ lost: 4 }))).toBeNull();
  });
});

describe("a row's words: who in bold, then what, and no pill", () => {
  it("says the tags as plain words, with no field notes under Write Up only and no 'cancelled' under Cancelled", () => {
    const es = (k: string) => ({ ip_lib_pendingPick: "por elegir", ip_lib_cancelled: "cancelada", ip_lib_noFieldNotes: "sin notas de campo" })[k] ?? k;
    expect(rowTagWords({ status: "completed", capture: null }, "write_up")).toEqual(["no field notes"]);
    expect(rowTagWords({ status: "completed", capture: { notes: "panel is full" } }, "write_up")).toEqual([]);
    expect(rowTagWords({ status: "scheduled", capture: null }, "coming_up")).toEqual([]);
    expect(rowTagWords({ status: "proposed" }, "coming_up")).toEqual(["pending pick"]);
    expect(rowTagWords({ status: "proposed" }, "coming_up", "es", es)).toEqual(["por elegir"]);
    expect(rowTagWords({ status: "cancelled" }, "cancelled")).toEqual([]);
    expect(rowTagWords({ status: "cancelled" }, "lost")).toEqual(["cancelled"]);
    expect(rowTagWords({ status: "cancelled" }, "lost", "es", es)).toEqual(["cancelada"]);
    expect(rowTagWords({ type: "final_inspection", status: "scheduled" }, "coming_up")).toEqual(["Final Inspection"]);
    // Every kind but the plain inspection says which it is, first; the plain one says nothing.
    expect(rowTagWords({ type: "quote", status: "proposed" }, "coming_up")).toEqual(["Quote / Estimate", "pending pick"]);
    expect(rowTagWords({ type: "inspection", status: "scheduled" }, "coming_up")).toEqual([]);
    expect(rowTagWords({ type: null, status: "scheduled" }, "coming_up")).toEqual([]);
    // The tags with their tones are the older rule, kept as it was: a quote visit wears none.
    expect(inspectionRowTags({ type: "quote", status: "scheduled" })).toEqual([]);
    // The tags with their tones are the same rule, unchanged.
    expect(inspectionRowTags({ status: "proposed" })).toEqual([{ tone: "amber", label: "pending pick" }]);
  });

  it("somebody is named: the name is the who; a typed title, the street and the tags are the what", () => {
    expect(inspectionRowWords({ title: "Hot tub hookup", typeLabel: "Inspection", customer: "Dana Rook", street: "12 Larkspur Ln, Truckee", tags: ["no field notes"] })).toEqual({
      who: "Dana Rook",
      what: "Hot tub hookup · 12 Larkspur Ln, Truckee · no field notes",
    });
    // A bare title and a booking door's stamp are not typed titles: the name is never said twice.
    for (const title of ["Inspection", "inspection:", "Inspection: Dana Rook", "Site inspection: Dana Rook", "", null]) {
      expect(inspectionRowWords({ title, typeLabel: "Inspection", customer: "Dana Rook", street: "12 Larkspur Ln" })).toEqual({ who: "Dana Rook", what: "12 Larkspur Ln" });
    }
    // The phrase begins with a capital even when a tag leads it, in the reader's language.
    expect(inspectionRowWords({ title: null, typeLabel: "Inspection", customer: "Dana Rook", street: null, tags: ["no field notes"] }).what).toBe("No field notes");
    expect(inspectionRowWords({ title: null, typeLabel: "Inspección", customer: "Dana Rook", tags: ["sin notas de campo"], lang: "es" }).what).toBe("Sin notas de campo");
    expect(inspectionRowWords({ title: null, typeLabel: "Inspection", customer: "Dana Rook" })).toEqual({ who: "Dana Rook", what: "" });
  });

  it("nobody is named: the typed title is the who, else the street, else the type's label", () => {
    expect(inspectionRowWords({ title: "Generator pad", typeLabel: "Inspection", street: "4 Snowbell Ct", tags: ["pending pick"] })).toEqual({ who: "Generator pad", what: "4 Snowbell Ct · pending pick" });
    expect(inspectionRowWords({ title: "Inspection", typeLabel: "Inspection", street: "4 Snowbell Ct", tags: ["pending pick"] })).toEqual({ who: "4 Snowbell Ct", what: "Pending pick" });
    expect(inspectionRowWords({ title: "Inspection: 4 Snowbell Ct", typeLabel: "Inspection", street: "4 Snowbell Ct, Truckee" })).toEqual({ who: "4 Snowbell Ct, Truckee", what: "" });
    expect(inspectionRowWords({ title: " ", typeLabel: "Quote / Estimate" })).toEqual({ who: "Quote / Estimate", what: "" });
  });

  it("a tag never repeats the bold line, and a title stamped in English is no typed title for a Spanish reader", () => {
    // Nobody named, nothing typed: the bold line IS the type's label, so its own tag is left out.
    expect(inspectionRowWords({ title: "Final Inspection", typeLabel: "Final Inspection", tags: ["Final Inspection", "pending pick"] })).toEqual({ who: "Final Inspection", what: "Pending pick" });
    // A quote visit whose booking door stamped it: the name once, and the kind in the phrase.
    expect(inspectionRowWords({ title: "Quote: Sam Tillery", typeLabel: "Quote / Estimate", customer: "Sam Tillery", street: "12 Larkspur Ln", tags: ["Quote / Estimate"] })).toEqual({
      who: "Sam Tillery",
      what: "12 Larkspur Ln · Quote / Estimate",
    });
    // The stored stamp is English whoever reads it.
    const es = { title: "Final Inspection", typeLabel: "Inspección Final", customer: "Dana Rook", street: "9 Snowbell Ct", tags: ["Inspección Final"], lang: "es" as const };
    expect(inspectionRowWords(es).what).toBe("Final Inspection · 9 Snowbell Ct · Inspección Final"); // without the English label it reads as typed
    expect(inspectionRowWords({ ...es, stampLabels: ["Final Inspection"] })).toEqual({ who: "Dana Rook", what: "9 Snowbell Ct · Inspección Final" });
    expect(inspectionRowWords({ title: "Final Inspection", typeLabel: "Inspección Final", stampLabels: ["Final Inspection"], tags: ["Inspección Final"], lang: "es" })).toEqual({ who: "Inspección Final", what: "" });
  });
});
