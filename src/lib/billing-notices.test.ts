import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE BILLING NOTICES (cn-v1137, 0400): the trial's last days, a declined card with the grace window
 * closing, the day a plan ends — to the owner and admins as a bell line and a push under `billing`,
 * and one email. The stamp is the lock: claim_billing_notice is called FIRST and only a TRUE sends;
 * a stamped window is never re-sent; a window the cron missed is skipped, never cascaded; a comped company is
 * never told; with billing off nothing is read; a courtesy lost after the claim is filed with its
 * key and counted, never retried; a failed companies read throws through to the cron.
 */
const spies = vi.hoisted(() => ({
  log: [] as string[],
  notify: vi.fn(),
  email: vi.fn(),
  report: vi.fn(),
  billing: true,
}));
vi.mock("@/lib/notifications", () => ({ notifyPeople: spies.notify }));
vi.mock("@/lib/email", () => ({
  sendEmail: spies.email,
  renderPlatformNoticeEmail: (i: { heading: string; message: string; cta?: { label: string; href: string } }) =>
    `<north>${i.heading}|${i.message}|${i.cta?.label ?? ""}|${i.cta?.href ?? ""}</north>`,
}));
vi.mock("@/lib/stripe", () => ({
  get billingEnabled() {
    return spies.billing;
  },
}));
vi.mock("@/lib/observe", () => ({
  reportError: spies.report,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)),
}));

import {
  dueGraceNotice,
  dueTrialNotice,
  graceNoticeKey,
  LAPSED_KEY,
  NOTICE_URL,
  noticeWords,
  sendBillingNotices,
  trialNoticeKey,
  type NoticeOrg,
} from "./billing-notices";

const ORG = "6f1c2a3e-9b4d-4c5e-8f6a-1b2c3d4e5f60";
const ORG2 = "0a9b8c7d-6e5f-4a3b-9c8d-7e6f5a4b3c21";
const TZ = "America/Los_Angeles";
const DAY = 86_400_000;
/** Monday 2026-11-02, 7 AM Pacific (standard time: the 11-01 change is behind every date here). */
const NOW = Date.parse("2026-11-02T15:00:00Z");
/** Noon Pacific on the day N days from today — the company's own calendar, not a UTC ceiling. */
const noonIn = (days: number) => new Date(Date.parse("2026-11-02T20:00:00Z") + days * DAY).toISOString();

type Profile = { id: string; org_id: string; role: string; active: boolean; email: string | null };
const PEOPLE: Profile[] = [
  { id: "owner-1", org_id: ORG, role: "owner", active: true, email: "snowbell@larkspur.example" },
  { id: "admin-1", org_id: ORG, role: "admin", active: true, email: null },
  { id: "office-1", org_id: ORG, role: "office", active: true, email: "office@larkspur.example" },
  { id: "tech-1", org_id: ORG, role: "tech", active: true, email: null },
  { id: "gone-owner", org_id: ORG, role: "owner", active: false, email: "gone@larkspur.example" },
  { id: "owner-2", org_id: ORG2, role: "owner", active: true, email: "catbird@thistlewood.example" },
];

function org(over: Partial<NoticeOrg> = {}): NoticeOrg {
  return {
    id: ORG,
    name: "Larkspur Electric",
    email: "hello@larkspur.example",
    settings: { timezone: TZ },
    billing_notices: {},
    subscription_status: "trialing",
    trial_ends_at: noonIn(5),
    current_period_end: null,
    comped_until: null,
    ...over,
  };
}

type Q = { table: string; cols: string; calls: [string, unknown[]][] };
type Answer = { data: unknown; error: unknown };

/** A recording service client: every read's chain is kept, the claim is answered by `claim`, and
 *  the order of claim · bell · email lands in the shared log. */
function fakeClient(opts: {
  orgs?: NoticeOrg[] | { error: unknown };
  profiles?: Profile[] | { error: unknown };
  claim?: (orgId: string, key: string) => Answer;
} = {}) {
  const seen: Q[] = [];
  const rpcs: [string, Record<string, unknown>][] = [];
  const answer = (q: Q): Answer => {
    if (q.table === "organizations") {
      if (opts.orgs && !Array.isArray(opts.orgs)) return { data: null, error: opts.orgs.error };
      const range = (q.calls.find(([m]) => m === "range")?.[1] ?? [0, 999]) as [number, number];
      return { data: (opts.orgs ?? []).slice(range[0], range[1] + 1), error: null };
    }
    if (q.table === "profiles") {
      if (opts.profiles && !Array.isArray(opts.profiles)) return { data: null, error: opts.profiles.error };
      const orgId = q.calls.find(([m, a]) => m === "eq" && a[0] === "org_id")?.[1][1];
      const active = q.calls.find(([m, a]) => m === "eq" && a[0] === "active")?.[1][1];
      const roles = (q.calls.find(([m]) => m === "in")?.[1][1] ?? []) as string[];
      const rows = (opts.profiles ?? PEOPLE).filter((p) => p.org_id === orgId && p.active === active && roles.includes(p.role));
      return { data: rows.map(({ id, email, role }) => ({ id, email, role })), error: null };
    }
    throw new Error(`unexpected table ${q.table}`);
  };
  const client = {
    from(table: string) {
      const q: Q = { table, cols: "", calls: [] };
      seen.push(q);
      const b: any = {
        select(cols: string) {
          q.cols = cols;
          return b;
        },
        then(ok: (v: Answer) => unknown, bad?: (e: unknown) => unknown) {
          return Promise.resolve()
            .then(() => answer(q))
            .then(ok, bad);
        },
      };
      for (const m of ["eq", "in", "order", "range"]) {
        b[m] = (...a: unknown[]) => {
          q.calls.push([m, a]);
          return b;
        };
      }
      return b;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push([fn, args]);
      spies.log.push(`claim:${String(args.p_key)}`);
      return (opts.claim ?? (() => ({ data: true, error: null })))(String(args.p_org), String(args.p_key));
    },
  };
  return { client, seen, rpcs };
}

const run = (c: ReturnType<typeof fakeClient>, nowMs = NOW) => sendBillingNotices(c.client, nowMs);
const claims = (c: ReturnType<typeof fakeClient>) => c.rpcs.filter(([fn]) => fn === "claim_billing_notice").map(([, a]) => a);
const quiet = { orgs: 1, due: 0, sent: 0, skipped: { comped: 0 }, failed: 0 };
const told = { orgs: 1, due: 1, sent: 1, skipped: { comped: 0 }, failed: 0 };

beforeEach(() => {
  spies.log.length = 0;
  spies.billing = true;
  spies.notify.mockReset();
  spies.email.mockReset();
  spies.report.mockReset();
  spies.notify.mockImplementation(async (_org: string, ids: string[], _kind: string, n: { title: string }) => {
    spies.log.push(`notify:${n.title}`);
    return { bell: true, pushed: ids };
  });
  spies.email.mockImplementation(async (i: { to: string }) => {
    spies.log.push(`email:${i.to}`);
    return { ok: true };
  });
  vi.unstubAllEnvs();
});

describe("dueTrialNotice: the ONE window the days left are in — the smallest threshold at or above them — sent once, never the windows above it (skeptic #43, S4)", () => {
  it.each([
    [9, {}, null],
    [8, {}, null],
    [7, {}, 7],
    [5, {}, 7],
    [5, { trial_7: "2026-10-31T15:00:00Z" }, null],
    [3, { trial_7: "x" }, 3],
    // Day 3 with nothing stamped is the 3-day window: the 7-day one was missed and stays missed.
    [3, {}, 3],
    [2, { trial_7: "x", trial_3: "x" }, null],
    [2, {}, 3],
    [1, {}, 1],
    [1, { trial_7: "x", trial_3: "x" }, 1],
    [1, { trial_7: "x", trial_3: "x", trial_1: "x" }, null],
    // Its own window stamped: nothing — the old rule fell through to the next unstamped one above.
    [1, { trial_1: "x" }, null],
    [0, {}, 0],
    [0, { trial_7: "x", trial_3: "x", trial_1: "x" }, 0],
    [0, { trial_7: "x", trial_3: "x", trial_1: "x", trial_0: "x" }, null],
    [0, { trial_0: "x" }, null],
  ] as [number, Record<string, unknown>, number | null][])("day %i with %j → %s", (days, stamped, want) => {
    expect(dueTrialNotice(days, stamped)).toBe(want);
  });

  it("no stamps at all (null) reads as nothing stamped; a key stamped null is not stamped", () => {
    expect(dueTrialNotice(5, null)).toBe(7);
    expect(dueTrialNotice(5, undefined)).toBe(7);
    expect(dueTrialNotice(5, { trial_7: null })).toBe(7);
    expect(dueTrialNotice(NaN, {})).toBeNull();
  });

  it("the keys", () => {
    expect(trialNoticeKey(7)).toBe("trial_7");
    expect(trialNoticeKey(0)).toBe("trial_0");
  });
});

describe("dueGraceNotice: the same rule, keyed on the unpaid period's end", () => {
  const END = "2026-10-26T15:00:00.000Z";
  it("3 and 1, each once per period; 0 is the lapse's business; a null period end is keyed 'unknown'", () => {
    expect(dueGraceNotice(10, END, {})).toBeNull();
    expect(dueGraceNotice(4, END, {})).toBeNull();
    expect(dueGraceNotice(3, END, {})).toBe(3);
    expect(dueGraceNotice(2, END, {})).toBe(3);
    expect(dueGraceNotice(2, END, { [`grace_3:${END}`]: "x" })).toBeNull();
    expect(dueGraceNotice(1, END, { [`grace_3:${END}`]: "x" })).toBe(1);
    // One day left with nothing stamped is the 1-day window; the 3-day one was missed and stays missed.
    expect(dueGraceNotice(1, END, {})).toBe(1);
    expect(dueGraceNotice(1, END, { [`grace_1:${END}`]: "x" })).toBeNull();
    expect(dueGraceNotice(0, END, {})).toBeNull();
    // Last year's stamp does not silence this year's card trouble: the key carries the period.
    expect(dueGraceNotice(3, END, { "grace_3:2025-10-26T15:00:00.000Z": "x" })).toBe(3);
    expect(graceNoticeKey(3, END)).toBe(`grace_3:${END}`);
    expect(graceNoticeKey(1, null)).toBe("grace_1:unknown");
  });
});

describe("noticeWords: from the real days left, never the threshold", () => {
  it("trial", () => {
    expect(noticeWords("trial", 7).title).toBe("Your Free Trial Ends In 7 Days");
    expect(noticeWords("trial", 5).title).toBe("Your Free Trial Ends In 5 Days");
    expect(noticeWords("trial", 2).title).toBe("Your Free Trial Ends In 2 Days");
    expect(noticeWords("trial", 1).title).toBe("Your Free Trial Ends Tomorrow");
    expect(noticeWords("trial", 0).title).toBe("Your Free Trial Ends Today");
    expect(noticeWords("trial", 5).body).toBe(
      "Pick a plan in Settings › Getting Paid to keep the crew working. Your customers can still pay you and your data stays yours either way.",
    );
  });
  it("grace", () => {
    expect(noticeWords("grace", 3).title).toBe("Your Card Was Declined — 3 Days Left");
    expect(noticeWords("grace", 1).title).toBe("Your Card Was Declined — 1 Day Left");
    expect(noticeWords("grace", 3).body).toBe("Update the card in Settings › Getting Paid › Manage Billing. The crew keeps working until then.");
  });
  it("lapsed, by its reason", () => {
    expect(noticeWords("lapsed", "trial_ended").title).toBe("Your Free Trial Has Ended");
    expect(noticeWords("lapsed", "grace_spent").title).toBe("Your Card Was Not Updated In Time");
    expect(noticeWords("lapsed", "canceled").title).toBe("Your Subscription Has Ended");
    expect(noticeWords("lapsed", "canceled").body).toBe(
      "Nort, texts and reminders are paused. Your customers can still pay you. Download For Your Accountant stays open. Pick a plan to continue.",
    );
  });
});

describe("the trial notices", () => {
  it("day 5, trial_7 unstamped: one claim of trial_7, the words from the real 5 days, the bell and push to the owner and admins, one email to the company", async () => {
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(5) })] });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "trial_7" }]);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.notify).toHaveBeenCalledWith(ORG, ["owner-1", "admin-1"], "billing", {
      title: "Your Free Trial Ends In 5 Days",
      body: "Pick a plan in Settings › Getting Paid to keep the crew working. Your customers can still pay you and your data stays yours either way.",
      url: NOTICE_URL,
    });
    expect(spies.email).toHaveBeenCalledTimes(1);
    const mail = spies.email.mock.calls[0][0];
    expect(mail.to).toBe("hello@larkspur.example");
    expect(mail.subject).toBe("Your Free Trial Ends In 5 Days");
    expect(mail.fromName).toBeUndefined(); // North itself writes
    expect(mail.html).toContain("<north>Your Free Trial Ends In 5 Days|Pick a plan in Settings");
    expect(mail.html).toContain("|Open Settings|https://contractor-north.vercel.app/settings?tab=getpaid</north>");
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("the email's button carries the app's own address, never a company's site", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.contractornorth.com/");
    const c = fakeClient({ orgs: [org({ settings: { timezone: TZ, custom_domain: "larkspur.example" } })] });
    await run(c);
    expect(spies.email.mock.calls[0][0].html).toContain("|https://app.contractornorth.com/settings?tab=getpaid</north>");
  });

  it("the reply address is the support box when there is one", async () => {
    vi.stubEnv("SUPPORT_EMAIL", "support@north.example");
    await run(fakeClient({ orgs: [org()] }));
    expect(spies.email.mock.calls[0][0].replyTo).toBe("support@north.example");
    spies.email.mockClear();
    vi.stubEnv("SUPPORT_EMAIL", "");
    await run(fakeClient({ orgs: [org()] }));
    expect(spies.email.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("day 5 with trial_7 stamped: nothing claimed, nobody told", async () => {
    const c = fakeClient({ orgs: [org({ billing_notices: { trial_7: "2026-10-31T15:00:00Z" } })] });
    expect(await run(c)).toEqual(quiet);
    expect(c.rpcs).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.email).not.toHaveBeenCalled();
  });

  it("day 3 with trial_7 stamped: trial_3", async () => {
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(3), billing_notices: { trial_7: "x" } })] });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "trial_3" }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Free Trial Ends In 3 Days");
  });

  it("day 1: Tomorrow — under trial_1 whether the earlier doors are stamped or a week was missed", async () => {
    let c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(1), billing_notices: { trial_7: "x", trial_3: "x" } })] });
    await run(c);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "trial_1" }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Free Trial Ends Tomorrow");
    spies.notify.mockClear();
    c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(1) })] });
    await run(c);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "trial_1" }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Free Trial Ends Tomorrow");
  });

  /**
   * THE CASCADE (skeptic #43, S4). The old rule sent "the largest unstamped threshold the days have
   * reached": a company first seen on day 1 was told Tomorrow under trial_7, then — the next run, the
   * same day — Tomorrow again under trial_3, then under trial_1: three notices saying the same thing.
   * Now a window is one key; its stamp ends it; the windows above it are never caught up on.
   */
  it("a company first seen on day 1 is told ONCE across repeated runs, not once per missed window", async () => {
    const o = org({ trial_ends_at: noonIn(1) });
    const stamped: Record<string, string> = {};
    const claim = (_org: string, key: string) => {
      if (stamped[key]) return { data: false, error: null };
      stamped[key] = "x";
      o.billing_notices = { ...stamped }; // the row as the next run reads it
      return { data: true, error: null };
    };
    const c = fakeClient({ orgs: [o], claim });
    expect(await run(c)).toEqual(told);
    expect(await run(c)).toEqual(quiet);
    expect(await run(c)).toEqual(quiet);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "trial_1" }]);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.email).toHaveBeenCalledTimes(1);
    // The next day is its own window, once.
    expect(await run(c, NOW + DAY)).toEqual(told);
    expect(await run(c, NOW + DAY)).toEqual(quiet);
    expect(claims(c).map((a) => a.p_key)).toEqual(["trial_1", "trial_0"]);
  });

  it("day 0 (ends at noon today, 7 AM now): Today, under trial_0", async () => {
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(0), billing_notices: { trial_7: "x", trial_3: "x", trial_1: "x" } })] });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "trial_0" }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Free Trial Ends Today");
  });

  it("day 9: nothing", async () => {
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(9) })] });
    expect(await run(c)).toEqual(quiet);
    expect(c.rpcs).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("the days are the company's own calendar: 11 PM Pacific on day 2 is still 2 days, not the UTC day after", async () => {
    // 2026-11-05 07:00 UTC is 11 PM Pacific on 11-04; the trial ends noon Pacific 11-06: two days.
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(4), billing_notices: { trial_7: "x" } })] });
    await run(c, Date.parse("2026-11-05T07:00:00Z"));
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "trial_3" }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Free Trial Ends In 2 Days");
  });

  it("trialing with no end date: nothing to count down, nothing claimed", async () => {
    const c = fakeClient({ orgs: [org({ trial_ends_at: null })] });
    expect(await run(c)).toEqual(quiet);
    expect(c.rpcs).toEqual([]);
  });
});

describe("the grace notices", () => {
  const periodEnd = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

  it("3 days of grace left: grace_3 keyed on the period's end, the card words", async () => {
    const end = periodEnd(7); // ten days of grace from the period's end: three left
    const c = fakeClient({ orgs: [org({ subscription_status: "past_due", current_period_end: end })] });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: `grace_3:${end}` }]);
    expect(spies.notify).toHaveBeenCalledWith(ORG, ["owner-1", "admin-1"], "billing", {
      title: "Your Card Was Declined — 3 Days Left",
      body: "Update the card in Settings › Getting Paid › Manage Billing. The crew keeps working until then.",
      url: NOTICE_URL,
    });
  });

  it("1 day left: grace_1, with grace_3 stamped or with nothing stamped (the missed window is not caught up on)", async () => {
    const end = periodEnd(9);
    let c = fakeClient({ orgs: [org({ subscription_status: "past_due", current_period_end: end, billing_notices: { [`grace_3:${end}`]: "x" } })] });
    await run(c);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: `grace_1:${end}` }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Card Was Declined — 1 Day Left");
    spies.notify.mockClear();
    c = fakeClient({ orgs: [org({ subscription_status: "past_due", current_period_end: end })] });
    await run(c);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: `grace_1:${end}` }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Card Was Declined — 1 Day Left");
    // And once its window is stamped, repeated runs the same day send nothing more (S4).
    c = fakeClient({ orgs: [org({ subscription_status: "past_due", current_period_end: end, billing_notices: { [`grace_1:${end}`]: "x" } })] });
    expect(await run(c)).toEqual(quiet);
    expect(c.rpcs).toEqual([]);
  });

  it("5 days left: nothing yet; both stamped: nothing", async () => {
    let c = fakeClient({ orgs: [org({ subscription_status: "past_due", current_period_end: periodEnd(5) })] });
    expect(await run(c)).toEqual(quiet);
    const end = periodEnd(9);
    c = fakeClient({ orgs: [org({ subscription_status: "past_due", current_period_end: end, billing_notices: { [`grace_3:${end}`]: "x", [`grace_1:${end}`]: "x" } })] });
    expect(await run(c)).toEqual(quiet);
    expect(c.rpcs).toEqual([]);
  });
});

describe("the lapse notice", () => {
  it("a trial that ended: one claim of 'lapsed', the ended words; the next run's claim answers false and nobody is told again", async () => {
    const stamps = new Set<string>();
    const claim = (orgId: string, key: string) => {
      const k = `${orgId}:${key}`;
      if (stamps.has(k)) return { data: false, error: null };
      stamps.add(k);
      return { data: true, error: null };
    };
    const ended = () => fakeClient({ orgs: [org({ trial_ends_at: noonIn(-1) })], claim });
    let c = ended();
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: LAPSED_KEY }]);
    expect(spies.notify.mock.calls[0][3]).toEqual({
      title: "Your Free Trial Has Ended",
      body: "Nort, texts and reminders are paused. Your customers can still pay you. Download For Your Accountant stays open. Pick a plan to continue.",
      url: NOTICE_URL,
    });
    spies.notify.mockClear();
    spies.email.mockClear();
    c = ended();
    expect(await run(c)).toEqual({ ...quiet, due: 1 }); // due, claimed by a run before this one
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: LAPSED_KEY }]);
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.email).not.toHaveBeenCalled();
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("a 'lapsed' stamp already on the row: nothing claimed", async () => {
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(-1), billing_notices: { lapsed: "x" } })] });
    expect(await run(c)).toEqual(quiet);
    expect(c.rpcs).toEqual([]);
  });

  it("the grace spent, and a canceled plan: each its own words under the one key", async () => {
    let c = fakeClient({ orgs: [org({ subscription_status: "past_due", current_period_end: new Date(NOW - 11 * DAY).toISOString() })] });
    await run(c);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "lapsed" }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Card Was Not Updated In Time");
    spies.notify.mockClear();
    c = fakeClient({ orgs: [org({ subscription_status: "canceled" })] });
    await run(c);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "lapsed" }]);
    expect(spies.notify.mock.calls[0][3].title).toBe("Your Subscription Has Ended");
  });

  it("a company with no subscription state at all (never on Stripe) is not lapsed: nothing", async () => {
    const c = fakeClient({ orgs: [org({ subscription_status: null, trial_ends_at: null })] });
    expect(await run(c)).toEqual(quiet);
    expect(c.rpcs).toEqual([]);
  });

  it("an active plan: nothing", async () => {
    const c = fakeClient({ orgs: [org({ subscription_status: "active", trial_ends_at: noonIn(-30) })] });
    expect(await run(c)).toEqual(quiet);
    expect(c.rpcs).toEqual([]);
  });
});

describe("who is never told", () => {
  it("comped by the column: skipped, nothing claimed, even on the trial's last day", async () => {
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(0), comped_until: new Date(NOW + 30 * DAY).toISOString() })] });
    expect(await run(c)).toEqual({ orgs: 1, due: 0, sent: 0, skipped: { comped: 1 }, failed: 0 });
    expect(c.rpcs).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("comped by the env list: skipped the same way", async () => {
    vi.stubEnv("COMPED_ORG_IDS", `some-other-org, ${ORG.toUpperCase()}`);
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(-1) })] });
    expect(await run(c)).toEqual({ orgs: 1, due: 0, sent: 0, skipped: { comped: 1 }, failed: 0 });
    expect(c.rpcs).toEqual([]);
  });

  it("billing off (no Stripe key): nothing is read, and the run says so", async () => {
    spies.billing = false;
    const c = fakeClient({ orgs: [org({ trial_ends_at: noonIn(-1) })] });
    expect(await run(c)).toEqual({ orgs: 0, due: 0, sent: 0, skipped: { comped: 0, billing_off: true }, failed: 0 });
    expect(c.seen).toEqual([]);
    expect(c.rpcs).toEqual([]);
  });
});

describe("the lock", () => {
  it("the claim happens BEFORE the bell and the email", async () => {
    await run(fakeClient({ orgs: [org()] }));
    expect(spies.log).toEqual(["claim:trial_7", "notify:Your Free Trial Ends In 5 Days", "email:hello@larkspur.example"]);
  });

  it("a claim that errors: failed, nothing sent, filed as cron-billing-notices with the company", async () => {
    const c = fakeClient({ orgs: [org()], claim: () => ({ data: null, error: { message: "function claim_billing_notice does not exist" } }) });
    expect(await run(c)).toEqual({ orgs: 1, due: 1, sent: 0, skipped: { comped: 0 }, failed: 1 });
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.email).not.toHaveBeenCalled();
    expect(spies.report).toHaveBeenCalledTimes(1);
    const [where, err, extra] = spies.report.mock.calls[0];
    expect(where).toBe("cron-billing-notices");
    expect((err as Error).message).toBe("claim_billing_notice trial_7 failed: function claim_billing_notice does not exist");
    expect(extra).toEqual({ orgId: ORG });
  });

  it("a claim that answers nothing (no boolean, no error) is a failure, never a send", async () => {
    const c = fakeClient({ orgs: [org()], claim: () => ({ data: null, error: null }) });
    expect(await run(c)).toEqual({ orgs: 1, due: 1, sent: 0, skipped: { comped: 0 }, failed: 1 });
    expect(spies.notify).not.toHaveBeenCalled();
    expect((spies.report.mock.calls[0][1] as Error).message).toBe("claim_billing_notice trial_7 answered nothing");
  });

  it("one company's failed claim does not stop the next company", async () => {
    const c = fakeClient({
      orgs: [org(), org({ id: ORG2, name: "Thistlewood Decks", email: null, trial_ends_at: noonIn(3) })],
      claim: (orgId) => (orgId === ORG ? { data: null, error: { message: "timeout" } } : { data: true, error: null }),
    });
    expect(await run(c)).toEqual({ orgs: 2, due: 2, sent: 1, skipped: { comped: 0 }, failed: 1 });
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.notify).toHaveBeenCalledWith(ORG2, ["owner-2"], "billing", expect.objectContaining({ title: "Your Free Trial Ends In 3 Days" }));
    expect(spies.email.mock.calls[0][0].to).toBe("catbird@thistlewood.example"); // no company email: the owner's
  });
});

describe("the email's address", () => {
  it("the company's email first; else the active owner's; the office's address is never it", async () => {
    await run(fakeClient({ orgs: [org({ email: "  hello@larkspur.example " })] }));
    expect(spies.email.mock.calls[0][0].to).toBe("hello@larkspur.example");
    spies.email.mockClear();
    await run(fakeClient({ orgs: [org({ email: null })] }));
    expect(spies.email.mock.calls[0][0].to).toBe("snowbell@larkspur.example");
    spies.email.mockClear();
    await run(fakeClient({ orgs: [org({ email: "   " })] }));
    expect(spies.email.mock.calls[0][0].to).toBe("snowbell@larkspur.example");
  });

  it("no company email and no owner address: the bell and push still go, no email, and the run does not call it failed", async () => {
    const people = PEOPLE.map((p) => (p.id === "owner-1" ? { ...p, email: null } : p));
    const c = fakeClient({ orgs: [org({ email: null })], profiles: people });
    expect(await run(c)).toEqual(told);
    expect(spies.notify).toHaveBeenCalledWith(ORG, ["owner-1", "admin-1"], "billing", expect.anything());
    expect(spies.email).not.toHaveBeenCalled();
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("nobody at all — no active owner or admin and no company email — is said and counted, after the claim", async () => {
    const c = fakeClient({ orgs: [org({ email: null })], profiles: PEOPLE.filter((p) => p.org_id !== ORG) });
    expect(await run(c)).toEqual({ orgs: 1, due: 1, sent: 0, skipped: { comped: 0 }, failed: 1 });
    expect(claims(c)).toHaveLength(1);
    expect(spies.report).toHaveBeenCalledWith("billing-notices:send", expect.any(Error), { orgId: ORG, key: "trial_7" });
    expect((spies.report.mock.calls[0][1] as Error).message).toContain("nobody to tell");
  });
});

describe("after the claim, a courtesy lost is filed and counted — never retried", () => {
  it("a thrown sendEmail: failed, the bell and push already went, one row with the key", async () => {
    spies.email.mockRejectedValue(new Error("fetch failed"));
    const c = fakeClient({ orgs: [org()] });
    expect(await run(c)).toEqual({ orgs: 1, due: 1, sent: 0, skipped: { comped: 0 }, failed: 1 });
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "trial_7" }]);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.report).toHaveBeenCalledTimes(1);
    expect(spies.report).toHaveBeenCalledWith("billing-notices:send", expect.any(Error), { orgId: ORG, key: "trial_7" });
    expect((spies.report.mock.calls[0][1] as Error).message).toBe("fetch failed");
  });

  it("an email the mail service refused ({ ok: false }): failed, filed with its words and the key", async () => {
    spies.email.mockResolvedValue({ ok: false, error: "Email failed: 422 unverified sender" });
    const c = fakeClient({ orgs: [org()] });
    expect(await run(c)).toEqual({ orgs: 1, due: 1, sent: 0, skipped: { comped: 0 }, failed: 1 });
    expect(spies.report).toHaveBeenCalledWith("billing-notices:send", expect.any(Error), { orgId: ORG, key: "trial_7" });
    expect((spies.report.mock.calls[0][1] as Error).message).toBe("Email failed: 422 unverified sender");
  });

  it("a bell line that was not written (notifyPeople says bell false): the email still goes, then it is counted and said", async () => {
    spies.notify.mockResolvedValue({ bell: false, pushed: [] });
    const c = fakeClient({ orgs: [org()] });
    expect(await run(c)).toEqual({ orgs: 1, due: 1, sent: 0, skipped: { comped: 0 }, failed: 1 });
    expect(spies.email).toHaveBeenCalledTimes(1);
    expect((spies.report.mock.calls[0][1] as Error).message).toBe("the bell line was not written");
    expect(spies.report.mock.calls[0][2]).toEqual({ orgId: ORG, key: "trial_7" });
  });

  it("the owner and admins that could not be read: failed under the send key, nothing pushed", async () => {
    const c = fakeClient({ orgs: [org()], profiles: { error: { message: "profiles unreachable" } } });
    expect(await run(c)).toEqual({ orgs: 1, due: 1, sent: 0, skipped: { comped: 0 }, failed: 1 });
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.email).not.toHaveBeenCalled();
    expect((spies.report.mock.calls[0][1] as Error).message).toBe("the owner and admins could not be read: profiles unreachable");
  });
});

describe("the reads", () => {
  it("every company is read whole with the billing columns, the stamps, the email and the settings (projection law), paged by id", async () => {
    const c = fakeClient({ orgs: [org()] });
    await run(c);
    const read = c.seen[0];
    expect(read.table).toBe("organizations");
    for (const col of ["id", "name", "email", "settings", "billing_notices", "subscription_status", "trial_ends_at", "current_period_end", "comped_until"]) {
      expect(read.cols.split(",").map((s) => s.trim())).toContain(col);
    }
    expect(read.calls).toEqual([
      ["order", ["id"]],
      ["range", [0, 999]],
    ]);
  });

  it("the owner and admins are read by the company, active, in role owner or admin — the service client filters by hand", async () => {
    const c = fakeClient({ orgs: [org()] });
    await run(c);
    const people = c.seen.find((q) => q.table === "profiles")!;
    expect(people.cols).toBe("id, email, role");
    expect(people.calls).toEqual([
      ["eq", ["org_id", ORG]],
      ["eq", ["active", true]],
      ["in", ["role", ["owner", "admin"]]],
    ]);
  });

  it("a failed companies read THROWS through to the cron, which files it; nothing is claimed", async () => {
    const c = fakeClient({ orgs: { error: { message: "organizations unreachable" } } });
    await expect(run(c)).rejects.toThrow("organizations could not be read: organizations unreachable");
    expect(c.rpcs).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("no companies: a quiet run", async () => {
    expect(await run(fakeClient({ orgs: [] }))).toEqual({ orgs: 0, due: 0, sent: 0, skipped: { comped: 0 }, failed: 0 });
  });
});
