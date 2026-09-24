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
const spies = vi.hoisted(() => ({ push: [] as any[], notify: [] as any[], closeOut: 0 }));

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
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  createNotifications: vi.fn(async (...a: any[]) => {
    spies.notify.push(a);
    return true;
  }),
}));
vi.mock("@/lib/push", () => ({
  sendPushToProfiles: vi.fn(async (...a: any[]) => void spies.push.push(a)),
  orgStaffIds: vi.fn(async () => ["office-1"]),
  orgStaffIdsOrThrow: vi.fn(async () => ["office-1"]),
}));
vi.mock("@/lib/action-items/eod-sweep", () => ({
  sendCloseOutNudges: vi.fn(async () => {
    spies.closeOut++;
    return { sent: 0 };
  }),
}));

import { GET as nudge } from "./nudge/route";
import { GET as eod } from "./eod-reminder/route";
import { GET as longShift } from "./long-shift/route";
import { textInvoice } from "@/app/(app)/billing/actions";
import { textQuote } from "@/app/(app)/quotes/actions";
import { TEXT_NOT_READY_REFUSAL, TEXT_REFUSED } from "@/lib/sms-readiness";

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
      for (const m of ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "or", "order", "limit"]) {
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
const ORG = { id: "org-1", name: "ET Electric", settings: { ...TZ } };
const req = () => new Request("https://app.test/api", { headers: { authorization: "Bearer x" } });

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const k of TWILIO_KEYS) vi.stubEnv(k, "");
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  spies.push = [];
  spies.notify = [];
  spies.closeOut = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the morning nudge: no clock-in yet", () => {
  const routes = (q: Q): Reply => {
    if (q.table === "organizations") return { data: [ORG] };
    if (q.table === "profiles") return { data: [{ id: "brian-1", full_name: "Brian Taylor", phone: "(530) 555-0100" }] };
    if (q.table === "time_entries") return { data: [] };
    return undefined;
  };

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
    expect(body).toMatchObject({ texted: 1, not_ready: 0 });
    expect(sentTexts()).toEqual([{ to: "+15305550100", body: expect.stringMatching(/haven't clocked in yet/) }]);
  });

  it("an org that turned the reminders off is never texted, ready or not", async () => {
    textingReady();
    state.client = fakeSupabase((q) => (q.table === "organizations" ? { data: [{ ...ORG, settings: { ...TZ, remind_timeclock: false } }] } : routes(q)));
    const body = await (await nudge(req())).json();
    expect(body).toMatchObject({ texted: 0, not_ready: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the evening reminder: still clocked in", () => {
  const routes = (q: Q): Reply => {
    if (q.table === "organizations") return { data: [ORG] };
    if (q.table === "profiles") return { data: [{ id: "brian-1", full_name: "Brian Taylor", phone: "5305550100" }] };
    if (q.table === "time_entries") return { data: [{ profile_id: "brian-1", status: "open", notes: null }] };
    return undefined;
  };

  it("not ready: nothing is sent, the skip is counted, and the night debrief still goes", async () => {
    state.client = fakeSupabase(routes);
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ reminded: 0, not_ready: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spies.closeOut).toBe(1);
  });

  it("ready: the tech is texted", async () => {
    textingReady();
    state.client = fakeSupabase(routes);
    const body = await (await eod(req())).json();
    expect(body).toMatchObject({ reminded: 1, not_ready: 0 });
    expect(sentTexts()).toEqual([{ to: "+15305550100", body: expect.stringMatching(/still clocked in/) }]);
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
    job: { job_number: "J-011", name: "Herringbone" },
    profiles: { full_name: "Brian Taylor", role: "tech", active: true, phone },
  });
  const routes = (phone: string | null, org: typeof ORG = ORG) => (q: Q): Reply => {
    if (q.table === "organizations") return { data: [org] };
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
        body: "ET Electric: You've been clocked in at Herringbone since Mon 11:00 PM, more than 12 hours. Open Timeclock to set when you stopped.",
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

  it("a text the service refuses is counted as failed and never costs the office its buzz", async () => {
    textingReady();
    fetchSpy.mockResolvedValueOnce(new Response("21610", { status: 400 }));
    state.client = fakeSupabase(routes("(530) 555-0100"));
    const body = await (await longShift(req())).json();
    expect(body).toMatchObject({ asked: 1, texted: 0, failed: 1, office_buzzes: 1 });
  });
});

describe("Text on an invoice", () => {
  const routes = (updates: Q[]) => (q: Q): Reply => {
    if (q.table === "invoices" && q.verb === "select")
      return {
        data: {
          invoice_number: "INV-070",
          total: 150,
          amount_paid: 0,
          status: "draft",
          public_token: "tok",
          org_id: "org-1",
          customers: { name: "Nora", phone: "(530) 555-0142" },
        },
      };
    if (q.table === "invoices" && q.verb === "update") {
      updates.push(q);
      return { data: [{ id: "inv-1" }] };
    }
    if (q.table === "organizations") return { data: ORG };
    return undefined;
  };

  it("not ready: refused where he tapped, nothing sent, the draft is not stamped sent", async () => {
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates));
    expect(await textInvoice("inv-1")).toEqual({ ok: false, notReady: true, error: TEXT_NOT_READY_REFUSAL });
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

  it("ready: texted to the lead and marked sent", async () => {
    textingReady();
    const updates: Q[] = [];
    state.client = fakeSupabase(routes(updates));
    expect(await textQuote("q-1")).toEqual({ ok: true });
    expect(sentTexts()).toEqual([{ to: "+15305550177", body: expect.stringMatching(/^ET Electric: Estimate Q-101 \(\$1240\.00\)\. View: /) }]);
    expect(updates[0].payload).toEqual({ status: "sent" });
  });
});
