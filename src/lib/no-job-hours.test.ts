import { describe, it, expect } from "vitest";
import { NO_JOB_READ_CAP, companyTimeCode, noJobShiftsFrom, notCompanyTimeFilter, readNoJobHours, type NoJobRow } from "@/lib/no-job-hours";
import { noJobAdvice, noJobHoursActionItem, NO_JOB_HOURS_HREF } from "@/lib/action-items/no-job-hours-item";

/**
 * HOURS ON NO JOB (the duplicate punches, 2026-09-26): a shift nobody put on a job stays findable
 * until a person puts it on one or files it as company time. The old Needs You line dropped it
 * after three days; Brian's 9/11 punch was gone by 9/14 and typed again on 9/19.
 */
const TZ = "America/Los_Angeles";
const TODAY = "2026-09-26";
const row = (over: Partial<NoJobRow> = {}): NoJobRow => ({
  id: "e1",
  profile_id: "brian",
  // Brian's 9/11 app punch, 10:31 AM to 6:57 PM Pacific.
  clock_in: "2026-09-11T17:31:00Z",
  clock_out: "2026-09-12T01:57:00Z",
  lunch_minutes: 0,
  job_code: null,
  profiles: { full_name: "Brian Taylor" },
  ...over,
});
const opts = (o: Partial<Parameters<typeof noJobShiftsFrom>[1]> = {}) => ({
  nonBillableCodes: new Set<string>(["SHOP", "PTO"]),
  claimed: new Set<string>(),
  todayStr: TODAY,
  tz: TZ,
  ...o,
});

describe("which shifts are still on no job", () => {
  it("keeps a two-week-old punch: no age limit, the org's own day", () => {
    const [s] = noJobShiftsFrom([row()], opts());
    expect(s).toMatchObject({ id: "e1", name: "Brian Taylor", hours: 8.43, day: "2026-09-11", jobCode: null });
  });

  it("an evening punch belongs to its Pacific day, not the UTC one", () => {
    // 5 PM to 7 PM Pacific on 9/25 is 00:00-02:00 UTC on 9/26: still yesterday here, so it is listed.
    const [s] = noJobShiftsFrom([row({ clock_in: "2026-09-26T00:00:00Z", clock_out: "2026-09-26T02:00:00Z" })], opts());
    expect(s?.day).toBe("2026-09-25");
  });

  it("leaves out company time, billed hours, zero-hour ghosts and today", () => {
    const rows = [
      row({ id: "shop", job_code: " SHOP " }),
      row({ id: "billed" }),
      row({ id: "ghost", clock_out: "2026-09-11T17:31:00Z", auto_closed_reason: "forgotten" }),
      row({ id: "today", clock_in: "2026-09-26T16:00:00Z", clock_out: "2026-09-26T18:00:00Z" }),
      row({ id: "rough", job_code: "ROUGH" }),
    ];
    const out = noJobShiftsFrom(rows, opts({ claimed: new Set(["billed"]) }));
    // A BILLABLE code with no job is still hours nobody bills.
    expect(out.map((s) => s.id)).toEqual(["rough"]);
    expect(out[0].jobCode).toBe("ROUGH");
  });

  it("the company-time code is SHOP when there is one, else the first non-billable active code", () => {
    expect(companyTimeCode([{ code: "PTO", billable: false }, { code: "SHOP", billable: false }, { code: "SVC", billable: true }])).toBe("SHOP");
    expect(companyTimeCode([{ code: "WARR", billable: false }, { code: "ADMIN", billable: false }])).toBe("ADMIN");
    expect(companyTimeCode([{ code: "SHOP", billable: false, active: false }, { code: "C1", billable: true }])).toBeNull();
    expect(companyTimeCode([])).toBeNull();
  });
});

describe("the Needs You line: one rollup, never one row per shift, never gone after three days", () => {
  it("rolls every shift into one line that opens the Timecards list", () => {
    const shifts = noJobShiftsFrom(
      [
        row({ id: "a" }),
        row({ id: "b", profile_id: "erik", profiles: { full_name: "Erik Taylor" }, clock_in: "2026-07-01T15:00:00Z", clock_out: "2026-07-01T23:00:00Z" }),
      ],
      opts(),
    );
    const item = noJobHoursActionItem({ shifts, hours: 16.43, capped: false, companyCode: "SHOP" });
    expect(item).toMatchObject({ id: "stray-no-job", kind: "time_stray", title: "Hours On No Job · 2", href: NO_JOB_HOURS_HREF, when: null });
    expect(item?.subtitle).toBe("16.4 h from Jul 1 to Sep 11 (Brian, Erik), on no job and no invoice. Put each on its job, or file it as company time.");
    expect(item?.affordances).toEqual(["open"]);
  });

  it("a company with no not-billed code (Tahoe) is never offered company time, only the way to get it", () => {
    const shifts = noJobShiftsFrom([row()], opts({ nonBillableCodes: new Set() }));
    const item = noJobHoursActionItem({ shifts, hours: 8.43, capped: false, companyCode: null });
    expect(item?.subtitle).not.toContain("or file it as company time");
    expect(item?.subtitle).toContain("first add a not-billed code like Shop in Settings");
    expect(noJobAdvice(null)).not.toBe(noJobAdvice("SHOP"));
  });

  it("says 'couldn't check' when the read failed, and nothing when there is nothing", () => {
    expect(noJobHoursActionItem({ shifts: [], hours: 0, capped: false, companyCode: "SHOP" })).toBeNull();
    expect(noJobHoursActionItem(null)).toBeNull();
    expect(noJobHoursActionItem(null, { failed: true })?.title).toBe("Hours On No Job · Couldn't Check");
  });

  it("a capped read says there may be more", () => {
    const shifts = noJobShiftsFrom([row()], opts());
    expect(noJobHoursActionItem({ shifts, hours: 8.43, capped: true, companyCode: "SHOP" })?.title).toBe("Hours On No Job · 1+");
  });

  it("a full cap with nothing listable in it is its own line, never null", () => {
    const item = noJobHoursActionItem({ shifts: [], hours: 0, capped: true, companyCode: "SHOP" });
    expect(item).toMatchObject({ id: "stray-no-job", title: "Hours On No Job · Couldn't List Them All", href: NO_JOB_HOURS_HREF });
    expect(item?.subtitle).toContain(`newest ${NO_JOB_READ_CAP}`);
  });
});

describe("the cap counts only rows that could be listed", () => {
  it("the company's own codes are left out in the query, each one quoted", () => {
    expect(notCompanyTimeFilter(new Set(["SHOP", " PTO "]))).toBe('job_code.is.null,job_code.not.in.("PTO","SHOP")');
    expect(notCompanyTimeFilter(['A,B', 'Say "hi"'])).toBe('job_code.is.null,job_code.not.in.("A,B","Say \\"hi\\"")');
    expect(notCompanyTimeFilter([])).toBeNull();
    expect(notCompanyTimeFilter(["", "  "])).toBeNull();
  });

  it("readNoJobHours reads the codes first and filters the time read with them", async () => {
    const calls: { table: string; ops: [string, unknown[]][] }[] = [];
    const chain = (table: string, result: { data: unknown; error: null }) => {
      const rec = { table, ops: [] as [string, unknown[]][] };
      calls.push(rec);
      const q: Record<string, unknown> = {};
      for (const op of ["select", "eq", "is", "not", "or", "order", "limit", "in"]) {
        q[op] = (...args: unknown[]) => {
          rec.ops.push([op, args]);
          return q;
        };
      }
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
      return q;
    };
    const supabase = {
      from: (table: string) =>
        table === "job_codes"
          ? chain(table, { data: [{ code: "SHOP", active: true }, { code: "PTO", active: true }], error: null })
          : chain(table, { data: [], error: null }),
    };
    const out = await readNoJobHours(supabase as never, { tz: TZ, todayStr: TODAY });
    expect(out).toEqual({ shifts: [], hours: 0, capped: false, companyCode: "SHOP" });
    expect(calls.map((c) => c.table)).toEqual(["job_codes", "time_entries"]);
    const time = calls[1].ops;
    expect(time).toContainEqual(["or", ['job_code.is.null,job_code.not.in.("PTO","SHOP")']]);
    expect(time).toContainEqual(["limit", [NO_JOB_READ_CAP]]);
  });
});
