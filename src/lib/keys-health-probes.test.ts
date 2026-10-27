import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { scrubSecrets } from "@/lib/scrub-secrets";

/** THE PROBES THE KEYS-HEALTH DOOR LEANS ON (cn-v1129), each on its own. */

describe("scrubSecrets", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("replaces every configured value whose NAME looks like a secret, wherever it appears", () => {
    vi.stubEnv("ACME_API_KEY", "key_0123456789");
    vi.stubEnv("ACME_WEBHOOK_SECRET", "whsec_0123456789");
    vi.stubEnv("ACME_AUTH_TOKEN", "tok_0123456789");
    vi.stubEnv("ACME_ACCOUNT_SID", "AC0123456789abcdef");
    vi.stubEnv("ACME_KEY_P8", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    const s = scrubSecrets("key_0123456789 and whsec_0123456789, tok_0123456789 / AC0123456789abcdef twice AC0123456789abcdef");
    expect(s).toBe("••• and •••, ••• / ••• twice •••");
    expect(scrubSecrets("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe("•••");
  });
  it("leaves values under eight characters and names that are not secrets alone", () => {
    vi.stubEnv("ACME_API_KEY", "short");
    vi.stubEnv("ACME_REGION", "us-west-2-long-enough");
    expect(scrubSecrets("short us-west-2-long-enough")).toBe("short us-west-2-long-enough");
  });
});

describe("apnsSignCheck", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());
  it("signs a provider token with a real EC key and sends nothing", async () => {
    vi.stubEnv("APNS_KEY_ID", "ABCDEF1234");
    vi.stubEnv("APNS_TEAM_ID", "TEAMID1234");
    vi.stubEnv("APNS_KEY_P8", privateKey as string);
    const { apnsSignCheck } = await import("@/lib/apns");
    expect(apnsSignCheck()).toEqual({ ok: true });
  });
  it("a .p8 that is not a key says so in Node's words, never throws", async () => {
    vi.stubEnv("APNS_KEY_ID", "ABCDEF1234");
    vi.stubEnv("APNS_TEAM_ID", "TEAMID1234");
    vi.stubEnv("APNS_KEY_P8", "-----BEGIN PRIVATE KEY-----\nnot a key at all\n-----END PRIVATE KEY-----");
    const { apnsSignCheck } = await import("@/lib/apns");
    const r = apnsSignCheck();
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error.length).toBeGreaterThan(0);
  });
  it("unconfigured is said as which names are missing", async () => {
    vi.stubEnv("APNS_KEY_ID", "");
    vi.stubEnv("APNS_TEAM_ID", "");
    vi.stubEnv("APNS_KEY_P8", "");
    const { apnsSignCheck } = await import("@/lib/apns");
    expect(apnsSignCheck()).toEqual({ ok: false, error: "APNS_KEY_ID, APNS_TEAM_ID or APNS_KEY_P8 is not set" });
  });
});

describe("twilioAccountCheck", () => {
  beforeEach(() => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake_account_for_this_test");
    vi.stubEnv("TWILIO_API_KEY_SID", "SKfake_key_for_this_test");
    vi.stubEnv("TWILIO_API_KEY_SECRET", "secret_0123456789");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("reads one page of one message with the same auth a text uses, and sends nothing", async () => {
    const fetchMock = vi.fn(async () => new Response('{"messages":[]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { twilioAccountCheck } = await import("@/lib/sms");
    expect(await twilioAccountCheck()).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACfake_account_for_this_test/Messages.json?PageSize=1");
    expect(init.method ?? "GET").toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("SKfake_key_for_this_test:secret_0123456789").toString("base64"));
  });
  it("a refusal carries the status and Twilio's words; a dropped connection is ok false, never a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":"Authenticate"}', { status: 401 })));
    const { twilioAccountCheck } = await import("@/lib/sms");
    expect(await twilioAccountCheck()).toEqual({ ok: false, status: 401, error: 'Twilio 401: {"message":"Authenticate"}' });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await twilioAccountCheck()).toEqual({ ok: false, error: "fetch failed" });
  });
  it("unconfigured says which names are missing", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    const { twilioAccountCheck } = await import("@/lib/sms");
    expect(await twilioAccountCheck()).toEqual({ ok: false, error: "TWILIO_ACCOUNT_SID with an API key pair or auth token is not set" });
  });
});
