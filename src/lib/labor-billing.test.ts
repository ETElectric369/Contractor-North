import { describe, it, expect } from "vitest";
import { computeJobLaborBilling, laborCostForJob } from "@/lib/labor-billing";

describe("laborCostForJob — allocation-aware pay cost (job hub == analytics)", () => {
  const prof = (hourly: number) => ({ hourly_rate: hourly });
  it("un-split closed entry on the job: gross hours × pay rate", () => {
    const e = { job_id: "J", status: "closed", clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 0, profiles: prof(40) };
    expect(laborCostForJob([e], "J")).toEqual({ hours: 8, cost: 320 });
  });
  it("honors rate_override (supervisor rate) over the base", () => {
    const e = { job_id: "J", status: "closed", clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 0, rate_override: 60, profiles: prof(40) };
    expect(laborCostForJob([e], "J")).toEqual({ hours: 8, cost: 480 });
  });
  it("a split shift costs ONLY this job's allocated hours, not the whole day", () => {
    const e = { job_id: "J", status: "closed", clock_in: "2026-06-01T08:00:00Z", clock_out: "2026-06-01T16:00:00Z", lunch_minutes: 0, profiles: prof(40),
      time_allocations: [{ job_id: "J", hours: 1 }, { job_id: "OTHER", hours: 7 }] };
    expect(laborCostForJob([e], "J")).toEqual({ hours: 1, cost: 40 });
    expect(laborCostForJob([e], "OTHER")).toEqual({ hours: 7, cost: 280 });
  });
  it("unlabeled allocation rows count toward the entry's own job", () => {
    const e = { job_id: "J", status: "closed", profiles: prof(50), time_allocations: [{ job_id: null, hours: 2 }] };
    expect(laborCostForJob([e], "J")).toEqual({ hours: 2, cost: 100 });
  });
});

// --- fixtures ----------------------------------------------------------------
const brian = { id: "b", full_name: "Brian", hourly_rate: 40, bill_rate: 75 };
const erik = { id: "e", full_name: "Erik", hourly_rate: 60, bill_rate: 150 };
const noRate = { id: "n", full_name: "Newbie", hourly_rate: 0, bill_rate: 0 };

/** A closed time entry of `hours` length (minus `lunch` minutes). */
function entry(profiles: any, hours: number, lunch = 0, time_allocations: any[] = []) {
  const clock_in = "2026-06-01T08:00:00Z";
  const clock_out = new Date(new Date(clock_in).getTime() + hours * 3_600_000).toISOString();
  return { clock_in, clock_out, lunch_minutes: lunch, profiles, time_allocations };
}
/** A time-allocation of `hours` tagged to this job (from any shift). */
function alloc(profiles: any, hours: number, id?: string) {
  return { id, hours, time_entries: { profiles } };
}

describe("computeJobLaborBilling", () => {
  it("returns nothing for an empty job", () => {
    expect(computeJobLaborBilling([], [], 0)).toEqual({ lines: [], total: 0 });
  });

  it("bills one un-split entry at the bill rate", () => {
    const { lines, total } = computeJobLaborBilling([entry(brian, 8)], [], 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: "Brian", rate: 75, quantity: 8, amount: 600 });
    expect(total).toBe(600);
  });

  it("prefers bill_rate over hourly_rate", () => {
    const { lines } = computeJobLaborBilling([entry(brian, 1)], [], 0);
    expect(lines[0].rate).toBe(75); // not 40
  });

  it("rounds quantity to the quarter hour (per person)", () => {
    // 2.6h -> 2.5h billed
    const { lines, total } = computeJobLaborBilling([entry(brian, 2.6)], [], 0);
    expect(lines[0].quantity).toBe(2.5);
    expect(total).toBe(187.5);
  });

  it("aggregates a person's entries BEFORE rounding (not each entry)", () => {
    // 2.6 + 2.6 = 5.2h -> round to 5.25h, NOT 2.5 + 2.5 = 5.0h
    const { lines } = computeJobLaborBilling([entry(brian, 2.6), entry(brian, 2.6)], [], 0);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(5.25);
  });

  it("deducts the lunch break", () => {
    const { lines } = computeJobLaborBilling([entry(brian, 8, 30)], [], 0); // 7.5h
    expect(lines[0].quantity).toBe(7.5);
    expect(lines[0].amount).toBe(562.5);
  });

  it("falls back to the org default rate when a worker has no rate", () => {
    const { lines } = computeJobLaborBilling([entry(noRate, 4)], [], 50);
    expect(lines[0].rate).toBe(50);
    expect(lines[0].amount).toBe(200);
  });

  it("counts time allocated to this job from another shift (cross-job)", () => {
    const { lines, total } = computeJobLaborBilling([], [alloc(brian, 5)], 0);
    expect(lines[0]).toMatchObject({ name: "Brian", quantity: 5, amount: 375 });
    expect(total).toBe(375);
  });

  it("a LABELED split: only the labeled hours from jobAllocs bill, not the gross shift", () => {
    // Brian clocked 8h and split it — 5h to this job (labeled), the rest elsewhere. The
    // labeled row arrives via jobAllocs; the entry's own rows are all labeled, so nothing
    // extra bills off the entry.
    const split = entry(brian, 8, 0, [
      { id: "a1", job_id: "J", hours: 5 },
      { id: "a2", job_id: "OTHER", hours: 3 },
    ]);
    const { lines, total } = computeJobLaborBilling([split], [alloc(brian, 5, "a1")], 0);
    expect(total).toBe(375); // 5h × 75, NOT 8h + 5h and NOT the OTHER 3h
    expect(lines).toHaveLength(1);
  });

  // ── the silent-unbilled-week fix ────────────────────────────────────────────
  // A job-less clock-out writes ONE allocation row: hours=8, job_id=NULL. Later the
  // office assigns the entry to a job. laborCostForJob COSTS those 8h to the job; the
  // bill side used to skip the entry entirely (it "has allocations") and return $0.
  it("bills the UNLABELED allocation row on this job's entry (was silently unbilled)", () => {
    const punch = entry(brian, 8, 0, [{ id: "a1", job_id: null, hours: 8 }]);
    const { lines, total } = computeJobLaborBilling([punch], [], 0);
    expect(total).toBe(600); // 8h × 75 — matches what the job hub costs, no longer $0
    expect(lines).toHaveLength(1);
  });

  it("bills a MIX of labeled + unlabeled rows on one entry without double-counting", () => {
    // Brian's shift: 5h labeled to this job (via jobAllocs) + 2h that were never labeled.
    // Both are costed to the job, so both must bill: 7h total.
    const e = entry(brian, 8, 0, [
      { id: "a1", job_id: "J", hours: 5 },
      { id: "a2", job_id: null, hours: 2 },
    ]);
    const { total } = computeJobLaborBilling([e], [alloc(brian, 5, "a1")], 0);
    expect(total).toBe(525); // (5 + 2) × 75 — the labeled row is not counted twice
  });

  it("does not bill a row labeled to ANOTHER job that sits on this job's entry", () => {
    const e = entry(brian, 8, 0, [{ id: "a1", job_id: "OTHER", hours: 8 }]);
    const { total } = computeJobLaborBilling([e], [], 0);
    expect(total).toBe(0);
  });

  it("reconciles the Tao scenario (Brian 26.5h@75 + Erik 27h@150 = 6037.50)", () => {
    const { total } = computeJobLaborBilling(
      [],
      [alloc(brian, 26.5), alloc(erik, 27)],
      0,
    );
    expect(total).toBe(6037.5);
  });

  it("ignores zero/negative durations", () => {
    const bad = entry(brian, 0);
    expect(computeJobLaborBilling([bad], [], 0)).toEqual({ lines: [], total: 0 });
  });
});

describe("pricing-level labor rate override", () => {
  const prof = (name: string, bill: number) => ({ id: name, full_name: name, bill_rate: bill, hourly_rate: 50 });
  const alloc = (p: any, hours: number, id = Math.random().toString()) => ({ id, hours, time_entries: { status: "closed", profiles: p } });
  it("level rate is a CEILING: above drops to it, below keeps their own", () => {
    const r = computeJobLaborBilling([], [alloc(prof("Erik", 150), 10), alloc(prof("Brian", 95), 4)], 0, 125);
    const byName = Object.fromEntries(r.lines.map((l) => [l.name, l.rate]));
    expect(byName.Erik).toBe(125);
    expect(byName.Brian).toBe(95);
    expect(r.total).toBe(10 * 125 + 4 * 95);
  });
  it("no personal rate → level rate directly", () => {
    const r = computeJobLaborBilling([], [alloc({ id: "x", full_name: "New Guy" }, 8)], 90, 125);
    expect(r.lines[0].rate).toBe(125);
  });
  it("absent/zero level keeps per-person bill rates", () => {
    const r = computeJobLaborBilling([], [alloc(prof("Erik", 150), 10)], 0, null);
    expect(r.lines[0].rate).toBe(150);
    const r0 = computeJobLaborBilling([], [alloc(prof("Erik", 150), 10)], 0, 0);
    expect(r0.lines[0].rate).toBe(150);
  });
});

describe("time-code parts are paid but NEVER billed (cn-v560)", () => {
  // The timecard editor's "break this shift into parts" writes a Drive/Shop part as
  // {job_id: null, job_code: "DRIVE"} and tells the user "paid, not billed". A code row
  // and a genuinely-unlabeled row both carry job_id NULL, so the biller has to key on
  // job_code — otherwise the customer pays for the crew's drive time.
  const brian = { id: "b", full_name: "Brian", bill_rate: 95, hourly_rate: 55 };
  const splitEntry = (parts: { job_id?: string | null; job_code?: string | null; hours: number }[]) => ({
    clock_in: "2026-07-20T14:00:00Z",
    clock_out: "2026-07-20T22:00:00Z",
    lunch_minutes: 0,
    profiles: brian,
    time_allocations: parts.map((p, i) => ({ id: `a${i}`, job_id: p.job_id ?? null, job_code: p.job_code ?? null, hours: p.hours })),
  });

  it("a DRIVE part on a job-attached entry is not billed", () => {
    // 8h shift on Job X split 6h job / 2h drive → bill 6h, not 8h.
    const r = computeJobLaborBilling([splitEntry([{ job_id: "X", hours: 6 }, { job_code: "DRIVE", hours: 2 }])], [{ id: "a0", hours: 6, time_entries: { status: "closed", profiles: brian } }], 0);
    expect(r.lines[0].quantity).toBe(6);
    expect(r.total).toBe(6 * 95);
  });

  it("genuinely unlabeled hours are still billed to the entry's job", () => {
    const r = computeJobLaborBilling([splitEntry([{ hours: 3 }])], [], 0);
    expect(r.lines[0].quantity).toBe(3);
  });

  it("an all-code shift bills nothing", () => {
    const r = computeJobLaborBilling([splitEntry([{ job_code: "SHOP", hours: 8 }])], [], 0);
    expect(r).toEqual({ lines: [], total: 0 });
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
    time_allocations: [],
  });

  it("an un-split punch coded SHOP bills nothing — the everyday one-tap clock-out", () => {
    expect(computeJobLaborBilling([punch(8, "SHOP")], [], 0, null, NON_BILLABLE).total).toBe(0);
  });

  it("PTO on a job bills nothing", () => {
    expect(computeJobLaborBilling([punch(8, "PTO")], [], 0, null, NON_BILLABLE).total).toBe(0);
  });

  it("an allocation carrying BOTH a job and a non-billable code is skipped", () => {
    // switchJob and the clock-out breakdown both write this shape.
    const allocs = [{ id: "a1", hours: 2, job_code: "SHOP", time_entries: { status: "closed", profiles: brianRate } }];
    expect(computeJobLaborBilling([], allocs, 0, null, NON_BILLABLE).total).toBe(0);
  });

  it("mixed shift: the billable part bills, the shop part does not", () => {
    const allocs = [
      { id: "a1", hours: 6, job_code: "TRIM", time_entries: { status: "closed", profiles: brianRate } },
      { id: "a2", hours: 2, job_code: "SHOP", time_entries: { status: "closed", profiles: brianRate } },
    ];
    expect(computeJobLaborBilling([], allocs, 0, null, NON_BILLABLE).total).toBe(6 * 95);
  });

  it("a skipped allocation is still DEDUPED, or path 2 bills it right back as unlabeled", () => {
    const entry = { ...punch(8), time_allocations: [{ id: "a2", hours: 2 }] };
    const allocs = [{ id: "a2", hours: 2, job_code: "SHOP", time_entries: { status: "closed", profiles: brianRate } }];
    expect(computeJobLaborBilling([entry], allocs, 0, null, NON_BILLABLE).total).toBe(0);
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
    time_allocations: [],
  });

  it.each(["SVC", "ROUGH", "TRIM", "PANEL", "TRAVEL"])("a punch coded %s bills in full", (code) => {
    expect(computeJobLaborBilling([punch(8, code)], [], 0, null, NON_BILLABLE).total).toBe(8 * 95);
  });

  it("an uncoded punch bills in full", () => {
    expect(computeJobLaborBilling([punch(8)], [], 0, null, NON_BILLABLE).total).toBe(8 * 95);
  });

  it("an EMPTY non-billable set bills everything — the safe default for any caller without the codes", () => {
    expect(computeJobLaborBilling([punch(8, "SHOP")], [], 0).total).toBe(8 * 95);
    expect(computeJobLaborBilling([punch(8, "SHOP")], [], 0, null, new Set()).total).toBe(8 * 95);
  });

  it("the code test is exact — 'shop' lowercase is a different code and still bills", () => {
    expect(computeJobLaborBilling([punch(8, "shop")], [], 0, null, NON_BILLABLE).total).toBe(8 * 95);
  });
});
