import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE USAGE NOTICES' STEP (cn-v1140, lib/usage-notice-run): one meter, Usage. At 80% of the month's
 * budget the owner and admins are told once (bell + push + email), at 100% once more, each key once
 * a month behind claim_billing_notice; a company found at 100% that was never told at 80% gets only
 * the 100 notice; a new month is a new key; under 80% tells nobody (a watch BY PACE at 50–79% is the
 * ring's color, never a notice); a comped company is IN; a lapsed one
 * is skipped unread; a meter that could not be read is skipped; the owner and admins only, each in
 * their own language, the email in the owner's; never a dollar or a count of estimates in a notice;
 * one company's failure is filed and counted and the next company is still told; a failed companies
 * read throws through to the cron.
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
// The meter is always handed the cron's client here; a service client of its own would be a leak.
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => {
    throw new Error("the step must hand the meter the cron's client");
  },
}));

import { NOTICE_COLUMNS, NOTICE_URL } from "./billing-notices";
import { USAGE_ORG_COLUMNS } from "./usage-meter";
import { sendUsageNotices, USAGE_NOTICE_COLUMNS, type UsageNoticeOrg } from "./usage-notice-run";

const ORG = "6f1c2a3e-9b4d-4c5e-8f6a-1b2c3d4e5f60";
const ORG2 = "0a9b8c7d-6e5f-4a3b-9c8d-7e6f5a4b3c21";
const TZ = "America/Los_Angeles";
const DAY = 86_400_000;
/** Monday 2026-11-02, 7 AM Pacific: day 2 of November; the month resets Dec 1. */
const NOW = Date.parse("2026-11-02T15:00:00Z");
/** Wednesday 2026-12-02, 7 AM Pacific: the next month. */
const NEXT_MONTH = Date.parse("2026-12-02T15:00:00Z");

const KEY_80 = "usage_80:2026-11";
const KEY_100 = "usage_100:2026-11";

/** Crew's line is $30 a month (lib/plans, never shown): 24 is 80%, 27 is 90%, 30 is used up, 6 is fine. */
const AT_80 = 24;
const AT_90 = 27;
const OUT = 30;
const FINE = 6;
/** 55% on Nov 2: pace $8.25 a day, $13.50 left → runs out Nov 4, before Dec 1 — a WATCH by pace on the ring. */
const WATCH_BY_PACE = 16.5;

type Profile = { id: string; org_id: string; role: string; active: boolean; email: string | null; language?: string | null };
const PEOPLE: Profile[] = [
  { id: "owner-1", org_id: ORG, role: "owner", active: true, email: "snowbell@larkspur.example", language: "en" },
  { id: "admin-1", org_id: ORG, role: "admin", active: true, email: null, language: "es" },
  { id: "office-1", org_id: ORG, role: "office", active: true, email: "office@larkspur.example" },
  { id: "tech-1", org_id: ORG, role: "tech", active: true, email: null, language: "es" },
  { id: "gone-owner", org_id: ORG, role: "owner", active: false, email: "gone@larkspur.example" },
  { id: "owner-2", org_id: ORG2, role: "owner", active: true, email: "catbird@thistlewood.example", language: "en" },
];

function org(over: Partial<UsageNoticeOrg> = {}): UsageNoticeOrg {
  return {
    id: ORG,
    name: "Larkspur Electric",
    email: "hello@larkspur.example",
    plan: "crew",
    settings: { timezone: TZ },
    billing_notices: {},
    subscription_status: "active",
    trial_ends_at: null,
    current_period_end: null,
    comped_until: null,
    ...over,
  };
}

type Q = { table: string; cols: string; calls: [string, unknown[]][] };
type Answer = { data: unknown; error: unknown };

/** A recording service client in the billing notices test's shape: every read's chain is kept, the
 *  meter's two rpcs answer the spend and the top-ups, the claim is answered by `claim`, and the order
 *  of claim · bell · email lands in the shared log. */
function fakeClient(
  opts: {
    orgs?: UsageNoticeOrg[] | { error: unknown };
    profiles?: Profile[] | { error: unknown };
    /** The month's spend by company and the 1st it was read from. */
    spend?: number | ((orgId: string, from: string) => number) | { error: unknown };
    topup?: number;
    claim?: (orgId: string, key: string) => Answer;
  } = {},
) {
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
      const people = opts.profiles ?? PEOPLE;
      const orgId = q.calls.find(([m, a]) => m === "eq" && a[0] === "org_id")?.[1][1];
      if (q.cols === "id, language") {
        const ids = (q.calls.find(([m, a]) => m === "in" && a[0] === "id")?.[1][1] ?? []) as string[];
        const rows = people.filter((p) => p.org_id === orgId && ids.includes(p.id));
        return { data: rows.map(({ id, language }) => ({ id, language: language ?? null })), error: null };
      }
      const active = q.calls.find(([m, a]) => m === "eq" && a[0] === "active")?.[1][1];
      const roles = (q.calls.find(([m]) => m === "in")?.[1][1] ?? []) as string[];
      const rows = people.filter((p) => p.org_id === orgId && p.active === active && roles.includes(p.role));
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
    async rpc(fn: string, args: Record<string, unknown>): Promise<Answer> {
      rpcs.push([fn, args]);
      if (fn === "ai_spend_from") {
        const s = opts.spend ?? 0;
        if (typeof s === "object") return { data: null, error: s.error };
        return { data: typeof s === "function" ? s(String(args.p_org_id), String(args.p_from)) : s, error: null };
      }
      if (fn === "usage_topup_total") return { data: opts.topup ?? 0, error: null };
      if (fn === "claim_billing_notice") {
        spies.log.push(`claim:${String(args.p_key)}`);
        return (opts.claim ?? (() => ({ data: true, error: null })))(String(args.p_org), String(args.p_key));
      }
      return { data: null, error: { message: `no such rpc ${fn}` } };
    },
  };
  return { client, seen, rpcs };
}

/** A claim that remembers: the second ask for a key answers false, the way 0400's stamp does. */
function statefulClaim() {
  const stamps = new Set<string>();
  return (orgId: string, key: string) => {
    const k = `${orgId}:${key}`;
    if (stamps.has(k)) return { data: false, error: null };
    stamps.add(k);
    return { data: true, error: null };
  };
}

const run = (c: ReturnType<typeof fakeClient>, nowMs = NOW) => sendUsageNotices(c.client, nowMs);
const claims = (c: ReturnType<typeof fakeClient>) => c.rpcs.filter(([fn]) => fn === "claim_billing_notice").map(([, a]) => a);
const skipped = (over: Partial<{ fine: number; lapsed: number; degraded: number; already: number }> = {}) => ({ fine: 0, lapsed: 0, degraded: 0, already: 0, ...over });
const told = { orgs: 1, told: 1, skipped: skipped(), failed: 0 };
/** The words the bell and push carry, read back from the function notifyPeople was handed. */
const wordsSent = (call = 0, lang: "en" | "es" = "en") => (spies.notify.mock.calls[call][3] as (l: string) => { title: string; body: string; url: string })(lang);

const EN_80 = {
  title: "Usage: 80% Of This Month",
  body: "Most of this month's usage is used. It resets Dec 1. Nothing stops: past 100%, Nort and the estimator run lighter until then.",
};
const EN_100 = {
  title: "Usage: Used Up For This Month",
  body: "This month's usage is used up, so Nort and the estimator run on the lighter model until Dec 1. Add usage or upgrade in Settings › Getting Paid.",
};
const ES_80 = {
  title: "Uso: 80% De Este Mes",
  body: "Ya se usó la mayor parte de este mes. Se reinicia el 1 dic. Nada se detiene: pasado el 100%, Nort y el estimador corren más ligeros hasta entonces.",
};

beforeEach(() => {
  spies.log.length = 0;
  spies.billing = true;
  spies.notify.mockReset();
  spies.email.mockReset();
  spies.report.mockReset();
  spies.notify.mockImplementation(async (_org: string, ids: string[], _kind: string, n: (lang: string) => { title: string }) => {
    spies.log.push(`notify:${n("en").title}`);
    return { bell: true, pushed: ids };
  });
  spies.email.mockImplementation(async (i: { to: string }) => {
    spies.log.push(`email:${i.to}`);
    return { ok: true };
  });
  vi.unstubAllEnvs();
});

describe("80 once", () => {
  it("at 80%: one claim of the month's 80 key, the words with the reset day, the bell and push to the owner and admins, one email to the company", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_80 });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_80 }]);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    const [orgId, ids, kind, n] = spies.notify.mock.calls[0];
    expect(orgId).toBe(ORG);
    expect(ids).toEqual(["owner-1", "admin-1"]);
    expect(kind).toBe("billing");
    expect(typeof n).toBe("function"); // by language: notifyPeople groups the people by theirs
    expect(wordsSent()).toEqual({ ...EN_80, url: NOTICE_URL });
    expect(spies.email).toHaveBeenCalledTimes(1);
    const mail = spies.email.mock.calls[0][0];
    expect(mail.to).toBe("hello@larkspur.example");
    expect(mail.subject).toBe(EN_80.title);
    expect(mail.fromName).toBeUndefined(); // North itself writes
    expect(mail.html).toBe(`<north>${EN_80.title}|${EN_80.body}|Open Settings|https://contractor-north.vercel.app${NOTICE_URL}</north>`);
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("the url is Settings › Getting Paid, and the email's button (Open Settings — the billing family's words) carries the app's own address", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.contractornorth.com/");
    const c = fakeClient({ orgs: [org({ settings: { timezone: TZ, custom_domain: "larkspur.example" } })], spend: AT_80 });
    await run(c);
    expect(NOTICE_URL).toBe("/settings?tab=getpaid");
    expect(wordsSent().url).toBe("/settings?tab=getpaid");
    expect(spies.email.mock.calls[0][0].html).toContain("|Open Settings|https://app.contractornorth.com/settings?tab=getpaid</north>");
  });

  it("the second run finds the stamp: already, nobody told again", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_80, claim: statefulClaim() });
    expect(await run(c)).toEqual(told);
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ already: 1 }), failed: 0 });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ already: 1 }), failed: 0 });
    expect(claims(c).map((a) => a.p_key)).toEqual([KEY_80, KEY_80, KEY_80]);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.email).toHaveBeenCalledTimes(1);
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("almost (90%) is still the 80 key: one notice for the whole stretch from 80 to used up", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_90 });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_80 }]);
  });

  it("80% exactly: the 80 key is claimed", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_80 });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_80 }]);
    expect(wordsSent().title).toBe(EN_80.title);
  });

  it("55% with a run-out before the reset (a watch BY PACE on the ring) is skipped.fine: nothing claimed, nobody told — the month's 80 stamp waits for the real 80%", async () => {
    const claim = statefulClaim();
    let c = fakeClient({ orgs: [org()], spend: WATCH_BY_PACE, claim });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ fine: 1 }), failed: 0 });
    expect(claims(c)).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.email).not.toHaveBeenCalled();
    // The real 80% later in the month is still told once.
    c = fakeClient({ orgs: [org()], spend: AT_80, claim });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_80 }]);
  });
});

describe("100 once", () => {
  it("used up: one claim of the month's 100 key, the lighter-model words, told once", async () => {
    const c = fakeClient({ orgs: [org()], spend: OUT, claim: statefulClaim() });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_100 }]);
    expect(wordsSent()).toEqual({ ...EN_100, url: NOTICE_URL });
    expect(spies.email.mock.calls[0][0].subject).toBe(EN_100.title);
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ already: 1 }), failed: 0 });
    expect(spies.notify).toHaveBeenCalledTimes(1);
  });

  it("80 then 100 in the same month are two keys, each told once", async () => {
    const claim = statefulClaim();
    let c = fakeClient({ orgs: [org()], spend: AT_80, claim });
    expect(await run(c)).toEqual(told);
    c = fakeClient({ orgs: [org()], spend: OUT, claim });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_100 }]);
    expect(wordsSent(1).title).toBe(EN_100.title);
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ already: 1 }), failed: 0 });
    expect(spies.notify).toHaveBeenCalledTimes(2);
    expect(spies.email).toHaveBeenCalledTimes(2);
  });

  it("a company found at 100% that was never told at 80% gets ONLY the 100 notice: the state decides the key, one notice per company per run", async () => {
    const c = fakeClient({ orgs: [org()], spend: OUT });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_100 }]);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(wordsSent().title).toBe(EN_100.title);
  });

  it("a new month is a new key: December's 80 is told again, read from December's 1st", async () => {
    const claim = statefulClaim();
    let c = fakeClient({ orgs: [org()], spend: AT_80, claim });
    expect(await run(c, NOW)).toEqual(told);
    c = fakeClient({ orgs: [org()], spend: AT_80, claim });
    expect(await run(c, NEXT_MONTH)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: "usage_80:2026-12" }]);
    expect(c.rpcs.find(([fn]) => fn === "ai_spend_from")?.[1]).toEqual({ p_org_id: ORG, p_from: "2026-12-01" });
    expect(wordsSent(1).body).toContain("It resets Jan 1.");
    expect(await run(c, NEXT_MONTH)).toEqual({ orgs: 1, told: 0, skipped: skipped({ already: 1 }), failed: 0 });
  });
});

describe("who hears nothing", () => {
  it("fine tells nobody and claims nothing", async () => {
    let c = fakeClient({ orgs: [org()], spend: FINE });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ fine: 1 }), failed: 0 });
    expect(claims(c)).toEqual([]);
    c = fakeClient({ orgs: [org()], spend: 0 });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ fine: 1 }), failed: 0 });
    expect(claims(c)).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.email).not.toHaveBeenCalled();
    expect(spies.report).not.toHaveBeenCalled();
  });

  it("a lapsed company is skipped unread: no meter, no claim, counted", async () => {
    let c = fakeClient({ orgs: [org({ subscription_status: "canceled" })], spend: OUT });
    expect(await run(c)).toEqual({ orgs: 0, told: 0, skipped: skipped({ lapsed: 1 }), failed: 0 });
    expect(c.rpcs).toEqual([]);
    c = fakeClient({ orgs: [org({ subscription_status: "trialing", trial_ends_at: new Date(NOW - DAY).toISOString() })], spend: OUT });
    expect(await run(c)).toEqual({ orgs: 0, told: 0, skipped: skipped({ lapsed: 1 }), failed: 0 });
    expect(c.rpcs).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
  });

  it("a meter that could not be read (degraded) is skipped and counted: nothing claimed, nobody told; the meter files its own row", async () => {
    const c = fakeClient({ orgs: [org()], spend: { error: { message: "ai_spend_from timed out" } } });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ degraded: 1 }), failed: 0 });
    expect(claims(c)).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
    expect(spies.email).not.toHaveBeenCalled();
    expect(spies.report).toHaveBeenCalledTimes(1);
    expect(spies.report.mock.calls[0][0]).toBe("usage-meter:read");
  });

  it("the office and the techs are never told: the owner and admins only, active, by the company", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_80 });
    await run(c);
    expect(spies.notify.mock.calls[0][1]).toEqual(["owner-1", "admin-1"]);
    const people = c.seen.find((q) => q.table === "profiles" && q.cols === "id, email, role")!;
    expect(people.calls).toEqual([
      ["eq", ["org_id", ORG]],
      ["eq", ["active", true]],
      ["in", ["role", ["owner", "admin"]]],
    ]);
  });
});

describe("a comped company is IN: the usage is theirs", () => {
  it("comped by the column: its meter runs on Company's line, and at 80% of it the owner is told", async () => {
    // Company's line is $80 a month: 64 is 80%; a Crew plan's 24 would be under 50% of it.
    let c = fakeClient({ orgs: [org({ plan: null, subscription_status: null, comped_until: new Date(NOW + 30 * DAY).toISOString() })], spend: 64 });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_80 }]);
    c = fakeClient({ orgs: [org({ plan: "crew", comped_until: new Date(NOW + 30 * DAY).toISOString() })], spend: AT_80 });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ fine: 1 }), failed: 0 });
  });

  it("comped by the env list: the same", async () => {
    vi.stubEnv("COMPED_ORG_IDS", `some-other-org, ${ORG.toUpperCase()}`);
    const c = fakeClient({ orgs: [org({ plan: null, subscription_status: "canceled" })], spend: 80 });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_100 }]);
  });

  it("billing off (no Stripe key): nobody is lapsed, every company is read — usage is model spend, not a card", async () => {
    spies.billing = false;
    const c = fakeClient({ orgs: [org({ subscription_status: "canceled" })], spend: AT_80 });
    expect(await run(c)).toEqual(told);
    expect(claims(c)).toEqual([{ p_org: ORG, p_key: KEY_80 }]);
  });
});

describe("each in their own language", () => {
  it("the bell and push words are a function of the language: Spanish for the Spanish-speaking admin, English for the owner", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_80 });
    await run(c);
    expect(wordsSent(0, "es")).toEqual({ ...ES_80, url: NOTICE_URL });
    expect(wordsSent(0, "en")).toEqual({ ...EN_80, url: NOTICE_URL });
  });

  it("a Spanish-speaking owner: the email reads in Spanish, its button too", async () => {
    const people = PEOPLE.map((p) => (p.id === "owner-1" ? { ...p, language: "es" } : p));
    const c = fakeClient({ orgs: [org()], profiles: people, spend: AT_80 });
    expect(await run(c)).toEqual(told);
    const mail = spies.email.mock.calls[0][0];
    expect(mail.to).toBe("hello@larkspur.example");
    expect(mail.subject).toBe(ES_80.title);
    expect(mail.html).toBe(`<north>${ES_80.title}|${ES_80.body}|Abrir Ajustes|https://contractor-north.vercel.app${NOTICE_URL}</north>`);
    // The owner's language is read by the company (the service client reads across companies without it).
    const langRead = c.seen.find((q) => q.table === "profiles" && q.cols === "id, language")!;
    expect(langRead.calls).toEqual([
      ["in", ["id", ["owner-1"]]],
      ["eq", ["org_id", ORG]],
    ]);
  });

  it("the 100 notice in Spanish, the date as 1 dic", async () => {
    const c = fakeClient({ orgs: [org()], spend: OUT });
    await run(c);
    expect(wordsSent(0, "es")).toEqual({
      title: "Uso: Agotado Por Este Mes",
      body: "El uso de este mes se agotó, así que Nort y el estimador corren en el modelo más ligero hasta el 1 dic. Agrega uso o mejora tu plan en Ajustes › Cobros.",
      url: NOTICE_URL,
    });
  });

  it("no language on file: English; a company with admins only: the first admin's language", async () => {
    const people = PEOPLE.map((p) => (p.id === "owner-1" ? { ...p, language: null } : p));
    let c = fakeClient({ orgs: [org()], profiles: people, spend: AT_80 });
    await run(c);
    expect(spies.email.mock.calls[0][0].subject).toBe(EN_80.title);
    spies.email.mockClear();
    c = fakeClient({ orgs: [org()], profiles: PEOPLE.filter((p) => p.role !== "owner"), spend: AT_80 });
    await run(c);
    expect(spies.notify.mock.calls[1][1]).toEqual(["admin-1"]);
    expect(spies.email.mock.calls[0][0].subject).toBe(ES_80.title); // admin-1 reads Spanish
  });
});

describe("never a dollar, never a count of estimates", () => {
  it("the meter's dollars reach no notice: not the bell, not the push, not the email", async () => {
    // A $5 top-up raises Crew's cap to $35: 28 is 80% of it, 35 is used up.
    for (const spend of [AT_80 + 4, OUT + 5]) {
      spies.notify.mockClear();
      spies.email.mockClear();
      const c = fakeClient({ orgs: [org()], spend, topup: 5 });
      await run(c);
      for (const lang of ["en", "es"] as const) {
        const w = wordsSent(0, lang);
        expect(`${w.title} ${w.body}`).not.toMatch(/\$|\d+ (full )?(estimates|presupuestos)|token|credit|crédito/i);
        expect(`${w.title} ${w.body}`).not.toContain(String(spend));
      }
      expect(spies.email.mock.calls[0][0].html).not.toMatch(/\$|estimates|presupuestos/i);
    }
  });
});

describe("the lock and the order", () => {
  it("the claim happens BEFORE the bell and the email", async () => {
    await run(fakeClient({ orgs: [org()], spend: AT_80 }));
    expect(spies.log).toEqual([`claim:${KEY_80}`, `notify:${EN_80.title}`, "email:hello@larkspur.example"]);
  });

  it("email + push + bell all go: the bell and push through notifyPeople under `billing` (the push rides the line), the email through the platform mailer", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_80 });
    expect(await run(c)).toEqual(told);
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.notify.mock.calls[0][2]).toBe("billing");
    expect(spies.email).toHaveBeenCalledTimes(1);
    expect(spies.email.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("no company email: the owner's; no address at all: the bell and push still go and the run does not call it failed", async () => {
    let c = fakeClient({ orgs: [org({ email: null })], spend: AT_80 });
    expect(await run(c)).toEqual(told);
    expect(spies.email.mock.calls[0][0].to).toBe("snowbell@larkspur.example");
    spies.email.mockClear();
    const people = PEOPLE.map((p) => (p.id === "owner-1" ? { ...p, email: null } : p));
    c = fakeClient({ orgs: [org({ email: null })], profiles: people, spend: AT_80 });
    expect(await run(c)).toEqual(told);
    expect(spies.email).not.toHaveBeenCalled();
    expect(spies.report).not.toHaveBeenCalled();
  });
});

describe("a failure is the company's own", () => {
  it("a claim that errors: failed, nothing sent, filed as usage-notices:<org> with the company; the next company is still told", async () => {
    const c = fakeClient({
      orgs: [org(), org({ id: ORG2, name: "Thistlewood Decks", email: null, plan: "handyman" })],
      spend: (orgId) => (orgId === ORG ? AT_80 : 10), // Handyman's line is $10: used up
      claim: (orgId) => (orgId === ORG ? { data: null, error: { message: "timeout" } } : { data: true, error: null }),
    });
    expect(await run(c)).toEqual({ orgs: 2, told: 1, skipped: skipped(), failed: 1 });
    expect(spies.report).toHaveBeenCalledTimes(1);
    const [where, err, extra] = spies.report.mock.calls[0];
    expect(where).toBe(`usage-notices:${ORG}`);
    expect((err as Error).message).toBe(`claim_billing_notice ${KEY_80} failed: timeout`);
    expect(extra).toEqual({ orgId: ORG });
    expect(spies.notify).toHaveBeenCalledTimes(1);
    expect(spies.notify.mock.calls[0][0]).toBe(ORG2);
    expect(spies.notify.mock.calls[0][1]).toEqual(["owner-2"]);
    expect(wordsSent().title).toBe(EN_100.title);
    expect(spies.email.mock.calls[0][0].to).toBe("catbird@thistlewood.example"); // no company email: the owner's
  });

  it("a claim that answers nothing is a failure, never a send", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_80, claim: () => ({ data: null, error: null }) });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped(), failed: 1 });
    expect(spies.notify).not.toHaveBeenCalled();
    expect((spies.report.mock.calls[0][1] as Error).message).toBe(`claim_billing_notice ${KEY_80} answered nothing`);
  });

  it("after the claim, a lost email is filed with the key and counted — the stamp stands, never retried", async () => {
    spies.email.mockRejectedValue(new Error("fetch failed"));
    const c = fakeClient({ orgs: [org()], spend: AT_80, claim: statefulClaim() });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped(), failed: 1 });
    expect(spies.notify).toHaveBeenCalledTimes(1); // the bell and push already went
    expect(spies.report).toHaveBeenCalledWith(`usage-notices:${ORG}`, expect.any(Error), { orgId: ORG, key: KEY_80, after: "claim" });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped({ already: 1 }), failed: 0 });
  });

  it("a bell line that was not written: the email still goes, then it is counted and said", async () => {
    spies.notify.mockResolvedValue({ bell: false, pushed: [] });
    const c = fakeClient({ orgs: [org()], spend: AT_80 });
    expect(await run(c)).toEqual({ orgs: 1, told: 0, skipped: skipped(), failed: 1 });
    expect(spies.email).toHaveBeenCalledTimes(1);
    expect((spies.report.mock.calls[0][1] as Error).message).toBe("the bell line was not written");
  });

  it("a failed companies read THROWS through to the cron, which files it; nothing is claimed", async () => {
    const c = fakeClient({ orgs: { error: { message: "organizations unreachable" } } });
    await expect(run(c)).rejects.toThrow("organizations could not be read: organizations unreachable");
    expect(c.rpcs).toEqual([]);
    expect(spies.notify).not.toHaveBeenCalled();
  });
});

describe("the reads", () => {
  it("one read per company: the row carries the notices' columns and every column the meter needs, paged by id, and the meter is handed it", async () => {
    const c = fakeClient({ orgs: [org()], spend: AT_80 });
    await run(c);
    const read = c.seen[0];
    expect(read.table).toBe("organizations");
    const cols = read.cols.split(",").map((s) => s.trim());
    for (const col of [...NOTICE_COLUMNS.split(","), ...USAGE_ORG_COLUMNS.split(",")].map((s) => s.trim())) expect(cols).toContain(col);
    expect(new Set(cols).size).toBe(cols.length); // each once
    expect(read.calls).toEqual([
      ["order", ["id"]],
      ["range", [0, 999]],
    ]);
    // The meter never reads the company again: every organizations read is a page (order + range),
    // none is the meter's own `.eq("id", …)` single-row read.
    for (const q of c.seen.filter((q) => q.table === "organizations")) expect(q.calls.map(([m]) => m)).toEqual(["order", "range"]);
    expect(c.rpcs.map(([fn]) => fn)).toEqual(["ai_spend_from", "usage_topup_total", "claim_billing_notice"]);
    expect(c.rpcs[1][1]).toEqual({ p_org: ORG, p_month: "2026-11" });
    expect(USAGE_NOTICE_COLUMNS).toBe(cols.join(", "));
  });

  it("no companies: a quiet run", async () => {
    expect(await run(fakeClient({ orgs: [] }))).toEqual({ orgs: 0, told: 0, skipped: skipped(), failed: 0 });
  });
});
