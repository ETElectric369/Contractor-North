import { describe, it, expect } from "vitest";
import { computeJobLaborBilling, laborCostForJob, noBillRateWarnings, payViewRow, withoutClaimedLabor } from "@/lib/labor-billing";

describe("laborCostForJob — pay cost (job hub == analytics)", () => {
  const prof = (hourly: number) => ({ hourly_rate: hourly });
  it("un-split closed entry on the job: gross hours × pay rate", () => {
    const e = { job_id: "J", status: "closed", clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 0, profiles: prof(40) };
    expect(laborCostForJob([e], "J")).toEqual({ hours: 8, cost: 320 , unratedHours: 0, ownerHours: 0 });
  });
  it("honors rate_override (supervisor rate) over the base", () => {
    const e = { job_id: "J", status: "closed", clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 0, rate_override: 60, profiles: prof(40) };
    expect(laborCostForJob([e], "J")).toEqual({ hours: 8, cost: 480 , unratedHours: 0, ownerHours: 0 });
  });
  it("a split shift is two entries: each job costs only its own piece (0288)", () => {
    const left = { job_id: "J", status: "closed", clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T09:00:00Z", lunch_minutes: 0, profiles: prof(40) };
    const right = { job_id: "OTHER", status: "closed", clock_in: "2026-06-01T09:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 0, profiles: prof(40) };
    expect(laborCostForJob([left, right], "J")).toEqual({ hours: 1, cost: 40, unratedHours: 0, ownerHours: 0 });
    expect(laborCostForJob([left, right], "OTHER")).toEqual({ hours: 7, cost: 280, unratedHours: 0, ownerHours: 0 });
  });
  it("a job-less Drive piece belongs to no job", () => {
    const drive = { job_id: null, job_code: "DRIVE", status: "closed", clock_in: "2026-06-01T07:00:00Z", clock_out: "2026-06-01T08:00:00Z", lunch_minutes: 0, profiles: prof(40) };
    expect(laborCostForJob([drive], "J")).toEqual({ hours: 0, cost: 0, unratedHours: 0, ownerHours: 0 });
  });
  it("an open entry costs nothing yet", () => {
    const open = { job_id: "J", status: "open", clock_in: "2026-06-01T08:00:00Z", clock_out: null, lunch_minutes: 0, profiles: prof(40) };
    expect(laborCostForJob([open], "J").hours).toBe(0);
  });
});

// --- fixtures ----------------------------------------------------------------
const brian = { id: "b", full_name: "Brian", hourly_rate: 40, bill_rate: 75 };
const erik = { id: "e", full_name: "Erik", hourly_rate: 60, bill_rate: 150 };
const noRate = { id: "n", full_name: "Newbie", hourly_rate: 0, bill_rate: 0 };

/** A closed time entry of `hours` length (minus `lunch` minutes). */
function entry(profiles: any, hours: number, lunch = 0, id?: string) {
  const clock_in = "2026-06-01T08:00:00Z";
  const clock_out = new Date(new Date(clock_in).getTime() + hours * 3_600_000).toISOString();
  return { id, clock_in, clock_out, lunch_minutes: lunch, profiles };
}

describe("computeJobLaborBilling", () => {
  it("returns nothing for an empty job", () => {
    expect(computeJobLaborBilling([], 0)).toEqual({ lines: [], total: 0 });
  });

  it("bills one un-split entry at the bill rate", () => {
    const { lines, total } = computeJobLaborBilling([entry(brian, 8)], 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: "Brian", rate: 75, quantity: 8, amount: 600 });
    expect(total).toBe(600);
  });

  it("prefers bill_rate over hourly_rate", () => {
    const { lines } = computeJobLaborBilling([entry(brian, 1)], 0);
    expect(lines[0].rate).toBe(75); // not 40
  });

  it("rounds quantity to the quarter hour (per person)", () => {
    // 2.6h -> 2.5h billed
    const { lines, total } = computeJobLaborBilling([entry(brian, 2.6)], 0);
    expect(lines[0].quantity).toBe(2.5);
    expect(total).toBe(187.5);
  });

  it("aggregates a person's entries BEFORE rounding (not each entry)", () => {
    // 2.6 + 2.6 = 5.2h -> round to 5.25h, NOT 2.5 + 2.5 = 5.0h
    const { lines } = computeJobLaborBilling([entry(brian, 2.6), entry(brian, 2.6)], 0);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(5.25);
  });

  it("deducts the lunch break", () => {
    const { lines } = computeJobLaborBilling([entry(brian, 8, 30)], 0); // 7.5h
    expect(lines[0].quantity).toBe(7.5);
    expect(lines[0].amount).toBe(562.5);
  });

  it("falls back to the org default rate when a worker has no rate", () => {
    const { lines } = computeJobLaborBilling([entry(noRate, 4)], 50);
    expect(lines[0].rate).toBe(50);
    expect(lines[0].amount).toBe(200);
  });

  it("a split shift's piece on this job bills its own hours, never the whole shift (0288)", () => {
    // Brian's 8h day was cut at 13:00: 5h here, 3h on another job. Only this job's entry is on
    // this job, so only its 5h bill.
    const { lines, total } = computeJobLaborBilling([entry(brian, 5, 0, "piece-here")], 0);
    expect(total).toBe(375);
    expect(lines[0].sourceIds).toEqual(["piece-here"]);
  });

  it("reconciles the Tao scenario (Brian 26.5h@75 + Erik 27h@150 = 6037.50)", () => {
    const { total } = computeJobLaborBilling([entry(brian, 26.5), entry(erik, 27)], 0);
    expect(total).toBe(6037.5);
  });

  it("ignores zero/negative durations", () => {
    const bad = entry(brian, 0);
    expect(computeJobLaborBilling([bad], 0)).toEqual({ lines: [], total: 0 });
  });
});

describe("never the pay rate (audit v994 PL2)", () => {
  const tech = (hourly: number, bill: number | null) => ({ id: "t", full_name: "New Tech", role: "tech", hourly_rate: hourly, bill_rate: bill });
  it("a person with a pay rate and no bill rate bills at the level rate, never the wage", () => {
    const { lines } = computeJobLaborBilling([entry(tech(40, null), 8)], 95, 125);
    expect(lines[0].rate).toBe(125);
    expect(lines[0].rateFrom).toBe("level");
    expect(lines[0].amount).toBe(1000);
  });
  it("with no level rate, the org default: the New Tech scenario is 8 h at $95, not $40", () => {
    const { lines } = computeJobLaborBilling([entry(tech(40, null), 8)], 95, null);
    expect(lines[0].rate).toBe(95);
    expect(lines[0].rateFrom).toBe("default");
  });
  it("a pay rate ABOVE the default is not a bill rate either", () => {
    const { lines } = computeJobLaborBilling([entry(tech(140, null), 2)], 95, null);
    expect(lines[0].rate).toBe(95);
  });
  it("nothing to fall back to is $0 and says so (rateFrom none), never the wage", () => {
    const { lines } = computeJobLaborBilling([entry(tech(40, null), 8)], 0, null);
    expect(lines[0].rate).toBe(0);
    expect(lines[0].rateFrom).toBe("none");
  });
  it("a real bill rate is still the person's own, under the level ceiling", () => {
    const own = computeJobLaborBilling([entry(tech(40, 85), 8)], 95, 125).lines[0];
    expect(own.rate).toBe(85);
    expect(own.rateFrom).toBe("bill_rate");
    const capped = computeJobLaborBilling([entry(tech(40, 150), 8)], 95, 125).lines[0];
    expect(capped.rate).toBe(125);
    expect(capped.rateFrom).toBe("bill_rate");
  });
  it("the owner is billed at his figure: payViewRow folds it into bill_rate, as profile_pay does", () => {
    const owner = { ...payViewRow({ id: "o", role: "owner", hourly_rate: 150, bill_rate: null }), full_name: "Erik" };
    const { lines } = computeJobLaborBilling([entry(owner, 2)], 95, null);
    expect(lines[0].rate).toBe(150);
    expect(lines[0].rateFrom).toBe("bill_rate");
  });
  it("the office is told, one sentence per person, with the rate used and where to fix it", () => {
    const lv = computeJobLaborBilling([entry(tech(40, null), 8)], 95, 125).lines;
    expect(noBillRateWarnings(lv)).toEqual([
      "No bill rate set for New Tech - billed at this customer's level rate, $125.00 an hour. Set one on the Team page",
    ]);
    const df = computeJobLaborBilling([entry(tech(40, null), 8)], 95, null).lines;
    expect(noBillRateWarnings(df)[0]).toContain("your default labor rate, $95.00 an hour");
    const none = computeJobLaborBilling([entry(tech(40, null), 8)], 0, null).lines;
    expect(noBillRateWarnings(none)[0]).toContain("at $0");
    const rated = computeJobLaborBilling([entry(tech(40, 85), 8)], 95, null).lines;
    expect(noBillRateWarnings(rated)).toEqual([]);
    for (const w of [...noBillRateWarnings(lv), ...noBillRateWarnings(df), ...noBillRateWarnings(none)]) expect(w).not.toContain("40");
  });
});

describe("pricing-level labor rate override", () => {
  const prof = (name: string, bill: number) => ({ id: name, full_name: name, bill_rate: bill, hourly_rate: 50 });
  const worked = (p: any, hours: number) => entry(p, hours);
  it("level rate is a CEILING: above drops to it, below keeps their own", () => {
    const r = computeJobLaborBilling([worked(prof("Erik", 150), 10), worked(prof("Brian", 95), 4)], 0, 125);
    const byName = Object.fromEntries(r.lines.map((l) => [l.name, l.rate]));
    expect(byName.Erik).toBe(125);
    expect(byName.Brian).toBe(95);
    expect(r.total).toBe(10 * 125 + 4 * 95);
  });
  it("no personal rate → level rate directly", () => {
    const r = computeJobLaborBilling([worked({ id: "x", full_name: "New Guy" }, 8)], 90, 125);
    expect(r.lines[0].rate).toBe(125);
  });
  it("absent/zero level keeps per-person bill rates", () => {
    const r = computeJobLaborBilling([worked(prof("Erik", 150), 10)], 0, null);
    expect(r.lines[0].rate).toBe(150);
    const r0 = computeJobLaborBilling([worked(prof("Erik", 150), 10)], 0, 0);
    expect(r0.lines[0].rate).toBe(150);
  });
});

/**
 * NON-BILLABLE CODES — the checkbox that did nothing (audit 6).
 *
 * job_codes.billable was set in Settings, badged "non-billable" in the picker, and read by nothing
 * in the billing math. Every org ships with SHOP and PTO already marked false (migration 0004:467),
 * so the precondition was live on all three tenants from day one.
 *
 * The SECOND describe block is the more important one: the obvious fix — "skip any hour that has a
 * code" — would have unbilled the entire labor book, because every ordinary punch carries SVC or
 * ROUGH or TRIM. These tests exist so nobody ever ships that.
 */
describe("non-billable job codes are not billed to the customer", () => {
  const brianRate = { id: "b", full_name: "Brian", bill_rate: 95 };
  const NON_BILLABLE = new Set(["SHOP", "PTO"]);
  const punch = (hours: number, job_code?: string) => ({
    clock_in: "2026-08-01T08:00:00Z",
    clock_out: new Date(Date.parse("2026-08-01T08:00:00Z") + hours * 3_600_000).toISOString(),
    lunch_minutes: 0,
    job_code,
    profiles: brianRate,
  });

  it("an un-split punch coded SHOP bills nothing — the everyday one-tap clock-out", () => {
    expect(computeJobLaborBilling([punch(8, "SHOP")], 0, null, NON_BILLABLE).total).toBe(0);
  });

  it("PTO on a job bills nothing", () => {
    expect(computeJobLaborBilling([punch(8, "PTO")], 0, null, NON_BILLABLE).total).toBe(0);
  });

  it("mixed day cut into pieces: the TRIM piece bills, the SHOP piece does not", () => {
    expect(computeJobLaborBilling([punch(6, "TRIM"), punch(2, "SHOP")], 0, null, NON_BILLABLE).total).toBe(6 * 95);
  });
});

describe("…and EVERY ordinary coded hour still bills — the regression the obvious fix would cause", () => {
  const brianRate = { id: "b", full_name: "Brian", bill_rate: 95 };
  const NON_BILLABLE = new Set(["SHOP", "PTO"]);
  const punch = (hours: number, job_code?: string) => ({
    clock_in: "2026-08-01T08:00:00Z",
    clock_out: new Date(Date.parse("2026-08-01T08:00:00Z") + hours * 3_600_000).toISOString(),
    lunch_minutes: 0,
    job_code,
    profiles: brianRate,
  });

  it.each(["SVC", "ROUGH", "TRIM", "PANEL", "TRAVEL"])("a punch coded %s bills in full", (code) => {
    expect(computeJobLaborBilling([punch(8, code)], 0, null, NON_BILLABLE).total).toBe(8 * 95);
  });

  it("an uncoded punch bills in full", () => {
    expect(computeJobLaborBilling([punch(8)], 0, null, NON_BILLABLE).total).toBe(8 * 95);
  });

  it("an EMPTY non-billable set bills everything — the safe default for any caller without the codes", () => {
    expect(computeJobLaborBilling([punch(8, "SHOP")], 0).total).toBe(8 * 95);
    expect(computeJobLaborBilling([punch(8, "SHOP")], 0, null, new Set()).total).toBe(8 * 95);
  });

  it("the code test is exact — 'shop' lowercase is a different code and still bills", () => {
    expect(computeJobLaborBilling([punch(8, "shop")], 0, null, NON_BILLABLE).total).toBe(8 * 95);
  });
});

describe("laborCostForJob — unrated hours are reported, never swallowed (v800 audit)", () => {
  // A worker with no hourly_rate and no fallback used to cost $0/hr, so their labor vanished
  // from job profit entirely and a labor-only job read as PURE PROFIT. The cost still cannot be
  // invented — that is the office's number — but the hours it could not price come back too.
  it("counts the hours and flags them as unpriced when the person has no rate", () => {
    const e = {
      job_id: "J",
      status: "closed",
      clock_in: "2026-05-01T15:00:00Z",
      clock_out: "2026-05-01T23:00:00Z",
      lunch_minutes: 0,
      profiles: { id: "p1", full_name: "New Hire", hourly_rate: null },
    };
    expect(laborCostForJob([e], "J")).toEqual({ hours: 8, cost: 0, unratedHours: 8, ownerHours: 0 });
  });

  it("an explicit fallback rate prices them, and nothing is left unrated", () => {
    const e = {
      job_id: "J",
      status: "closed",
      clock_in: "2026-05-01T15:00:00Z",
      clock_out: "2026-05-01T23:00:00Z",
      lunch_minutes: 0,
      profiles: { id: "p1", full_name: "New Hire", hourly_rate: null },
    };
    expect(laborCostForJob([e], "J", 40)).toEqual({ hours: 8, cost: 320, unratedHours: 0, ownerHours: 0 });
  });
});

/**
 * THE CLAIM (0255). A labor line carries the entry ids it bills, and a second invoice on the job
 * imports only the rows nobody holds. A split shift is ordinary entries now (0288): a piece that
 * carries hours an invoice already bills carries that claim by its own id (split_time_entry appends
 * it), so the filter is by entry id and nothing else.
 */
describe("labor lines claim their hours (0255)", () => {
  const brianP = { id: "b", full_name: "Brian", bill_rate: 75 };
  const erikP = { id: "e", full_name: "Erik", bill_rate: 111 };
  const punch = (id: string, profiles: any, hours: number, job_code?: string) => ({
    id,
    clock_in: "2026-09-10T18:05:00Z",
    clock_out: new Date(Date.parse("2026-09-10T18:05:00Z") + hours * 3_600_000).toISOString(),
    lunch_minutes: 0,
    job_code,
    profiles,
  });

  it("folds each entry id into the person's line — one claim per row billed", () => {
    const { lines } = computeJobLaborBilling([punch("e1", brianP, 8), punch("e2", brianP, 5.22)], 0);
    expect(lines).toHaveLength(1);
    expect(lines[0].sourceIds).toEqual(["e1", "e2"]);
    expect(lines[0].quantity).toBe(13.25);
  });

  it("a row that bills nothing claims nothing (an unbillable SHOP piece)", () => {
    const { lines } = computeJobLaborBilling([punch("e1", brianP, 3, "SHOP")], 0, null, new Set(["SHOP"]));
    expect(lines).toEqual([]);
  });

  it("withoutClaimedLabor: the 85 Whitney case — INV-061 holds nine entries, Brian's 09-10 entry stays free", () => {
    const held = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"];
    const entries = [...held.map((id, i) => punch(id, i % 2 ? brianP : erikP, 8)), punch("e10", brianP, 5.22)];
    const free = withoutClaimedLabor(entries, new Set(held));
    expect(free.jobEntries.map((e) => e.id)).toEqual(["e10"]);
    expect(free.skippedIds).toEqual(held);
    const { lines, total } = computeJobLaborBilling(free.jobEntries, 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: "Brian", quantity: 5.25, amount: 393.75, sourceIds: ["e10"] });
    expect(total).toBe(393.75);
  });

  it("withoutClaimedLabor: a billed shift split on its own job stays billed — both pieces carry the claim", () => {
    // split_time_entry appended the new piece's id to the line that held the shift, so both ids are
    // claimed and neither piece reads as new work.
    const free = withoutClaimedLabor([punch("left", brianP, 4.5), punch("right", brianP, 1)], new Set(["left", "right"]));
    expect(free.jobEntries).toEqual([]);
    expect(computeJobLaborBilling(free.jobEntries, 0).total).toBe(0);
  });

  it("withoutClaimedLabor: nothing claimed → the rows pass through untouched (the first invoice on a job)", () => {
    const entries = [punch("e1", brianP, 8)];
    const free = withoutClaimedLabor(entries, new Set());
    expect(free.jobEntries).toEqual(entries);
    expect(free.skippedIds).toEqual([]);
  });
});

/**
 * THE OWNER IS PAID BY DRAW (0286). Erik bills his own hours at $125 and the app ALSO costed them
 * at $125, so every hour he worked netted $0 and all-time job profit read -$1,085 instead of about
 * +$35,847. The view now reads his hourly_rate as 0 and carries paid_by_draw; these pin what every
 * cost reader does with that, and that billing did not move by a cent.
 */
describe("the owner's hours are hours, never a cost (0286)", () => {
  // Exactly what profile_pay hands back for Erik after 0286: pay 0, bill kept, the flag set.
  const erikDraw = { id: "e", full_name: "Erik Taylor", hourly_rate: 0, bill_rate: 125, paid_by_draw: true };
  const brianCrew = { id: "b", full_name: "Brian Taylor", hourly_rate: 40, bill_rate: 85, paid_by_draw: false };
  const shift = (profiles: any, extra: Record<string, unknown> = {}) => ({
    id: `${profiles.id}-1`,
    job_id: "J",
    status: "closed",
    clock_in: "2026-06-01T15:00:00Z",
    clock_out: "2026-06-01T23:00:00Z",
    lunch_minutes: 0,
    profiles,
    ...extra,
  });

  it("an owner's 8 hours cost $0, count as hours and as owner hours, and are never unrated", () => {
    expect(laborCostForJob([shift(erikDraw)], "J")).toEqual({ hours: 8, cost: 0, unratedHours: 0, ownerHours: 8 });
  });

  it("even a leftover rate_override on the owner's shift costs nothing", () => {
    expect(laborCostForJob([shift(erikDraw, { rate_override: 125 })], "J")).toEqual({ hours: 8, cost: 0, unratedHours: 0, ownerHours: 8 });
  });

  it("a fallback rate never prices the owner either", () => {
    expect(laborCostForJob([shift(erikDraw)], "J", 125)).toEqual({ hours: 8, cost: 0, unratedHours: 0, ownerHours: 8 });
  });

  it("split shifts: each of the owner's pieces lands in ownerHours on its own job", () => {
    const here = shift(erikDraw, { clock_out: "2026-06-01T18:00:00Z" });
    const there = shift(erikDraw, { job_id: "K", clock_in: "2026-06-01T18:00:00Z" });
    expect(laborCostForJob([here, there], "J")).toEqual({ hours: 3, cost: 0, unratedHours: 0, ownerHours: 3 });
    expect(laborCostForJob([here, there], "K")).toEqual({ hours: 5, cost: 0, unratedHours: 0, ownerHours: 5 });
  });

  it("a crew member beside him is costed exactly as before", () => {
    expect(laborCostForJob([shift(erikDraw), shift(brianCrew)], "J")).toEqual({ hours: 16, cost: 320, unratedHours: 0, ownerHours: 8 });
  });

  it("a row without the flag still costs whatever the view says, so the view is the boundary", () => {
    // A reader that never heard of paid_by_draw gets hourly_rate 0 from the view: $0, just unflagged.
    const legacy = { id: "e", full_name: "Erik Taylor", hourly_rate: 0, bill_rate: 125 };
    expect(laborCostForJob([shift(legacy)], "J").cost).toBe(0);
  });

  it("billing is unchanged: the owner still bills at his $125 bill rate, the crew at theirs", () => {
    const e1 = { ...entry(erikDraw, 8), id: "e1" };
    const e2 = { ...entry(brianCrew, 8), id: "b1" };
    const { lines, total } = computeJobLaborBilling([e1, e2], 0);
    expect(lines.find((l) => l.personId === "e")).toMatchObject({ rate: 125, quantity: 8, amount: 1000 });
    expect(lines.find((l) => l.personId === "b")).toMatchObject({ rate: 85, quantity: 8, amount: 680 });
    expect(total).toBe(1680);
  });

  it("the same owner hours bill $125 and cost $0 on one job: the whole $1,000 is left, not $0", () => {
    const e = { ...shift(erikDraw), id: "e1" };
    const billed = computeJobLaborBilling([e], 0).total;
    const cost = laborCostForJob([e], "J").cost;
    expect(billed - cost).toBe(1000);
  });
});
