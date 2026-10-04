import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PermitInspection } from "@/lib/permit-inspections";
import { jobsNeedingADay } from "./jobs-needing-a-day";
import {
  INSPECTION_DOOR,
  PERMIT_FEED_COLUMNS,
  PERMIT_INSPECTIONS_UNREAD_ITEM,
  PERMITS_READ_CAP,
  isMissingInspectionsTable,
  permitInspectionItems,
} from "./permit-inspection-items";
import { PILE_DEFS, isUnreadLine, pileOf, rollUpPiles } from "./piles";
import { rowButtons } from "./row-buttons";
import { AFFORDANCES, KIND_META, KIND_STREAM, chipOf, sortActionItems } from "./types";

/**
 * WHAT NEEDS YOU SAYS ABOUT A PERMIT STILL WAITING ON AN INSPECTION (0378).
 *
 * THE LAW BEING PROVED: an inspection that is not yet unblocked is NOT overdue and NOT his, so it is
 * in no pile — while an inspection that IS his (to phone for, or to write up) is one row per permit,
 * rolled into one pile, counting one on the badge.
 */
const TOWN = "Town of Truckee";
const UTIL = "Liberty Utilities";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const WED = "2026-10-14";

const permit = (over: Partial<{ id: string; permit_number: string | null; status: string | null; job_id: string | null; jobs: any }> = {}) => ({
  id: "p1",
  permit_number: "E-1234",
  status: "issued",
  job_id: "j1",
  jobs: { id: "j1", job_number: "J-052", name: "Meter Base Swap", status: "in_progress", customers: { name: "Snowbell Holdings" } },
  ...over,
});

const visit = (over: Partial<PermitInspection> & { position: number }): PermitInspection => ({
  id: `i${over.position}`,
  permit_id: "p1",
  authority: TOWN,
  scheduled_for: null,
  scheduled_window: null,
  inspector: null,
  result: null,
  result_on: null,
  ...over,
});

/** Both booked for Thursday morning, days ahead, by phone. */
const bothBooked = (): PermitInspection[] => [
  visit({ position: 1, authority: TOWN, scheduled_for: THU, scheduled_window: "morning" }),
  visit({ position: 2, authority: UTIL, scheduled_for: THU, scheduled_window: "morning" }),
];

const feed = (inspections: PermitInspection[], todayStr: string, permits = [permit()]) =>
  permitInspectionItems({ permits, inspections, todayStr });

describe("the gate decides what may nag", () => {
  it("booked for today or later: it waits in the fold with the day, and nothing is on the badge", () => {
    const f = feed(bothBooked(), WED);
    expect(f.now).toEqual([]);
    expect(f.waiting).toEqual([
      {
        id: "permitinsp-p1",
        kind: "permit_inspection",
        title: "Meter Base Swap · J-052",
        why: "Waiting on Town of Truckee — Thu Oct 15, morning",
        backOn: THU,
        href: "/jobs/j1?tab=permits",
      },
    ]);
  });

  it("ONE ROW PER PERMIT, even with two inspections booked for one morning", () => {
    const f = feed(bothBooked(), WED);
    expect(f.now.length + f.waiting.length).toBe(1);
  });

  it("the day went by and nobody wrote it up: his, dated by the day it was booked for", () => {
    const f = feed(bothBooked(), FRI);
    expect(f.waiting).toEqual([]);
    expect(f.now).toHaveLength(1);
    expect(f.now[0]).toMatchObject({
      id: "permitinsp-p1",
      kind: "permit_inspection",
      title: "Meter Base Swap · J-052",
      subtitle: "Town of Truckee was booked Oct 15 — say how it went · Permit E-1234 · Snowbell Holdings",
      chip: "Not Written Up",
      when: THU,
      urgency: 1,
      href: "/jobs/j1?tab=permits",
      affordances: ["open"],
    });
  });

  it("nobody has phoned them: his, and undated — there is no day to invent", () => {
    const f = feed([visit({ position: 1, authority: TOWN })], THU);
    expect(f.now[0]).toMatchObject({ chip: "To Book", when: null, subtitle: "Town of Truckee inspection to book · Permit E-1234 · Snowbell Holdings" });
  });

  it("A BLOCKED INSPECTION IS IN NEITHER LIST, even with its booked day long gone", () => {
    // The town failed; the utility is booked for a day that has passed and is still not his to chase.
    // What IS his is another town visit, and that is the one row — named for the town, never the utility.
    const rows = bothBooked();
    rows[0] = { ...rows[0], result: "failed", result_on: THU };
    const f = feed(rows, "2026-10-25");
    expect(f.waiting).toEqual([]);
    expect(f.now).toHaveLength(1);
    expect(f.now[0]).toMatchObject({ chip: "Failed", urgency: 2 });
    expect(f.now[0].subtitle).toBe("Town of Truckee failed Oct 15 — book another visit · Permit E-1234 · Snowbell Holdings");
    expect(f.now[0].subtitle).not.toContain(UTIL);
  });

  it("every inspection passed: no row anywhere, and the job is no longer waiting", () => {
    const f = feed(bothBooked().map((r) => ({ ...r, result: "passed" as const, result_on: THU })), FRI);
    expect(f.now).toEqual([]);
    expect(f.waiting).toEqual([]);
    expect([...f.awaitingJobIds]).toEqual([]);
  });

  it("a permit with no inspections written down is nobody's nag", () => {
    expect(feed([], THU).now).toEqual([]);
    expect(feed([], THU).waiting).toEqual([]);
  });
});

describe("what a permit's row never is", () => {
  it("a permit on no job has no door, so it has no row", () => {
    const f = feed([visit({ position: 1 })], THU, [permit({ job_id: null, jobs: null })]);
    expect(f.now).toEqual([]);
    expect(f.waiting).toEqual([]);
  });

  it("A PERMIT THE OFFICE HAS SETTLED IS NOBODY'S NAG — passed and closed are settled", () => {
    // 0378 carries a permit's old inline inspection forward as its first row, and a permit's own
    // default inspection_result was "pending" — so a permit finished last year can end up holding an
    // open row. Without the permit's status, every one of those nags forever, the "Permit Inspections"
    // pile counts them all, and each job they hang on silently drops off Jobs Needing A Day.
    for (const status of ["passed", "closed"]) {
      const f = feed([visit({ position: 1, authority: "Not said" })], THU, [permit({ status })]);
      expect(f.now).toEqual([]);
      expect(f.waiting).toEqual([]);
      expect([...f.awaitingJobIds]).toEqual([]);
    }
    // Every status still in motion keeps nagging — a failed inspection needs somebody most of all.
    for (const status of ["not_submitted", "applied", "issued", "inspection_scheduled", "failed"]) {
      expect(feed([visit({ position: 1 })], THU, [permit({ status })]).now).toHaveLength(1);
    }
  });

  it("the PERMIT's own status is in the read, not just the job's, or the rule above could never run", () => {
    // Only the columns before the jobs(...) embed are the permit's own.
    expect(PERMIT_FEED_COLUMNS.split("jobs(")[0].split(/\s*,\s*/)).toContain("status");
  });

  it("A JOB NOBODY HAS STARTED IS STILL ASKED FOR ITS DAY — the work comes before the final", () => {
    // "Final inspections come with permits": the visits are written down the day the permit is pulled,
    // long before anyone is on site. Nagging "Book It" then is asking for something that cannot be
    // done, and hiding the job loses the only row that asks for its day.
    const unstarted = { id: "j9", job_number: "J-099", name: "Panel Upgrade", status: "to_be_scheduled", customers: { name: "Snowbell Holdings" } };
    const p = [permit({ id: "p9", permit_number: "B-7", status: "applied", job_id: "j9", jobs: unstarted })];
    const job = { id: "j9", job_number: "J-099", name: "Panel Upgrade", status: "to_be_scheduled", scheduled_start: null, scheduled_end: null, created_at: "2026-10-01T00:00:00Z" };

    const listed = feed([{ ...visit({ position: 1, authority: "Nevada County" }), permit_id: "p9" }], THU, p);
    expect(listed.now).toEqual([]);
    expect([...listed.awaitingJobIds]).toEqual([]);
    expect(jobsNeedingADay({ jobs: [job], todayStr: THU, tz: "America/Los_Angeles", awaitingInspectionJobIds: listed.awaitingJobIds })).toHaveLength(1);

    // Booked for a day still ahead IS a real fact, so it waits in the fold with that day — but it is
    // no reason to stop asking the job for a day either.
    const booked = feed([{ ...visit({ position: 1, authority: "Nevada County", scheduled_for: "2026-10-20" }), permit_id: "p9" }], THU, p);
    expect(booked.now).toEqual([]);
    expect(booked.waiting).toHaveLength(1);
    expect([...booked.awaitingJobIds]).toEqual([]);
    expect(jobsNeedingADay({ jobs: [job], todayStr: THU, tz: "America/Los_Angeles", awaitingInspectionJobIds: booked.awaitingJobIds })).toHaveLength(1);

    // But a day that has GONE BY, or a visit that did not pass, means somebody HAS been — that is real
    // whatever the job's status says.
    const missed = feed([{ ...visit({ position: 1, authority: "Nevada County", scheduled_for: WED }), permit_id: "p9" }], THU, p);
    expect(missed.now).toHaveLength(1);
    expect(missed.now[0].chip).toBe("Not Written Up");
    const failed = feed([{ ...visit({ position: 1, authority: "Nevada County", result: "failed", result_on: WED }), permit_id: "p9" }], THU, p);
    expect(failed.now).toHaveLength(1);
    expect([...failed.awaitingJobIds]).toEqual(["j9"]);
  });

  it("a cancelled job's permit is nobody's business", () => {
    const f = feed(bothBooked(), FRI, [permit({ jobs: { id: "j1", job_number: "J-052", name: "Meter Base Swap", status: "cancelled" } })]);
    expect(f.now).toEqual([]);
    expect(f.waiting).toEqual([]);
  });

  it("a job marked complete still waits on the utility — that is the whole state this adds", () => {
    const f = feed(bothBooked(), WED, [permit({ jobs: { id: "j1", job_number: "J-052", name: "Meter Base Swap", status: "complete" } })]);
    expect(f.waiting).toHaveLength(1);
  });

  it("the row names the job by its name AND number, never the bare number", () => {
    expect(feed(bothBooked(), FRI).now[0].title).toBe("Meter Base Swap · J-052");
  });
});

describe("the badge stays honest", () => {
  it("four permits waiting on him are ONE pile, counting one", () => {
    const permits = [1, 2, 3, 4].map((n) => permit({ id: `p${n}`, permit_number: `E-${n}`, job_id: `j${n}`, jobs: { id: `j${n}`, job_number: `J-0${n}`, name: `Job ${n}`, status: "in_progress" } }));
    const inspections = permits.map((p) => ({ ...visit({ position: 1 }), id: `i-${p.id}`, permit_id: p.id }));
    const f = permitInspectionItems({ permits, inspections, todayStr: THU });
    expect(f.now).toHaveLength(4);
    const rolled = rollUpPiles(sortActionItems(f.now.map((it) => ({ ...it, stream: KIND_STREAM[it.kind] })), THU), { todayStr: THU, isStaff: true });
    const piles = rolled.filter((r) => r.pile);
    expect(rolled).toHaveLength(1);
    expect(piles[0].title).toBe("Permit Inspections · 4");
    expect(piles[0].children).toHaveLength(4);
    expect(piles[0].affordances).toEqual(["open"]);
  });

  it("a lone one stays a plain row (never \"· 1\"), and the pile has no dead list page", () => {
    const f = feed(bothBooked(), FRI);
    const rolled = rollUpPiles(f.now.map((it) => ({ ...it, stream: KIND_STREAM[it.kind] })), { todayStr: FRI, isStaff: true });
    expect(rolled[0].pile).toBeUndefined();
    expect(rolled[0].title).toBe("Meter Base Swap · J-052");
    // /permits is a redirect to Jobs: a See All onto it would be a dead door.
    expect(PILE_DEFS.permit_inspections.listHref).toBeNull();
    expect(pileOf({ kind: "permit_inspection", id: "permitinsp-p1" })).toBe("permit_inspections");
  });

  it("the read's cap is honest about there being more", () => {
    expect(PERMITS_READ_CAP).toBeGreaterThan(50);
  });
});

describe("the row's one button says what to do with it", () => {
  it("each state has its own words, and they all open the permit", () => {
    const words: Record<string, string> = {};
    for (const [rows, today] of [
      [[visit({ position: 1 })], THU],
      [bothBooked(), FRI],
      [[visit({ position: 1, result: "failed" as const, result_on: THU })], FRI],
      [[visit({ position: 1, result: "cancelled" as const, result_on: THU })], FRI],
    ] as const) {
      const item = feed([...rows], today).now[0];
      const b = rowButtons({ ...item, stream: KIND_STREAM[item.kind] }, { isStaff: true });
      words[chipOf(item)] = b.primary!.label;
      expect(b.primary!.act).toEqual({ type: "open", href: "/jobs/j1?tab=permits" });
      expect(b.also).toBeNull();
      expect(b.more).toEqual([]);
    }
    expect(words).toEqual({
      "To Book": "Book It",
      "Not Written Up": "Say How It Went",
      Failed: "Book Another Visit",
      Cancelled: "Book Another Visit",
    });
    // The chip and the door are declared together, so neither can grow a state the other lacks.
    expect(Object.keys(INSPECTION_DOOR).sort()).toEqual(["Cancelled", "Failed", "Not Written Up", "To Book"]);
  });

  it("the kind is today's work, open-only, and its chip has plain words", () => {
    expect(KIND_STREAM.permit_inspection).toBe("today");
    expect(AFFORDANCES.permit_inspection).toEqual(["open"]);
    expect(KIND_META.permit_inspection.label).toBe("Permit Inspection");
  });
});

describe("a job waiting on an authority is not asked for a day", () => {
  const job = { id: "j1", job_number: "J-052", name: "Meter Base Swap", status: "in_progress", scheduled_start: null, scheduled_end: null, created_at: "2026-10-01T00:00:00Z", time_entries: [{ clock_in: "2026-10-12T16:00:00Z" }] };

  it("worked, nothing ahead, and the town still has to come: ONE row, and it is the inspection's", () => {
    const f = feed(bothBooked(), FRI);
    const asked = jobsNeedingADay({ jobs: [job], todayStr: FRI, tz: "America/Los_Angeles", awaitingInspectionJobIds: f.awaitingJobIds });
    expect(asked).toEqual([]);
    expect(f.now).toHaveLength(1);
  });

  it("with the permit finished, the same job is asked for a day again", () => {
    const f = feed(bothBooked().map((r) => ({ ...r, result: "passed" as const, result_on: THU })), FRI);
    const asked = jobsNeedingADay({ jobs: [job], todayStr: FRI, tz: "America/Los_Angeles", awaitingInspectionJobIds: f.awaitingJobIds });
    expect(asked).toHaveLength(1);
  });

  it("A LOST READ SAYS SO — never a quiet zero that asks every waiting job for a day again", () => {
    // With no permits, no job is named as awaiting an inspection, so every job waiting on the town or
    // the utility is asked to pick a day again — the exact mis-ask this feature exists to stop — with
    // nothing on the screen saying anything failed.
    expect(PERMIT_INSPECTIONS_UNREAD_ITEM.title).toBe("Permit Inspections · Couldn't Check");
    expect(isUnreadLine(PERMIT_INSPECTIONS_UNREAD_ITEM)).toBe(true); // about a read, so never piled
    expect(pileOf(PERMIT_INSPECTIONS_UNREAD_ITEM)).toBeNull();
    expect(PERMIT_INSPECTIONS_UNREAD_ITEM.affordances).toEqual(["open"]);
    expect(PERMIT_INSPECTIONS_UNREAD_ITEM.when).toBeNull(); // a read has no date to invent
    // No "Book It" on a line about a read: it opens the page that can say what it couldn't, nothing more.
    const b = rowButtons({ ...PERMIT_INSPECTIONS_UNREAD_ITEM, stream: KIND_STREAM.permit_inspection }, { isStaff: true });
    expect(b.primary).toBeNull();

    // The build pushes it on a lost read, and tells the ops sink — except while 0378 is not applied,
    // which the migration's own header calls a supported state, said once to the sink and no further.
    const q = readFileSync(fileURLToPath(new URL("./query.ts", import.meta.url)), "utf8");
    expect(q).toContain("items.push(PERMIT_INSPECTIONS_UNREAD_ITEM);");
    expect(q).toContain('reportError("action-items.permitInspections.visits"');
    expect(q).toContain('reportError("action-items.permitInspections.needs0378"');
    expect(isMissingInspectionsTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingInspectionsTable({ code: "42P01" })).toBe(true);
    expect(isMissingInspectionsTable({ code: "57014" })).toBe(false); // a timeout IS said to a person
  });

  it("0178's own words do it too, and they had no reader until now", () => {
    expect(jobsNeedingADay({ jobs: [{ ...job, blocked_on: "County permit for the meter swap", blocked_since: "2026-09-20" }], todayStr: FRI, tz: "America/Los_Angeles" })).toEqual([]);
    expect(jobsNeedingADay({ jobs: [{ ...job, blocked_on: "   " }], todayStr: FRI, tz: "America/Los_Angeles" })).toHaveLength(1);
  });
});
