import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * EVERY DOOR THAT TEXTS, READY AND NOT READY (2026-09-24).
 *
 * Erik: "Wait in texting but be ready for it's setup". Production cannot text yet, so each door
 * must say so (or skip and count it) without a word going out; and the day the pieces exist, each
 * door must reach the existing Twilio client with no code change. Both halves are pinned here,
 * door by door, through the REAL readiness check and the REAL sendSms: only the environment and
 * `fetch` are stubbed, so no message is ever sent.
 *
 *   the 7 AM "you haven't clocked in" text          /api/timeclock/nudge
 *   the 6 PM "still clocked in / fill your day" text /api/timeclock/eod-reminder
 *   the 12-hour "still on the clock?" question        /api/timeclock/long-shift
 *   Text on an invoice, and the receipt row           textInvoice
 *   Text on an estimate                               textQuote
 */

const state = vi.hoisted(() => ({ client: null as any }));
const spies = vi.hoisted(() => ({
  push: [] as any[],
  notify: [] as any[],
  closeOut: 0,
  closeOutOrgs: undefined as unknown,
  closeOutFails: false,
  // The 6 PM push (cn-v1190): each notifyPeople call, its words in both languages, and what it answers.
  people: [] as { org: string; ids: string[]; kind: string; en: any; es: any }[],
  peopleAnswer: null as null | ((ids: string[]) => { bell: boolean; pushed: string[] }),
}));
// The hour gate with one switch: a timezone Intl cannot read throws in atLocalHour (cn-v1130, skeptic #34).
const gate = vi.hoisted(() => ({ throwNext: false }));

vi.mock("@/lib/cron-guard", () => ({ requireCron: vi.fn(() => ({ supabase: state.client })) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: state.client, userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
  createServiceClient: vi.fn(() => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustDocPdf: vi.fn(async () => {}), warmDocPdf: vi.fn(async () => {}) }));
vi.mock("@/lib/revalidate-money", () => ({ revalidateMoney: vi.fn() }));
vi.mock("@/lib/invoice-recalc", () => ({ recalcInvoice: vi.fn(async () => ({ ok: true })) }));
// reportErrorAwaited is what the 500 paths file through (cn-v1130, skeptic #34): they answer on the tick they file.
// The real errorMessage stays (readAllOrgs words a failed read with it); only the two filers are spies.
vi.mock("@/lib/observe", async (orig) => ({
  ...(await orig<typeof import("@/lib/observe")>()),
  reportError: vi.fn(),
  reportErrorAwaited: vi.fn(async () => {}),
}));
// A failed company read is a BLOCKER (cn-v1136): no company was reached, so it pages North's own team.
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn(), reportBlockerAwaited: vi.fn(async () => {}) }));
// BILLING ON (cn-v1137): with a Stripe key a company's standing is read — the texting crons pass a
// lapsed company over (readActiveOrgs) and the two human doors refuse for one (orgAccess). With
// billing off nothing lapses, so the fixtures below carry a live status to be read at all.
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), billingEnabled: true }));
vi.mock("@/lib/cron-orgs", async (orig) => {
  const real = await orig<typeof import("@/lib/cron-orgs")>();
  return {
    ...real,
    atLocalHour: vi.fn((...a: Parameters<typeof real.atLocalHour>) => {
      if (gate.throwNext) {
        gate.throwNext = false;
        throw new RangeError("Invalid time zone specified: Mars/Olympus");
      }
      return real.atLocalHour(...a);
    }),
  };
});
vi.mock("@/lib/notifications", () => ({
  createNotifications: vi.fn(async (...a: any[]) => {
    spies.notify.push(a);
    return true;
  }),
  notifyPeople: vi.fn(async (org: string, ids: string[], kind: string, n: any) => {
    spies.people.push({ org, ids, kind, en: typeof n === "function" ? n("en") : n, es: typeof n === "function" ? n("es") : n });
    return spies.peopleAnswer ? spies.peopleAnswer(ids) : { bell: true, pushed: ids };
  }),
}));
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => void spies.push.push(a)),
  orgStaffIds: vi.fn(async () => ["office-1"]),
  orgStaffIdsOrThrow: vi.fn(async () => ["office-1"]),
}));
vi.mock("@/lib/action-items/eod-sweep", () => ({
  // The evening cron hands the night debrief the companies at their own 6 PM (cn-v1130): recorded.
  sendCloseOutNudges: vi.fn(async (_db: unknown, orgs: unknown) => {
    spies.closeOut++;
    spies.closeOutOrgs = orgs;
    if (spies.closeOutFails) throw new Error("the close-out read fell over");
    return { sent: 0 };
  }),
}));

import { GET as nudge } from "./nudge/route";
import { GET as eod } from "./eod-reminder/route";
import { GET as longShift } from "./long-shift/route";
import { textInvoice } from "@/app/(app)/billing/actions";
import { textQuote } from "@/app/(app)/quotes/actions";
import { TEXT_NOT_READY_REFUSAL, TEXT_REFUSED } from "@/lib/sms-readiness";
import { reportError, reportErrorAwaited } from "@/lib/observe";
import { reportBlockerAwaited } from "@/lib/observe-blocker";

// ── a routed PostgREST fake: an unrouted statement throws by name ────────────────────────────
type Q = { table: string; verb: "select" | "insert" | "update" | "delete"; cols: string; payload?: any; filters: any[] };
type Reply = { data?: any; error?: any } | undefined;
function fakeSupabase(route: (q: Q) => Reply) {
  const answer = (q: Q) => {
    const r = route(q);
    if (r === undefined) throw new Error(`unrouted: ${q.table}.${q.verb} [${q.cols}] ${JSON.stringify(q.payload ?? null)}`);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return {
    // The signed-in person (the lapse refusal reads the caller's role through the user client).
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      const q: Q = { table, verb: "select", cols: "", filters: [] };
      const chain: any = {
        select(cols?: string) { if (q.verb === "select") q.cols = cols ?? ""; return chain; },
        update(p: any) { q.verb = "update"; q.payload = p; return chain; },
        insert(p: any) { q.verb = "insert"; q.payload = p; return chain; },
        single() { return Promise.resolve(answer(q)); },
        maybeSingle() { return Promise.resolve(answer(q)); },
        then(resolve: any, reject: any) {
          try { resolve(answer(q)); } catch (e) { reject?.(e); }
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "order", "limit", "range"]) {
        chain[m] = (...args: any[]) => { q.filters.push([m, ...args]); return chain; };
      }
      return chain;
    },
  };
}

// ── the texting environment: nothing (today's production), or the pieces ─────────────────────
const TWILIO_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_FROM_NUMBER",
];
const fetchSpy = vi.fn(async (..._a: unknown[]) => new Response("{}", { status: 201 }));
function textingReady() {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "t");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG-test");
}
const sentTexts = () =>
  fetchSpy.mock.calls.map((c) => {
    const p = (c[1] as RequestInit).body as URLSearchParams;
    return { to: p.get("To"), body: p.get("Body") };
  });

const TZ = { timezone: "America/Los_Angeles" };
const ORG = { id: "org-1", name: "ET Electric", settings: { ...TZ }, subscription_status: "active" };
const SECOND_ORG = { id: "org-2", name: "Snowbell Electric", settings: { ...TZ }, subscription_status: "active" };
const BAD_ZONE_ORG = { id: "org-bad", name: "Larkspur Electric", settings: { ...TZ }, subscription_status: "active" };
/** A company whose plan has ended (cn-v1137): never texted for, counted as lapsed. */
const LAPSED_ORG = { id: "org-lapsed", name: "Bayberry Electric", settings: { ...TZ }, subscription_status: "canceled" };
/** A comped company (the founding cohort, 0400's column): canceled at Stripe and still standing. */
const COMPED_ORG = { id: "org-comped", name: "Catbird Electric", settings: { ...TZ }, subscription_status: "canceled", comped_until: "2099-01-01T00:00:00.000Z" };
/** The profile reads the lapse refusal makes: the caller's role (by id), else the company's owner. */
const peopleFor = (role: string) => (q: Q): Reply =>
  q.filters.some((f) => f[0] === "eq" && f[1] === "id") ? { data: { role } } : { data: { full_name: "Larkspur Owner" } };
const TEXTING_PAUSED_OWNER = "Texting is paused until a plan is picked. Pick a plan in Settings › Getting Paid.";
const TEXTING_PAUSED_CREW = "Texting is paused until a plan is picked. Ask Larkspur to pick a plan.";
const req = () => new Request("https://app.test/api", { headers: { authorization: "Bearer x" } });

/** The company list the way readAllOrgs pages it (cn-v1130): every row on the page at from=0, and
 *  an empty page after it, so the read knows it is whole. */
const orgPage = (q: Q, rows: any[]): Reply => {
  const range = q.filters.find((f) => f[0] === "range");
  return { data: range && range[1] > 0 ? [] : rows };
};

// Thursday 2001-01-04 in Pacific (PST, UTC-8); nobody worked it. The two texting crons are hourly
// and a company is handled on the run in its OWN hour (cn-v1130), so the morning cases run at the
// company's 7 AM and the evening ones at its 6 PM, which is already Friday in UTC.
const SEVEN_AM = new Date("2001-01-04T15:00:00.000Z");
const EIGHT_AM = new Date("2001-01-04T16:00:00.000Z");
const SATURDAY_SEVEN_AM = new Date("2001-01-06T15:00:00.000Z");
const SIX_PM = new Date("2001-01-05T02:00:00.000Z");
const FIVE_PM = new Date("2001-01-05T01:00:00.000Z");

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const k of TWILIO_KEYS) vi.stubEnv(k, "");
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  vi.mocked(reportError).mockClear();
  vi.mocked(reportErrorAwaited).mockClear();
  vi.mocked(reportBlockerAwaited).mockClear();
  gate.throwNext = false;
  spies.closeOutFails = false;
  spies.push = [];
  spies.notify = [];
  spies.closeOut = 0;
  spies.closeOutOrgs = undefined;
  spies.people = [];
  spies.peopleAnswer = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the morning nudge: no clock-in yet", () => {
  const routes = (q: Q): Reply => {
    if (q.table === "organizations") return orgPage(q, [ORG]);
    if (q.table === "profiles") return { data: [{ id: "brian-1", full_name: "Brian Taylor", phone: "(530) 555-0100" }] };
    if (q.table === "time_entries") return { data: [] };
    return undefined;
  };
  const failing = (table: string) => (q: Q): Reply => (q.table === table ? { error: { message: "boom" } } : routes(q));
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SEVEN_AM);
  });

  it("not ready: nothing is sent, and the skip is counted", async () => {
    state.client = fakeSupabase(routes);
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ texted: 0, not_ready: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ready: the tech is texted through the existing client", async () => {
    textingReady();
    state.client = fakeSupabase(routes);
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ texted: 1, not_ready: 0, due: 1, not_due_yet: 0, failed: 0 });
    expect(sentTexts()).toEqual([{ to: "+15305550100", body: expect.stringMatching(/haven't clocked in yet/) }]);
  });

  it("an org that turned the reminders off is never texted, ready or not", async () => {
    textingReady();
    state.client = fakeSupabase((q) => (q.table === "organizations" ? orgPage(q, [{ ...ORG, settings: { ...TZ, remind_timeclock: false } }]) : routes(q)));
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ texted: 0, not_ready: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("off the company's 7 AM, or on its Saturday, nothing is sent and the company is counted as not due yet", async () => {
    textingReady();
    for (const at of [EIGHT_AM, SATURDAY_SEVEN_AM]) {
      vi.setSystemTime(at);
      state.client = fakeSupabase(routes);
      const body = await (await nudge(req())).json();
      expect(body).toMatchObject({ due: 0, not_due_yet: 1, checked: 0, texted: 0, failed: 0 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a failed punches read texts NOBODY: counted as failed and filed with the company", async () => {
    textingReady();
    state.client = fakeSupabase(failing("time_entries"));
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ due: 1, checked: 0, texted: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("cron-nudge", { message: "boom" }, { orgId: "org-1" });
  });

  it("a failed techs read the same", async () => {
    textingReady();
    state.client = fakeSupabase(failing("profiles"));
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ due: 1, checked: 0, texted: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("cron-nudge", { message: "boom" }, { orgId: "org-1" });
  });

  /**
   * IN EACH TECH'S LANGUAGE (cn-v1138): `language` rides the one people read, and a Spanish-speaking
   * tech and an English one in the SAME run each get their own words; a null language is English.
   */
  it("an es tech and an en tech in the same run each get their own text, from the one people read", async () => {
    textingReady();
    const peopleReads: string[] = [];
    state.client = fakeSupabase((q) => {
      if (q.table !== "profiles") return routes(q);
      peopleReads.push(q.cols);
      return {
        data: [
          { id: "larkspur-1", full_name: "Larkspur Catbird", phone: "(530) 555-0101", language: "es" },
          { id: "brian-1", full_name: "Brian Taylor", phone: "(530) 555-0100", language: null },
        ],
      };
    });
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ texted: 2, checked: 2, failed: 0 });
    expect(sentTexts()).toEqual([
      { to: "+15305550101", body: "¡Buenos días, Larkspur Catbird! Aún no marcas entrada. Abre Contractor North para marcar entrada." },
      { to: "+15305550100", body: "Good morning Brian Taylor! You haven't clocked in yet. Open Contractor North to clock in." },
    ]);
    // ONE people read, carrying the language beside the phone: no second read per person.
    expect(peopleReads).toEqual(["id, full_name, phone, language"]);
  });

  it("a company whose plan has ended is not texted for and is counted; a comped one still is (cn-v1137)", async () => {
    textingReady();
    state.client = fakeSupabase((q) => (q.table === "organizations" ? orgPage(q, [LAPSED_ORG, COMPED_ORG]) : routes(q)));
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ texted: 1, lapsed_skipped: 1, due: 1, failed: 0 });
    expect(sentTexts()).toHaveLength(1);
  });

  it("a failed company read is a 500 that is filed, never an empty run", async () => {
    textingReady();
    state.client = fakeSupabase(failing("organizations"));
    const res = await nudge(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ failed: 1, checked: 0, texted: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Filed through the WAITED-for BLOCKER door: this function answers on the tick it files (skeptic #34), and
    // no company was reached, so it pages (cn-v1136).
    expect(reportBlockerAwaited).toHaveBeenCalledWith("cron-nudge", expect.objectContaining({ message: "organizations could not be read: boom" }));
    expect(reportError).not.toHaveBeenCalled();
    expect(reportErrorAwaited).not.toHaveBeenCalled(); // a blocker, never a plain row (cn-v1136)
  });

  it("a company whose timezone THROWS in the hour gate is counted failed and filed; the next company is still texted", async () => {
    textingReady();
    state.client = fakeSupabase((q) => (q.table === "organizations" ? orgPage(q, [BAD_ZONE_ORG, SECOND_ORG]) : routes(q)));
    gate.throwNext = true; // the first company's gate throws, the second's reads normally
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ due: 1, not_due_yet: 0, failed: 1, texted: 1 });
    expect(sentTexts()).toHaveLength(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith("cron-nudge", expect.any(RangeError), { orgId: "org-bad" });
  });
});

describe("the evening reminder: still clocked in", () => {
  const routes = (q: Q): Reply => {
    if (q.table === "organizations") return orgPage(q, [ORG]);
    if (q.table === "profiles") return { data: [{ id: "brian-1", full_name: "Brian Taylor", phone: "5305550100" }] };
    if (q.table === "time_entries") return { data: [{ profile_id: "brian-1", status: "open", notes: null }] };
    return undefined;
  };
  const failing = (table: string) => (q: Q): Reply => (q.table === table ? { error: { message: "boom" } } : routes(q));
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SIX_PM);
  });

  it("not ready: nothing is sent, the skip is counted, and the night debrief still goes to the companies at their 6 PM", async () => {
    state.client = fakeSupabase(routes);
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ reminded: 0, not_ready: 1, due: 1, not_due_yet: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.closeOut).toBe(1);
    expect(spies.closeOutOrgs).toEqual([ORG]);
  });

  it("ready: the tech is texted", async () => {
    textingReady();
    state.client = fakeSupabase(routes);
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ reminded: 1, not_ready: 0, due: 1, failed: 0 });
    expect(sentTexts()).toEqual([{ to: "+15305550100", body: expect.stringMatching(/still clocked in/) }]);
  });

  it("off the company's 6 PM nothing is sent, the company is counted as not due yet, and the debrief gets no company", async () => {
    textingReady();
    vi.setSystemTime(FIVE_PM);
    state.client = fakeSupabase(routes);
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ due: 0, not_due_yet: 1, checked: 0, reminded: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.closeOutOrgs).toEqual([]);
  });

  it("a failed entries read texts NOBODY: counted as failed and filed with the company; the debrief still goes", async () => {
    textingReady();
    state.client = fakeSupabase(failing("time_entries"));
    const body = await (await eod(req())).json();
    // cn-v1190: the 6 PM push reads the open shifts too (the default reads Both), so the one failed
    // table fails both steps, each counted and filed, and nobody is pushed or texted.
    expect(body).toMatchObject({ due: 1, checked: 0, reminded: 0, failed: 2, pushed: 0, push_failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.people).toEqual([]);
    expect(reportError).toHaveBeenCalledWith("cron-eod", { message: "boom" }, { orgId: "org-1", step: "push" });
    expect(reportError).toHaveBeenCalledWith("cron-eod", { message: "boom" }, { orgId: "org-1" });
    expect(spies.closeOutOrgs).toEqual([ORG]);
  });

  it("a failed techs read the same", async () => {
    textingReady();
    state.client = fakeSupabase(failing("profiles"));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ due: 1, checked: 0, reminded: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith("cron-eod", { message: "boom" }, { orgId: "org-1" });
  });

  /** IN EACH TECH'S LANGUAGE (cn-v1138): one people read carries the language; each tech's own words, in one run. */
  it("an es tech still clocked in and an en tech with no form, in the same run, each get their own text", async () => {
    textingReady();
    const peopleReads: string[] = [];
    state.client = fakeSupabase((q) => {
      if (q.table === "profiles") {
        peopleReads.push(q.cols);
        return {
          data: [
            { id: "larkspur-1", full_name: "Larkspur Catbird", phone: "(530) 555-0101", language: "es" },
            { id: "brian-1", full_name: "Brian Taylor", phone: "5305550100", language: "en" },
          ],
        };
      }
      if (q.table === "time_entries")
        return {
          data: [
            { profile_id: "larkspur-1", status: "open", notes: null },
            { profile_id: "brian-1", status: "closed", notes: null },
          ],
        };
      return routes(q);
    });
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ reminded: 2, checked: 2, failed: 0 });
    expect(sentTexts()).toEqual([
      { to: "+15305550101", body: "Hola, Larkspur Catbird: sigues con entrada marcada. Marca salida y llena tu reporte del día en Contractor North." },
      { to: "+15305550100", body: "Hi Brian Taylor — please fill out your end-of-day form (what you worked on today) in Contractor North." },
    ]);
    expect(peopleReads).toEqual(["id, full_name, phone, language"]);
  });

  it("a company whose plan has ended gets neither the reminder nor the debrief and is counted; a comped one gets both (cn-v1137)", async () => {
    textingReady();
    state.client = fakeSupabase((q) => (q.table === "organizations" ? orgPage(q, [LAPSED_ORG, COMPED_ORG]) : routes(q)));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ reminded: 1, lapsed_skipped: 1, due: 1, failed: 0 });
    expect(sentTexts()).toHaveLength(1);
    expect((spies.closeOutOrgs as { id: string }[]).map((o) => o.id)).toEqual(["org-comped"]);
  });

  it("a failed company read is a 500 that is filed, and the debrief is not sent either", async () => {
    textingReady();
    state.client = fakeSupabase(failing("organizations"));
    const res = await eod(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ failed: 1, checked: 0, reminded: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.closeOut).toBe(0);
    expect(reportBlockerAwaited).toHaveBeenCalledWith("cron-eod", expect.objectContaining({ message: "organizations could not be read: boom" }));
    expect(reportError).not.toHaveBeenCalled();
    expect(reportErrorAwaited).not.toHaveBeenCalled(); // a blocker, never a plain row (cn-v1136)
  });

  it("a company whose timezone THROWS in the hour gate is counted failed and filed; the next company is still reminded and gets the debrief", async () => {
    textingReady();
    state.client = fakeSupabase((q) => (q.table === "organizations" ? orgPage(q, [BAD_ZONE_ORG, SECOND_ORG]) : routes(q)));
    gate.throwNext = true;
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ due: 1, not_due_yet: 0, failed: 1, reminded: 1 });
    expect(sentTexts()).toHaveLength(1);
    expect(spies.closeOutOrgs).toEqual([SECOND_ORG]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith("cron-eod", expect.any(RangeError), { orgId: "org-bad" });
  });

  it("a close-out that throws is filed AND counted in the run's own failed count", async () => {
    textingReady();
    spies.closeOutFails = true;
    state.client = fakeSupabase(routes);
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ close_out: "failed", failed: 1, reminded: 1 });
    expect(reportError).toHaveBeenCalledWith("cron-close-out", expect.objectContaining({ message: "the close-out read fell over" }));
  });
});

/**
 * THE 6 PM PUSH AND THE OWNER'S CHOICE (cn-v1190). The owner: "we need to get the clock out reminder
 * on a push notification" and "everyone gets the push notification and the boss can choose text push
 * or both". At the company's 6 PM everyone still on the clock whose shift began that day, any role,
 * gets ONE "Still Clocked In" through notifyPeople (kind clock_out, url /timeclock); the texts go only
 * under Text or Both. The stand-in honours the reads' filters: the company, the open status, and the
 * family read's or(). Larkspur, Snowbell and Tupelo Panel, Sam Tillery and Dana Rook are stand-ins.
 */
describe("the 6 PM push, and Push / Text / Both", () => {
  const LARKSPUR = { id: "org-1", name: "Larkspur", settings: { ...TZ }, subscription_status: "active" };
  type Row = Record<string, any>;
  // Thursday 2001-01-04, Pacific. Today's 7 AM is 15:00 UTC.
  const OPEN: Row[] = [
    // Sam Tillery, a tech, in at 7:00 AM today.
    { id: "e-sam", org_id: "org-1", profile_id: "sam", status: "open", clock_in: "2001-01-04T15:00:00.000Z", split_from: null, long_shift_nudged_at: null, profiles: { active: true } },
    // A second open row of Sam's today (a stray the office has not closed): still ONE push for him.
    { id: "e-sam-2", org_id: "org-1", profile_id: "sam", status: "open", clock_in: "2001-01-04T17:00:00.000Z", split_from: null, long_shift_nudged_at: null, profiles: { active: true } },
    // Dana Rook, the office, in at 1:05 PM today.
    { id: "e-dana", org_id: "org-1", profile_id: "dana", status: "open", clock_in: "2001-01-04T21:05:00.000Z", split_from: null, long_shift_nudged_at: null, profiles: { active: true } },
    // The owner, in at 6:00 AM, switched job at noon: the push names the shift's start, not the switch's.
    { id: "e-own-2", org_id: "org-1", profile_id: "owner-1", status: "open", clock_in: "2001-01-04T20:00:00.000Z", split_from: "e-own-1", long_shift_nudged_at: null, profiles: { active: true } },
    // A removed person: never pushed.
    { id: "e-gone", org_id: "org-1", profile_id: "gone-1", status: "open", clock_in: "2001-01-04T15:00:00.000Z", split_from: null, long_shift_nudged_at: null, profiles: { active: false } },
    // In at 5:00 AM and already asked the 12-hour question at 5:00 PM: one ask per clock.
    { id: "e-asked", org_id: "org-1", profile_id: "asked-1", status: "open", clock_in: "2001-01-04T13:00:00.000Z", split_from: null, long_shift_nudged_at: "2001-01-05T01:00:00.000Z", profiles: { active: true } },
    // Open since yesterday morning: pushed that evening, not again.
    { id: "e-yday", org_id: "org-1", profile_id: "yday-1", status: "open", clock_in: "2001-01-03T16:00:00.000Z", split_from: null, long_shift_nudged_at: null, profiles: { active: true } },
    // Another company's clock (Snowbell): the read names the company, so never here.
    { id: "e-other", org_id: "org-2", profile_id: "other-1", status: "open", clock_in: "2001-01-04T15:00:00.000Z", split_from: null, long_shift_nudged_at: null, profiles: { active: true } },
    // A closed shift: not on the clock.
    { id: "e-done", org_id: "org-1", profile_id: "done-1", status: "closed", clock_in: "2001-01-04T15:00:00.000Z", split_from: null, long_shift_nudged_at: null, profiles: { active: true } },
  ];
  // The owner's first piece, closed at the switch (the family read finds it); and a piece of the same
  // id in another company, from yesterday, which the read must never hand back.
  const KIN: Row[] = [
    { id: "e-own-1", org_id: "org-2", profile_id: "owner-1", status: "closed", clock_in: "2001-01-03T14:00:00.000Z", clock_out: "2001-01-04T20:00:00.000Z", split_from: null, long_shift_nudged_at: null },
    { id: "e-own-1", org_id: "org-1", profile_id: "owner-1", status: "closed", clock_in: "2001-01-04T14:00:00.000Z", clock_out: "2001-01-04T20:00:00.000Z", split_from: null, long_shift_nudged_at: null },
  ];
  /** The eq filters, and the family read's or(): a stand-in that answers only what was asked. */
  const honour = (q: Q, rows: Row[]) =>
    rows.filter((r) =>
      q.filters.every((f) => {
        if (f[0] === "eq") return r[f[1]] === f[2];
        if (f[0] === "or") {
          const ids = String(f[1]).match(/id\.in\.\(([^)]*)\)/)?.[1].split(",") ?? [];
          return ids.includes(r.id) || ids.includes(r.split_from);
        }
        return true;
      }),
    );
  const isPushRead = (q: Q) => q.table === "time_entries" && q.cols.includes("long_shift_nudged_at") && q.cols.includes("profiles:");
  const isFamilyRead = (q: Q) => q.table === "time_entries" && q.cols.startsWith("id, profile_id, clock_in, clock_out");
  const routes = (settings: Record<string, unknown>, over: (q: Q) => Reply = () => undefined) => (q: Q): Reply => {
    const o = over(q);
    if (o) return o;
    if (q.table === "organizations") return orgPage(q, [{ ...LARKSPUR, settings: { ...TZ, ...settings } }]);
    if (isPushRead(q)) return { data: honour(q, OPEN) };
    if (isFamilyRead(q)) return { data: honour(q, KIN) };
    // The text's own reads: Sam Tillery, a tech, still open.
    if (q.table === "profiles") return { data: [{ id: "sam", full_name: "Sam Tillery", phone: "(000) 000-0001", language: "en" }] };
    if (q.table === "time_entries") return { data: [{ profile_id: "sam", status: "open", notes: null }] };
    return undefined;
  };
  const pushedIds = () => spies.people.map((p) => p.ids);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SIX_PM);
  });

  it("Push: everyone on the clock since today, any role, gets ONE push; no text goes, ready or not", async () => {
    textingReady();
    state.client = fakeSupabase(routes({ remind_timeclock_by: "push" }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ due: 1, pushed: 3, push_failed: 0, reminded: 0, not_ready: 0, failed: 0 });
    // One call per person (each push names its own start): the tech, the office and the owner.
    expect(pushedIds()).toEqual([["sam"], ["dana"], ["owner-1"]]);
    for (const p of spies.people) {
      expect(p.org).toBe("org-1");
      expect(p.kind).toBe("clock_out");
      expect(p.en.url).toBe("/timeclock");
      expect(p.es.url).toBe("/timeclock");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // The night debrief still rides the 6 PM run.
    expect(spies.closeOutOrgs).toHaveLength(1);
  });

  it("the words, push-sized, in both languages, with the shift's start in the company's clock", async () => {
    state.client = fakeSupabase(routes({ remind_timeclock_by: "push" }));
    await eod(req());
    const [sam, dana, owner] = spies.people;
    expect(sam.en).toEqual({ title: "Still Clocked In", body: "You've been clocked in since 7:00 AM. Tap to clock out.", url: "/timeclock" });
    expect(sam.es).toEqual({ title: "Sigues con Entrada Marcada", body: "Tienes entrada marcada desde las 7:00 am. Toca para marcar salida.", url: "/timeclock" });
    expect(dana.en.body).toBe("You've been clocked in since 1:05 PM. Tap to clock out.");
    expect(dana.es.body).toBe("Tienes entrada marcada desde la 1:05 pm. Toca para marcar salida.");
    // After a Switch Job at noon the shift still began at 6:00 AM (loadShiftChains, this company's piece only).
    expect(owner.en.body).toBe("You've been clocked in since 6:00 AM. Tap to clock out.");
  });

  it("Text: no push; the tech is texted as before", async () => {
    textingReady();
    state.client = fakeSupabase(routes({ remind_timeclock_by: "text" }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 0, push_failed: 0, reminded: 1, failed: 0 });
    expect(spies.people).toEqual([]);
    expect(sentTexts()).toEqual([{ to: expect.any(String), body: expect.stringMatching(/still clocked in/) }]);
  });

  it("Both: the pushes and the text", async () => {
    textingReady();
    state.client = fakeSupabase(routes({ remind_timeclock_by: "both" }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 3, reminded: 1, failed: 0 });
    expect(pushedIds()).toEqual([["sam"], ["dana"], ["owner-1"]]);
    expect(sentTexts()).toHaveLength(1);
  });

  it("Both, texting not set up: the pushes go, the text is skipped and counted", async () => {
    state.client = fakeSupabase(routes({ remind_timeclock_by: "both" }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 3, reminded: 0, not_ready: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("nothing stored and the old box ticked off reads Push: pushes, no text", async () => {
    textingReady();
    state.client = fakeSupabase(routes({ remind_timeclock: false }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 3, reminded: 0, not_ready: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("nothing stored and the old box on, or absent, reads Both: pushes and the text", async () => {
    textingReady();
    for (const settings of [{ remind_timeclock: true }, {}]) {
      spies.people = [];
      fetchSpy.mockClear();
      state.client = fakeSupabase(routes(settings));
      const body = await (await eod(req())).json();
      expect(body, JSON.stringify(settings)).toMatchObject({ pushed: 3, reminded: 1 });
      expect(sentTexts()).toHaveLength(1);
    }
  });

  it("a stored choice outranks the old box: Text with the box off still texts and does not push", async () => {
    textingReady();
    state.client = fakeSupabase(routes({ remind_timeclock: false, remind_timeclock_by: "text" }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 0, reminded: 1 });
  });

  it("a person who muted clock-out pushes: the bell line is written and that person is not counted as pushed", async () => {
    spies.peopleAnswer = (ids) => ({ bell: true, pushed: ids.filter((id) => id !== "dana") });
    state.client = fakeSupabase(routes({ remind_timeclock_by: "push" }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 2, push_failed: 0, failed: 0 });
    expect(pushedIds()).toEqual([["sam"], ["dana"], ["owner-1"]]);
  });

  it("a refusal from notifyPeople (no bell line) is counted and filed with the company; the others still go", async () => {
    spies.peopleAnswer = (ids) => (ids[0] === "dana" ? { bell: false, pushed: [] } : { bell: true, pushed: ids });
    state.client = fakeSupabase(routes({ remind_timeclock_by: "push" }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 2, push_failed: 1 });
    expect(reportError).toHaveBeenCalledWith("cron-eod", expect.any(Error), { orgId: "org-1", step: "push" });
  });

  it("a failed read of the open shifts pushes NOBODY: counted, filed, never read as nobody on the clock; the text still goes", async () => {
    textingReady();
    state.client = fakeSupabase(routes({ remind_timeclock_by: "both" }, (q) => (isPushRead(q) ? { error: { message: "boom" } } : undefined)));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 0, push_failed: 0, failed: 1, reminded: 1 });
    expect(spies.people).toEqual([]);
    expect(reportError).toHaveBeenCalledWith("cron-eod", { message: "boom" }, { orgId: "org-1", step: "push" });
  });

  it("a failed family read (a switched shift's start) pushes NOBODY either", async () => {
    state.client = fakeSupabase(routes({ remind_timeclock_by: "push" }, (q) => (isFamilyRead(q) ? { error: { message: "boom" } } : undefined)));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ pushed: 0, failed: 1 });
    expect(spies.people).toEqual([]);
    expect(reportError).toHaveBeenCalledWith("cron-eod", { message: "boom" }, { orgId: "org-1", step: "push" });
  });

  it("off the company's 6 PM nobody is pushed", async () => {
    vi.setSystemTime(FIVE_PM);
    state.client = fakeSupabase(routes({ remind_timeclock_by: "push" }));
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ due: 0, pushed: 0 });
    expect(spies.people).toEqual([]);
  });

  it("a company whose plan has ended is not pushed for (Tupelo Panel)", async () => {
    state.client = fakeSupabase((q) =>
      q.table === "organizations"
        ? orgPage(q, [{ ...LAPSED_ORG, name: "Tupelo Panel", settings: { ...TZ, remind_timeclock_by: "push" } }])
        : routes({ remind_timeclock_by: "push" })(q),
    );
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ due: 0, lapsed_skipped: 1, pushed: 0 });
    expect(spies.people).toEqual([]);
  });
});

describe("the 12-hour question, as a text too", () => {
  // Noon Pacific on a day nobody worked; the clock has run thirteen hours, the bell line is done.
  const NOW = new Date("2001-01-02T20:00:00.000Z");
  const row = (phone: string | null) => ({
    id: "entry-1",
    profile_id: "brian-1",
    clock_in: "2001-01-02T07:00:00.000Z",
    long_shift_warned_at: "2001-01-02T17:00:00.000Z",
    long_shift_nudged_at: null,
    job: { job_number: "J-011", name: "Honeysuckle" },
    profiles: { full_name: "Brian Taylor", role: "tech", active: true, phone },
  });
  const routes = (phone: string | null, org: typeof ORG = ORG) => (q: Q): Reply => {
    if (q.table === "organizations") return orgPage(q, [org]);
    if (q.table === "time_entries" && q.verb === "select") return { data: [row(phone)] };
    if (q.table === "time_entries" && q.verb === "update") return { data: [{ id: "entry-1" }] }; // the claim
    return undefined;
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("not ready: the push and the bell ask him, no text goes, and the skip is counted", async () => {
    state.client = fakeSupabase(routes("(530) 555-0100"));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ asked: 1, texted: 0, text_not_ready: 1, office_buzzes: 1, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.push.map((p) => p[1])).toEqual(["clock_out", "long_shift"]); // push stays the primary
  });

  it("ready: he is asked by text as well, in the org's clock", async () => {
    textingReady();
    state.client = fakeSupabase(routes("(530) 555-0100"));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ asked: 1, texted: 1, text_not_ready: 0, office_buzzes: 1, failed: 0 });
    expect(sentTexts()).toEqual([
      {
        to: "+15305550100",
        body: "ET Electric: You've been clocked in at Honeysuckle since Mon 11:00 PM, more than 12 hours. Open Timeclock to set when you stopped.",
      },
    ]);
    expect(spies.push).toHaveLength(2);
  });

  it("a person with no number gets the push and the bell, and nothing is counted against texting", async () => {
    textingReady();
    state.client = fakeSupabase(routes(null));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ asked: 1, texted: 0, text_not_ready: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rides the owner's Text timeclock reminders box: unticked, the push still asks and no text goes", async () => {
    textingReady();
    state.client = fakeSupabase(routes("(530) 555-0100", { ...ORG, settings: { ...TZ, remind_timeclock: false } as typeof ORG.settings }));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ asked: 1, texted: 0, text_off: 1, text_not_ready: 0, office_buzzes: 1, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.push.map((p) => p[1])).toEqual(["clock_out", "long_shift"]);
  });

  it("a business number that isn't a phone number is passed over for the app's sender", async () => {
    textingReady();
    state.client = fakeSupabase(routes("(530) 555-0100", { ...ORG, settings: { ...TZ, sms_from_number: "n/a" } as typeof ORG.settings }));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ texted: 1, failed: 0 });
    const p = (fetchSpy.mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(p.get("From")).toBeNull();
    expect(p.get("MessagingServiceSid")).toBe("MG-test");
  });

  it("a company whose plan has ended is passed over whole — no bell line, no push, no text — and counted (cn-v1137)", async () => {
    textingReady();
    state.client = fakeSupabase(routes("(530) 555-0100", LAPSED_ORG as typeof ORG));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ orgs: 0, asked: 0, texted: 0, office_buzzes: 0, lapsed_skipped: 1, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.push).toEqual([]);
    expect(spies.notify).toEqual([]);
  });

  it("a failed company read is a 500 filed through the waited-for door, never an empty run", async () => {
    state.client = fakeSupabase((q) => (q.table === "organizations" ? { error: { message: "boom" } } : routes("(530) 555-0100")(q)));
    const res = await longShift(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ failed: 1, orgs: 0, asked: 0 });
    expect(reportBlockerAwaited).toHaveBeenCalledWith("cron-long-shift", expect.objectContaining({ message: "organizations could not be read: boom" }));
    expect(reportError).not.toHaveBeenCalled();
    expect(reportErrorAwaited).not.toHaveBeenCalled(); // a blocker, never a plain row (cn-v1136)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * IN EACH PERSON'S LANGUAGE (cn-v1138): `language` rides the people join on the entries read, so an
   * es crew member and an en one in the SAME run are each asked in their own words — push, bell line
   * and text, with the shift's start in their own clock ("lun 11:00 p.m." / "Mon 11:00 PM") — while
   * the office's buzz about each stays English.
   */
  it("an es crew member and an en one in the same run: each is asked in their own words by push, bell and text; the office hears English", async () => {
    textingReady();
    const larkspur = { ...row("(530) 555-0101"), id: "entry-2", profile_id: "larkspur-1", profiles: { full_name: "Larkspur Catbird", role: "tech", active: true, phone: "(530) 555-0101", language: "es" } };
    let entriesRead = "";
    state.client = fakeSupabase((q) => {
      if (q.table === "time_entries" && q.verb === "select") {
        entriesRead = q.cols;
        return { data: [row("(530) 555-0100"), larkspur] };
      }
      return routes("(530) 555-0100")(q);
    });
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ asked: 2, texted: 2, office_buzzes: 2, failed: 0 });
    expect(entriesRead).toContain("profiles:profile_id(full_name, role, active, phone, language)");
    expect(sentTexts()).toEqual([
      { to: "+15305550100", body: "ET Electric: You've been clocked in at Honeysuckle since Mon 11:00 PM, more than 12 hours. Open Timeclock to set when you stopped." },
      { to: "+15305550101", body: "ET Electric: Tienes entrada marcada en Honeysuckle desde lun 11:00 pm, más de 12 horas. Abre el Reloj para poner a qué hora paraste." },
    ]);
    // The pushes: each person's question in their own words, the office's buzz in English about both.
    expect(spies.push.map((p) => [p[0], p[1], p[2].title, p[2].body])).toEqual([
      [["brian-1"], "clock_out", "Still on the Clock?", "You've been clocked in at Honeysuckle since Mon 11:00 PM. Tap to set when you stopped."],
      [["office-1"], "long_shift", "Brian Is Still on the Clock", "Clocked in Mon 11:00 PM at Honeysuckle, 13 hours ago. Brian has been asked when the shift ended. Clock Out Brian on Timecards if you know."],
      [["larkspur-1"], "clock_out", "¿Sigues en el Reloj?", "Tienes entrada marcada en Honeysuckle desde lun 11:00 pm. Toca para poner a qué hora paraste."],
      [["office-1"], "long_shift", "Larkspur Is Still on the Clock", "Clocked in Mon 11:00 PM at Honeysuckle, 13 hours ago. Larkspur has been asked when the shift ended. Clock Out Larkspur on Timecards if you know."],
    ]);
    // The bell line says what the push said, to the same person.
    expect(spies.notify.map((n) => [n[1], n[2].title, n[2].body])).toEqual([
      [["brian-1"], "Still on the Clock?", "You've been clocked in at Honeysuckle since Mon 11:00 PM. Tap to set when you stopped."],
      [["larkspur-1"], "¿Sigues en el Reloj?", "Tienes entrada marcada en Honeysuckle desde lun 11:00 pm. Toca para poner a qué hora paraste."],
    ]);
  });

  it("a failed entries read (the people ride it) asks and texts NOBODY: counted as failed and filed with the company", async () => {
    textingReady();
    state.client = fakeSupabase((q) => (q.table === "time_entries" && q.verb === "select" ? { error: { message: "boom" } } : routes("(530) 555-0100")(q)));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ orgs: 1, asked: 0, texted: 0, office_buzzes: 0, failed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.push).toEqual([]);
    expect(spies.notify).toEqual([]);
    expect(reportError).toHaveBeenCalledWith("cron-long-shift", { message: "boom" }, { orgId: "org-1" });
  });

  it("a text the service refuses is counted as failed and never costs the office its buzz", async () => {
    textingReady();
    fetchSpy.mockResolvedValueOnce(new Response("21610", { status: 400 }));
    state.client = fakeSupabase(routes("(530) 555-0100"));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ asked: 1, texted: 0, failed: 1, office_buzzes: 1 });
  });
});

describe("Text on an invoice", () => {
  const routes = (updates: Q[], row: { status?: string; sent_at?: string | null } = {}, restamp?: Reply) => (q: Q): Reply => {
    if (q.table === "invoices" && q.verb === "select")
      return {
        data: {
          invoice_number: "INV-070",
          total: 150,
          amount_paid: 0,
          status: "draft",
          sent_at: null,
          public_token: "tok",
          org_id: "org-1",
          customers: { name: "Nora", phone: "(530) 555-0142" },
          ...row,
        },
      };
    if (q.table === "invoices" && q.verb === "update") {
      updates.push(q);
      if (restamp && "due_date" in (q.payload ?? {})) return restamp;
      return { data: [{ id: "inv-1" }] };
    }
    if (q.table === "organizations") return { data: { ...ORG, settings: { ...ORG.settings, invoice_due_days: 14 } } };
    return undefined;
  };

  it("not ready: refused where he tapped, nothing sent, the draft is not stamped sent", async () => {
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates));
    expect(await textInvoice("inv-1")).toEqual({ ok: false, notReady: true, error: TEXT_NOT_READY_REFUSAL });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("a company whose plan has ended: refused where he tapped, in his role, nothing sent, nothing stamped (cn-v1137)", async () => {
    textingReady();
    const updates: Q[] = [];
    const lapsed = (role: string) => (q: Q): Reply => {
      if (q.table === "organizations") return { data: { ...LAPSED_ORG, settings: { ...LAPSED_ORG.settings, invoice_due_days: 14 } } };
      if (q.table === "profiles") return peopleFor(role)(q);
      return routes(updates)(q);
    };
    state.client = fakeSupabase(lapsed("owner"));
    expect(await textInvoice("inv-1")).toEqual({ ok: false, error: TEXTING_PAUSED_OWNER });
    state.client = fakeSupabase(lapsed("office"));
    expect(await textInvoice("inv-1")).toEqual({ ok: false, error: TEXTING_PAUSED_CREW });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("ready: texted to the customer and stamped sent", async () => {
    textingReady();
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates));
    expect(await textInvoice("inv-1")).toEqual({ ok: true });
    expect(sentTexts()).toEqual([{ to: "+15305550142", body: expect.stringMatching(/^ET Electric: Invoice INV-070, balance \$150\.00\. View\/pay: .+\/i\/tok$/) }]);
    expect(updates[0].payload).toMatchObject({ status: "sent" });
  });

  /**
   * THE FIRST SEND STARTS THE CLOCK (W1-27): a SECOND write after the status write has landed
   * (updates[0] stays the status write itself), restamping the due date to send day + the terms -
   * only where nobody picked it by hand, scoped to the invoice's own org, and never failing the send.
   */
  it("the first send restamps the due date to send day + the terms, as a second write the status write never waits on", async () => {
    textingReady();
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates));
    expect(await textInvoice("inv-1")).toEqual({ ok: true });
    expect(updates).toHaveLength(2);
    expect(updates[0].payload).toMatchObject({ status: "sent" });
    expect(updates[0].payload).not.toHaveProperty("due_date");
    expect(Object.keys(updates[1].payload)).toEqual(["due_date"]);
    // Send day (in the company's timezone) + Net 14, at noon there.
    const sendDay = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const due = new Date(Date.parse(`${sendDay}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    expect(new Date(updates[1].payload.due_date).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })).toBe(due);
    // A date a person picked is theirs: the guard is in the WHERE, and the write is org-scoped.
    expect(updates[1].filters).toContainEqual(["eq", "due_date_by_hand", false]);
    expect(updates[1].filters).toContainEqual(["eq", "org_id", "org-1"]);
  });

  it("before 0366 (no due_date_by_hand) or on any restamp failure, the date stays and the send still succeeds", async () => {
    textingReady();
    for (const failure of [{ error: { code: "42703", message: 'column "due_date_by_hand" does not exist' } }, { error: { code: "PGRST204" } }, { error: { code: "57014", message: "canceling statement" } }]) {
      const updates: Q[] = [];
      state.client = fakeSupabase(routes(updates, {}, failure));
      expect(await textInvoice("inv-1")).toEqual({ ok: true });
      expect(updates[0].payload).toMatchObject({ status: "sent" });
    }
  });

  it("a re-send never moves the date: it stamps only when the bill went out again", async () => {
    textingReady();
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates, { status: "sent", sent_at: "2026-09-19T20:54:55.199Z" }));
    expect(await textInvoice("inv-1")).toEqual({ ok: true });
    expect(updates.map((u) => Object.keys(u.payload))).toEqual([["sent_at"]]);
  });

  it("a bill that went out, came Back to Draft and goes out again keeps its due date: that isn't the first send", async () => {
    textingReady();
    const updates: Q[] = [];
    // Back to Draft keeps sent_at (Aug 1), so the draft still says the customer has held it since.
    state.client = fakeSupabase(routes(updates, { status: "draft", sent_at: "2026-08-01T18:00:00.000Z" }));
    expect(await textInvoice("inv-1")).toEqual({ ok: true });
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ status: "sent" });
    expect(updates.some((u) => "due_date" in (u.payload ?? {}))).toBe(false);
  });

  it("ready but refused by the service: said plainly, and nothing is stamped", async () => {
    textingReady();
    fetchSpy.mockResolvedValueOnce(new Response("21211", { status: 400 }));
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates));
    expect(await textInvoice("inv-1")).toEqual({ ok: false, error: TEXT_REFUSED });
    expect(updates).toEqual([]);
  });
});

describe("Text on an estimate", () => {
  const routes = (updates: Q[]) => (q: Q): Reply => {
    if (q.table === "quotes" && q.verb === "select")
      return {
        data: {
          quote_number: "Q-101",
          total: 1240,
          public_token: "qt",
          doc_type: "estimate",
          status: "draft",
          customers: null,
          inquiry: { name: "Jill", phone: "530-555-0177" },
        },
      };
    if (q.table === "quotes" && q.verb === "update") {
      updates.push(q);
      return { data: [{ id: "q-1" }] };
    }
    if (q.table === "organizations") return { data: ORG };
    return undefined;
  };

  it("not ready: refused where he tapped, nothing sent, the draft stays a draft", async () => {
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates));
    expect(await textQuote("q-1")).toEqual({ ok: false, notReady: true, error: TEXT_NOT_READY_REFUSAL });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("a company whose plan has ended: refused where he tapped, in his role, nothing sent, the draft stays a draft (cn-v1137)", async () => {
    textingReady();
    const updates: Q[] = [];
    const lapsed = (role: string) => (q: Q): Reply => {
      if (q.table === "organizations") return { data: LAPSED_ORG };
      if (q.table === "profiles") return peopleFor(role)(q);
      return routes(updates)(q);
    };
    state.client = fakeSupabase(lapsed("admin"));
    expect(await textQuote("q-1")).toEqual({ ok: false, error: TEXTING_PAUSED_OWNER });
    state.client = fakeSupabase(lapsed("tech"));
    expect(await textQuote("q-1")).toEqual({ ok: false, error: TEXTING_PAUSED_CREW });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("ready: texted to the lead and marked sent", async () => {
    textingReady();
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates));
    expect(await textQuote("q-1")).toEqual({ ok: true });
    expect(sentTexts()).toEqual([{ to: "+15305550177", body: expect.stringMatching(/^ET Electric: Estimate Q-101 \(\$1240\.00\)\. View: /) }]);
    expect(updates[0].payload).toEqual({ status: "sent" });
  });
});
