import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE KEYS-HEALTH DOOR (cn-v1129): platform admins only; what is SET as booleans and modes; with
 * ?live=1 each vendor's cheapest authenticated read; and NEVER a key value in the answer, even
 * when a vendor's error echoes one back.
 */
const state = vi.hoisted(() => ({
  ctx: { userId: "admin-1" } as any,
  limited: false,
  balance: vi.fn(async () => ({})),
  price: vi.fn(async () => ({ active: true })),
  livemode: false,
  apns: { ok: true } as any,
  twilio: { ok: true, status: 200 } as any,
  geo: { status: "ok" } as any,
  resend: () => new Response("[]", { status: 200 }),
  refusals: [] as any[],
  orgRead: { data: [{ id: "o" }], error: null } as any,
  googleKey: "AIzaMAPSSERVERSECRET_0123456789",
}));
vi.mock("@/lib/platform-admin", () => ({ requirePlatformAdmin: vi.fn(async () => state.ctx) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => state.limited) }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ balance: { retrieve: state.balance }, prices: { retrieve: state.price } }),
  stripeLivemode: () => state.livemode,
}));
vi.mock("@/lib/apns", () => ({ apnsSignCheck: () => state.apns }));
vi.mock("@/lib/sms", () => ({ twilioAccountCheck: vi.fn(async () => state.twilio) }));
vi.mock("@/lib/geocode-server", () => ({ geocodeAddress: vi.fn(async () => state.geo) }));
vi.mock("@/lib/google-server", () => ({ get GOOGLE_KEY() { return state.googleKey; } }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const result = table === "error_events" ? { data: state.refusals, error: null } : state.orgRead;
      const chain: any = {
        select: () => chain, eq: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
      };
      return chain;
    },
  }),
}));

import { GET } from "./route";
import { geocodeAddress } from "@/lib/geocode-server";

const SECRETS: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_STRIPESECRET_0123456789",
  STRIPE_WEBHOOK_SECRET: "whsec_WEBHOOKSECRET_0123456789",
  STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_CONNECTSECRET_0123456789",
  STRIPE_PRICE_HANDYMAN_MONTHLY: "price_h",
  STRIPE_PRICE_CREW_MONTHLY: "price_c",
  STRIPE_PRICE_COMPANY_MONTHLY: "price_k",
  RESEND_API_KEY: "re_RESENDSECRET_0123456789",
  EMAIL_FROM: "North <noreply@example.com>",
  TWILIO_ACCOUNT_SID: "ACTWILIOSID00000000000000000000000",
  TWILIO_API_KEY_SID: "SKTWILIOKEYSID0000000000000000000",
  TWILIO_API_KEY_SECRET: "TWILIOKEYSECRET_0123456789",
  APNS_KEY_ID: "ABCDEF1234",
  APNS_TEAM_ID: "TEAMID1234",
  APNS_KEY_P8: "-----BEGIN PRIVATE KEY-----\nP8SECRET0123456789\n-----END PRIVATE KEY-----",
  GOOGLE_MAPS_SERVER_KEY: "AIzaMAPSSERVERSECRET_0123456789",
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "AIzaMAPSBROWSERKEY_0123456789",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "eyJSERVICEROLESECRET_0123456789",
  ANTHROPIC_API_KEY: "sk-ant-ANTHROPICSECRET_0123456789",
  CRON_SECRET: "CRONSECRET_0123456789",
};
// Everything above except the public-by-nature values: the sender line, the Supabase URL, the
// price ids, and Apple's team id (printed on every App Store page; the KEY id beside it is scrubbed).
const LEAKABLE = Object.entries(SECRETS).filter(([k]) => !/^(EMAIL_FROM|NEXT_PUBLIC_SUPABASE_URL|STRIPE_PRICE_|APNS_TEAM_ID)/.test(k)).map(([, v]) => v);

const get = async (live: boolean | string = false) => {
  const q = live === true ? "?live=1" : live ? `?live=${live}` : "";
  const res = await GET(new (await import("next/server")).NextRequest(`https://app.example.com/api/keys-health${q}`));
  return { status: res.status, body: await res.json() };
};

describe("the keys-health door", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v);
    for (const k of ["TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID", "TWILIO_FROM_NUMBER", "SUPABASE_SECRET_KEY", "SUPABASE_URL", "GOOGLE_MAPS_API_KEY", "STRIPE_PRICE_EXTRA_USAGE"]) vi.stubEnv(k, "");
    vi.stubGlobal("fetch", vi.fn(async () => state.resend()));
    state.ctx = { userId: "admin-1" };
    state.limited = false;
    state.balance = vi.fn(async () => ({}));
    state.price = vi.fn(async () => ({ active: true }));
    state.livemode = false;
    state.apns = { ok: true };
    state.twilio = { ok: true, status: 200 };
    state.geo = { status: "ok" };
    state.resend = () => new Response("[]", { status: 200 });
    state.refusals = [];
    state.googleKey = SECRETS.GOOGLE_MAPS_SERVER_KEY;
    vi.mocked(geocodeAddress).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is North's own: 401 signed out, 403 for a company's owner, 429 past five looks", async () => {
    state.ctx = { error: "Not signed in." };
    expect((await get()).status).toBe(401);
    state.ctx = { error: "Only North's own team can do that." };
    expect((await get()).status).toBe(403);
    state.ctx = { userId: "admin-1" };
    state.limited = true;
    expect((await get()).status).toBe(429);
  });

  it("without live: what is set, as booleans and a mode, plus the webhook's own refusal rows", async () => {
    state.refusals = [
      { title: "signature matched no secret", event_count: 12, first_seen: "2026-10-20T10:00:00.000Z", last_seen: "2026-10-26T09:00:00.000Z", status: "new" },
      { title: "no webhook secret configured", event_count: 1, first_seen: "2026-10-25T10:00:00.000Z", last_seen: "2026-10-25T10:00:00.000Z", status: "fixed" },
    ];
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.live).toBe(false);
    expect(body.probes).toBeUndefined();
    expect(body.configured.stripe).toEqual({
      secretKey: true, mode: "test", webhookSecret: true, connectWebhookSecret: true,
      prices: { handyman: true, crew: true, company: true, extraUsage: false },
      optionalPrices: ["extraUsage"],
    });
    expect(body.configured.resend).toEqual({ apiKey: true, from: true });
    expect(body.configured.twilio).toEqual({ accountSid: true, apiKeyPair: true, authToken: false, messagingService: false, fromNumber: false });
    expect(body.configured.apns).toEqual({ keyId: true, teamId: true, keyP8: true });
    expect(body.configured.googleMaps).toEqual({ serverKey: true, anyKey: true, browserKey: true });
    expect(body.configured.supabase).toEqual({ url: true, serviceKey: true });
    expect(body.configured.anthropic).toEqual({ apiKey: true, liveCheck: "/api/ai-health?live=1" });
    expect(body.configured.cron).toEqual({ secret: true });
    expect(body.webhookRefusals).toEqual({
      rows: [
        { reason: "signature matched no secret", count: 12, firstSeen: "2026-10-20T10:00:00.000Z", lastSeen: "2026-10-26T09:00:00.000Z", status: "new" },
        { reason: "no webhook secret configured", count: 1, firstSeen: "2026-10-25T10:00:00.000Z", lastSeen: "2026-10-25T10:00:00.000Z", status: "fixed" },
      ],
      lastSeen: "2026-10-26T09:00:00.000Z",
    });
    expect(state.balance).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a missing key reads false, a live key reads live, a Supabase value under a name the app never reads is not a key", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("SUPABASE_SECRET_KEY", "eyJSOMETHINGELSE_0123456789");
    state.livemode = true;
    const { body } = await get();
    expect(body.configured.resend.apiKey).toBe(false);
    expect(body.configured.stripe.mode).toBe("live");
    expect(body.configured.supabase.serviceKey).toBe(false);
  });

  it("only ?live=1 runs the probes: ?live=0 and ?live=false are the plain look", async () => {
    for (const v of ["0", "false"]) {
      const { body } = await get(v);
      expect(body.live).toBe(false);
      expect(body.probes).toBeUndefined();
    }
    expect(state.balance).not.toHaveBeenCalled();
  });

  it("with live: every vendor's cheapest read, and the geocode uses a fresh address", async () => {
    const { body } = await get(true);
    expect(body.live).toBe(true);
    expect(body.probes.stripe.balance).toEqual({ ok: true });
    expect(body.probes.stripe.prices).toEqual({
      handyman: { ok: true },
      crew: { ok: true },
      company: { ok: true },
      extraUsage: { ok: true, note: "STRIPE_PRICE_EXTRA_USAGE is not set (optional): the Add Usage door is hidden" },
    });
    expect(state.price).toHaveBeenCalledTimes(3);
    expect(state.price.mock.calls.map((c: any[]) => c[0])).toEqual(["price_h", "price_c", "price_k"]);
    expect(body.probes.resend).toEqual({ ok: true, status: 200 });
    expect(body.probes.twilio).toEqual({ ok: true, status: 200 });
    expect(body.probes.apns).toEqual({ ok: true });
    expect(body.probes.googleMaps).toEqual({ ok: true });
    expect(body.probes.supabase).toEqual({ ok: true });
    const asked = vi.mocked(geocodeAddress).mock.calls[0][0];
    expect(asked).toMatch(/^\d+ Amphitheatre Parkway, Mountain View, CA 94043$/);
    const again = await get(true);
    expect(again.body.probes.googleMaps.ok).toBe(true);
    expect(vi.mocked(geocodeAddress).mock.calls[1][0]).not.toBe(asked);
  });

  it("the optional Extra usage price (cn-v1140): blank is a note, never a failure; set, it is read like a tier's price and an inactive one is said the same way", async () => {
    expect((await get()).body.configured.stripe.prices.extraUsage).toBe(false);
    vi.stubEnv("STRIPE_PRICE_EXTRA_USAGE", "price-larkspur-1");
    const { body } = await get(true);
    expect(body.configured.stripe.prices.extraUsage).toBe(true);
    expect(body.configured.stripe.optionalPrices).toEqual(["extraUsage"]);
    expect(body.probes.stripe.prices.extraUsage).toEqual({ ok: true });
    expect(state.price).toHaveBeenCalledTimes(4);
    expect(state.price.mock.calls.map((c: any[]) => c[0])).toEqual(["price_h", "price_c", "price_k", "price-larkspur-1"]);
    state.price = vi.fn(async (id?: string) => ({ active: id !== "price-larkspur-1" })) as any;
    const again = await get(true);
    expect(again.body.probes.stripe.prices.extraUsage).toEqual({ ok: false, error: "the price exists but is not active" });
    expect(again.body.probes.stripe.prices.crew).toEqual({ ok: true });
  });

  it("a rejected Stripe key: the balance says 401 with the key scrubbed even when Stripe echoes it, and the prices are still read (a restricted key may lack balance rights yet charge fine)", async () => {
    state.balance = vi.fn(async () => {
      throw Object.assign(new Error(`Invalid API Key provided: ${SECRETS.STRIPE_SECRET_KEY}`), { statusCode: 401 });
    });
    const { body } = await get(true);
    expect(body.probes.stripe.balance.ok).toBe(false);
    expect(body.probes.stripe.balance.status).toBe(401);
    expect(body.probes.stripe.balance.error).toContain("Invalid API Key provided: •••");
    expect(body.probes.stripe.prices.handyman).toEqual({ ok: true });
    expect(state.price).toHaveBeenCalledTimes(3);
  });

  it("a sending-only Resend key cannot list domains and is read as working, said so", async () => {
    state.resend = () => new Response('{"name":"restricted_api_key","message":"This API key is restricted to only send emails"}', { status: 401 });
    const { body } = await get(true);
    expect(body.probes.resend).toEqual({ ok: true, status: 401, note: "a sending-only key: it can send, not list domains" });
  });

  it("no Google key under any of the geocoder's names: said as not set, never as refused", async () => {
    state.googleKey = "";
    const { body } = await get(true);
    expect(body.probes.googleMaps).toEqual({ ok: false, error: "no Google Maps server key is set" });
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it("every other vendor's refusal is said with its status, and nothing throws out of the route", async () => {
    state.resend = () => new Response('{"message":"API key is invalid"}', { status: 401 });
    state.twilio = { ok: false, status: 401, error: "Twilio 401: Authenticate" };
    state.apns = { ok: false, error: "error:1E08010C:DECODER routines::unsupported" };
    state.geo = { status: "failed" };
    state.orgRead = { data: null, error: { message: "JWT expired" } };
    state.price = vi.fn(async () => ({ active: false }));
    const { status, body } = await get(true);
    expect(status).toBe(200);
    expect(body.probes.resend).toEqual({ ok: false, status: 401, error: 'Resend 401: {"message":"API key is invalid"}' });
    expect(body.probes.twilio).toEqual({ ok: false, status: 401, error: "Twilio 401: Authenticate" });
    expect(body.probes.apns.ok).toBe(false);
    expect(body.probes.googleMaps).toEqual({ ok: false, error: "Google did not answer ok (a bad key, the quota, or a timeout)" });
    expect(body.probes.supabase).toEqual({ ok: false, error: "JWT expired" });
    expect(body.probes.stripe.prices.crew).toEqual({ ok: false, error: "the price exists but is not active" });
    state.orgRead = { data: [{ id: "o" }], error: null };
  });

  it("THE LEAK PIN: no configured secret value appears anywhere in either answer, whichever vendor echoes it", async () => {
    state.balance = vi.fn(async () => { throw new Error(`echo ${SECRETS.STRIPE_SECRET_KEY} ${SECRETS.RESEND_API_KEY}`); });
    state.resend = () => new Response(`{"message":"bad key ${SECRETS.RESEND_API_KEY}"}`, { status: 401 });
    state.twilio = { ok: false, status: 404, error: `Twilio 404: The requested resource /2010-04-01/Accounts/${SECRETS.TWILIO_ACCOUNT_SID}/Messages.json was not found` };
    state.apns = { ok: false, error: `bad key ${SECRETS.APNS_KEY_ID} for team ${SECRETS.APNS_TEAM_ID}` };
    state.orgRead = { data: null, error: { message: `JWT ${SECRETS.SUPABASE_SERVICE_ROLE_KEY} expired` } };
    for (const live of [false, true]) {
      const text = JSON.stringify((await get(live)).body);
      for (const v of LEAKABLE) expect(text, `${live ? "live" : "plain"} answer holds a secret`).not.toContain(v);
    }
    state.orgRead = { data: [{ id: "o" }], error: null };
  });
});
