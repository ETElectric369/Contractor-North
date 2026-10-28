import { describe, it, expect, vi, beforeEach } from "vitest";

/** The billing switch, as readActiveOrgs reads it: ON for the lapse cases below, OFF for the case
 *  that proves nobody is lapsed when there is no Stripe key (cn-v1137: nothing to lapse from). */
const billing = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/stripe", () => ({
  get billingEnabled() {
    return billing.enabled;
  },
}));
import { atLocalHour, readAllOrgs, readActiveOrgs, withBillingColumns } from "./cron-orgs";
import { BILLING_COLUMNS } from "./subscription";
import { todayStrInTz, tzDayOfWeek } from "./tz";

/**
 * EVERY COMPANY, WHOLE, OR A FAILURE; AND THE COMPANY'S OWN HOUR (cn-v1130, the 2026-10-26 deep
 * review's ops layer). The org-wide crons read `organizations` with one bare select (a failed read
 * was an empty run; PostgREST's silent 1,000-row cap would have dropped every company past it) and
 * ran at UTC hours tuned to Pacific summer (the 7 AM text would have moved to 6 AM the Sunday DST
 * ends). readAllOrgs pages by id and throws; atLocalHour judges the instant in the company's zone.
 */

type Page = { data: any[] | null; error: unknown };

/** A PostgREST fake that answers `organizations` by the page's `from`, and records what was asked. */
function fakeOrgs(page: (from: number) => Page) {
  const asked: { table: string; cols: string; order: unknown[]; ranges: [number, number][] }[] = [];
  const client = {
    from(table: string) {
      const q = { table, cols: "", order: [] as unknown[], ranges: [] as [number, number][] };
      asked.push(q);
      const chain: any = {
        select(cols: string) {
          q.cols = cols;
          return chain;
        },
        order(...a: unknown[]) {
          q.order = a;
          return chain;
        },
        range(from: number, to: number) {
          q.ranges.push([from, to]);
          return Promise.resolve(page(from));
        },
      };
      return chain;
    },
  };
  return { client, asked };
}

const A = { id: "a", settings: {} };
const B = { id: "b", settings: {} };
const C = { id: "c", settings: {} };

describe("readAllOrgs", () => {
  it("reads every page by id, advancing by the rows that came back, and is whole only on an empty page", async () => {
    const { client, asked } = fakeOrgs((from) => {
      if (from === 0) return { data: [A, B], error: null };
      if (from === 2) return { data: [C], error: null };
      if (from === 3) return { data: [], error: null };
      throw new Error(`unexpected page from=${from}`);
    });
    await expect(readAllOrgs(client)).resolves.toEqual([A, B, C]);
    expect(asked.map((q) => q.table)).toEqual(["organizations", "organizations", "organizations"]);
    expect(asked.map((q) => q.ranges[0][0])).toEqual([0, 2, 3]);
    // Ordered by the id, or rows could repeat or go missing between pages.
    for (const q of asked) expect(q.order).toEqual(["id"]);
    // The default columns, and a caller's own list, go through as written.
    expect(asked[0].cols).toBe("id, settings");
    const named = fakeOrgs((from) => ({ data: from === 0 ? [{ id: "a", name: "Larkspur", settings: {} }] : [], error: null }));
    await readAllOrgs(named.client, "id, name, settings");
    expect(named.asked[0].cols).toBe("id, name, settings");
  });

  it("a failed read throws, naming the table and the reason: never an empty list", async () => {
    const { client } = fakeOrgs(() => ({ data: null, error: { message: "boom" } }));
    await expect(readAllOrgs(client)).rejects.toThrow("organizations could not be read: boom");
  });

  it("an error object with no message never reads '[object Object]': the sink's own reader words it", async () => {
    const { client } = fakeOrgs(() => ({ data: null, error: { status: 500 } }));
    const err = await readAllOrgs(client).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("[object Object]");
    expect(err!.message).toBe('organizations could not be read: {"status":500}');
    // a real Error and a code-only object read as they do in the sink
    const coded = fakeOrgs(() => ({ data: null, error: { code: "42501" } }));
    await expect(readAllOrgs(coded.client)).rejects.toThrow("organizations could not be read: 42501");
    const thrown = fakeOrgs(() => ({ data: null, error: new Error("connection reset") }));
    await expect(readAllOrgs(thrown.client)).rejects.toThrow("organizations could not be read: connection reset");
  });
});

describe("atLocalHour", () => {
  const PACIFIC = "America/Los_Angeles";
  // Thursday 2026-10-29, Pacific daylight time (UTC-7).
  const thu = (utc: string) => Date.parse(`2026-10-29T${utc}:00Z`);

  it("is true through the whole local hour and false outside it", () => {
    expect(atLocalHour(PACIFIC, 7, thu("14:00"), true)).toBe(true); // 7:00 AM PDT
    expect(atLocalHour(PACIFIC, 7, thu("14:59"), true)).toBe(true); // 7:59 AM PDT
    expect(atLocalHour(PACIFIC, 7, thu("13:00"), true)).toBe(false); // 6:00 AM PDT
    expect(atLocalHour(PACIFIC, 7, thu("15:00"), true)).toBe(false); // 8:00 AM PDT
  });

  it("a Saturday 7 AM is not a weekday morning, but is the hour when weekdays are not asked for", () => {
    const sat = Date.parse("2026-10-31T14:00:00Z"); // Saturday 7:00 AM PDT
    expect(atLocalHour(PACIFIC, 7, sat, true)).toBe(false);
    expect(atLocalHour(PACIFIC, 7, sat)).toBe(true);
  });

  it("follows the company's clock across the fall-back: 7 AM is 15:00 UTC once DST has ended", () => {
    // Monday 2026-11-02, the day after DST ends: Pacific standard time (UTC-8).
    expect(atLocalHour(PACIFIC, 7, Date.parse("2026-11-02T15:00:00Z"), true)).toBe(true); // 7:00 AM PST
    expect(atLocalHour(PACIFIC, 7, Date.parse("2026-11-02T14:00:00Z"), true)).toBe(false); // 6:00 AM PST, the old UTC hour
  });

  /**
   * THE TWO DAYS THE CLOCK CHANGES (cn-v1130, skeptic #34). The texting crons run EVERY hour and a
   * company is handled on the run in its own hour, so the one thing that must hold is: across the
   * local day, the 7 AM nudge and the 6 PM reminder each find exactly ONE run, whether the day has 25
   * hours (fall back) or 23 (spring forward). Swept over every :00 UTC instant whose Pacific calendar
   * date is the day itself, so a run on either side of the change cannot hide a miss or a repeat.
   */
  const hourlyOnLocalDay = (day: string, tz: string): number[] => {
    const out: number[] = [];
    // 48 hourly instants from the day before's UTC midnight cover any local day, either side of UTC.
    const first = Date.parse(`${day}T00:00:00Z`) - 24 * 3_600_000;
    for (let i = 0; i < 72; i++) {
      const at = first + i * 3_600_000;
      if (todayStrInTz(tz, new Date(at)) === day) out.push(at);
    }
    return out;
  };

  it("the fall-back day (2026-11-01, 25 local hours): the 7 AM and the 6 PM each come exactly once", () => {
    const instants = hourlyOnLocalDay("2026-11-01", PACIFIC);
    expect(instants).toHaveLength(25);
    expect(instants.filter((at) => atLocalHour(PACIFIC, 7, at)).length).toBe(1);
    expect(instants.filter((at) => atLocalHour(PACIFIC, 18, at)).length).toBe(1);
    // The repeated 1 AM is the day's one double hour; the nudge's 7 AM is a Sunday, so weekdays-only skips it.
    expect(instants.filter((at) => atLocalHour(PACIFIC, 1, at)).length).toBe(2);
    expect(instants.filter((at) => atLocalHour(PACIFIC, 7, at, true)).length).toBe(0);
    // And it is the right instant: 7 AM is 15:00 UTC once DST has ended, 6 PM is 02:00 UTC the next day.
    expect(instants.find((at) => atLocalHour(PACIFIC, 7, at))).toBe(Date.parse("2026-11-01T15:00:00Z"));
    expect(instants.find((at) => atLocalHour(PACIFIC, 18, at))).toBe(Date.parse("2026-11-02T02:00:00Z"));
  });

  it("the spring-forward day (2027-03-14, 23 local hours): the 7 AM and the 6 PM each come exactly once", () => {
    const instants = hourlyOnLocalDay("2027-03-14", PACIFIC);
    expect(instants).toHaveLength(23);
    expect(instants.filter((at) => atLocalHour(PACIFIC, 7, at)).length).toBe(1);
    expect(instants.filter((at) => atLocalHour(PACIFIC, 18, at)).length).toBe(1);
    // The skipped 2 AM never happens: it is why the crons are hourly and judged by the clock, not a fixed UTC hour.
    expect(instants.filter((at) => atLocalHour(PACIFIC, 2, at)).length).toBe(0);
    expect(instants.find((at) => atLocalHour(PACIFIC, 7, at))).toBe(Date.parse("2027-03-14T14:00:00Z")); // 7:00 AM PDT
    expect(instants.find((at) => atLocalHour(PACIFIC, 18, at))).toBe(Date.parse("2027-03-15T01:00:00Z")); // 6:00 PM PDT
  });

  it("judges another company in its own zone", () => {
    expect(atLocalHour("America/New_York", 7, thu("11:00"), true)).toBe(true); // 7:00 AM EDT
    expect(atLocalHour("America/New_York", 7, thu("14:00"), true)).toBe(false); // 10:00 AM EDT
  });
});

describe("tzDayOfWeek", () => {
  it("is the company's weekday, not the server's UTC one", () => {
    const lateThursday = new Date("2026-10-30T06:59:00Z"); // Thursday 11:59 PM Pacific, already Friday in UTC
    expect(lateThursday.getUTCDay()).toBe(5);
    expect(tzDayOfWeek("America/Los_Angeles", lateThursday)).toBe(4);
    expect(tzDayOfWeek("UTC", lateThursday)).toBe(5);
  });
});

/**
 * THE LAPSE POLICY'S READ (cn-v1137, decision 3): a company whose plan has ended gets no texts, no
 * reminders, no nightly review — the crons that reach on a company's behalf read through
 * readActiveOrgs, which drops the lapsed ones and counts them so the run says so. The filter is
 * accessState (the one rule), so the select must carry the billing columns whatever the caller asked
 * for: withBillingColumns adds only the missing names, once.
 */
describe("readActiveOrgs", () => {
  beforeEach(() => {
    billing.enabled = true;
  });
  const NOW = Date.parse("2026-10-28T17:00:00Z");
  const days = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
  const ACTIVE = { id: "a", settings: {}, subscription_status: "active", trial_ends_at: null, current_period_end: null, comped_until: null };
  const TRIALING = { id: "b", settings: {}, subscription_status: "trialing", trial_ends_at: days(5), current_period_end: null, comped_until: null };
  const COMPED = { id: "c", settings: {}, subscription_status: "canceled", trial_ends_at: null, current_period_end: null, comped_until: days(60) };
  const TRIAL_ENDED = { id: "d", settings: {}, subscription_status: "trialing", trial_ends_at: days(-2), current_period_end: null, comped_until: null };
  const CANCELED = { id: "e", settings: {}, subscription_status: "canceled", trial_ends_at: null, current_period_end: null, comped_until: null };
  const IN_GRACE = { id: "f", settings: {}, subscription_status: "past_due", trial_ends_at: null, current_period_end: days(-1), comped_until: null };

  it("drops a trial that ended and a canceled plan, keeps active, trialing, comped and in-grace, and counts the skipped", async () => {
    const { client, asked } = fakeOrgs((from) => ({ data: from === 0 ? [ACTIVE, TRIALING, COMPED, TRIAL_ENDED, CANCELED, IN_GRACE] : [], error: null }));
    const { rows, lapsedSkipped } = await readActiveOrgs(client, "id, settings", NOW);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "f"]);
    expect(lapsedSkipped).toBe(2);
    // The read carried the billing columns the filter needs, whatever the caller asked for.
    expect(asked[0].cols).toBe("id, settings, subscription_status, trial_ends_at, current_period_end, comped_until");
    for (const q of asked) expect(q.order).toEqual(["id"]);
  });

  it("nothing lapsed: every row kept, zero skipped; nothing at all: empty and zero", async () => {
    const all = fakeOrgs((from) => ({ data: from === 0 ? [ACTIVE, TRIALING] : [], error: null }));
    expect(await readActiveOrgs(all.client, "id, settings", NOW)).toEqual({ rows: [ACTIVE, TRIALING], lapsedSkipped: 0 });
    const none = fakeOrgs(() => ({ data: [], error: null }));
    expect(await readActiveOrgs(none.client, "id, settings", NOW)).toEqual({ rows: [], lapsedSkipped: 0 });
  });

  it("a failed read throws, as readAllOrgs does — never an empty run with zero skipped", async () => {
    const { client } = fakeOrgs(() => ({ data: null, error: { message: "boom" } }));
    await expect(readActiveOrgs(client, "id, settings", NOW)).rejects.toThrow("organizations could not be read: boom");
  });

  it("the caller's own columns go through, the billing columns joined once", async () => {
    const { client, asked } = fakeOrgs((from) => ({ data: from === 0 ? [{ ...ACTIVE, name: "Larkspur Electric" }] : [], error: null }));
    await readActiveOrgs(client, "id, name, settings, trial_ends_at", NOW);
    expect(asked[0].cols).toBe("id, name, settings, trial_ends_at, subscription_status, current_period_end, comped_until");
  });

  it("billing off (no Stripe key): nobody is lapsed — every company is read with the caller's own columns and none is skipped", async () => {
    billing.enabled = false;
    const { client, asked } = fakeOrgs((from) => ({ data: from === 0 ? [ACTIVE, TRIAL_ENDED, CANCELED] : [], error: null }));
    const { rows, lapsedSkipped } = await readActiveOrgs(client, "id, settings", NOW);
    expect(rows.map((r) => r.id)).toEqual(["a", "d", "e"]);
    expect(lapsedSkipped).toBe(0);
    expect(asked[0].cols).toBe("id, settings");
    // And a failed read still throws.
    const failed = fakeOrgs(() => ({ data: null, error: { message: "boom" } }));
    await expect(readActiveOrgs(failed.client, "id, settings", NOW)).rejects.toThrow("organizations could not be read: boom");
  });
});

describe("withBillingColumns", () => {
  it("adds only the missing names, once, and leaves a complete list alone", () => {
    expect(withBillingColumns("id, settings")).toBe("id, settings, subscription_status, trial_ends_at, current_period_end, comped_until");
    expect(withBillingColumns("id, settings, comped_until")).toBe("id, settings, comped_until, subscription_status, trial_ends_at, current_period_end");
    const whole = withBillingColumns("id, settings");
    expect(withBillingColumns(whole)).toBe(whole);
    expect(withBillingColumns(`id, ${BILLING_COLUMNS.join(", ")}`)).toBe(`id, ${BILLING_COLUMNS.join(", ")}`);
  });

  it("adds the id when the caller left it out (the pages are ordered by it), and reads the names however they are spaced", () => {
    expect(withBillingColumns("settings")).toBe("settings, id, subscription_status, trial_ends_at, current_period_end, comped_until");
    expect(withBillingColumns("id,settings,subscription_status ,trial_ends_at")).toBe("id,settings,subscription_status ,trial_ends_at, current_period_end, comped_until");
  });
});
