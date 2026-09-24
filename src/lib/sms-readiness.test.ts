import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * CAN THIS ORG TEXT? (2026-09-24). The one readiness answer every text door asks, and proof that
 * the sender (sendSms) picks its From by the same rule, so "ready" in Settings and "a text would
 * go out" at the door can never disagree. No message is ever sent: fetch is a spy.
 */

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

import { pickSmsSender, smsReadinessFrom, TEXT_NOT_READY_REFUSAL, TEXTS_NOT_READY_LINE } from "./sms-readiness";
import { sendSms, smsEnv, smsReadiness } from "./sms";

const NONE = { account: false, messagingService: false, platformNumber: false };
const ACCOUNT_ONLY = { account: true, messagingService: false, platformNumber: false };

describe("smsReadinessFrom", () => {
  it("today's production: no account, no sender, no number for the business", () => {
    expect(smsReadinessFrom({ env: NONE, orgNumber: "", orgName: "ET Electric" })).toEqual({
      ready: false,
      missing: ["A texting account for the app", "A texting number for ET Electric"],
    });
  });

  it("an account with nothing to send from names only the number", () => {
    expect(smsReadinessFrom({ env: ACCOUNT_ONLY, orgNumber: null, orgName: "ET Electric" })).toEqual({
      ready: false,
      missing: ["A texting number for ET Electric"],
    });
  });

  it("the business's own number without an account names only the account", () => {
    expect(smsReadinessFrom({ env: NONE, orgNumber: "+15305551234", orgName: "ET Electric" })).toEqual({
      ready: false,
      missing: ["A texting account for the app"],
    });
  });

  it("an org with no name still gets a sentence", () => {
    const r = smsReadinessFrom({ env: ACCOUNT_ONLY, orgNumber: "  ", orgName: "  " });
    expect(r).toEqual({ ready: false, missing: ["A texting number for your business"] });
  });

  it("is ready with the account and any one sender, in sendSms's order", () => {
    expect(smsReadinessFrom({ env: ACCOUNT_ONLY, orgNumber: "+15305551234" })).toEqual({ ready: true, sender: "org_number" });
    expect(smsReadinessFrom({ env: { ...ACCOUNT_ONLY, messagingService: true, platformNumber: true } })).toEqual({
      ready: true,
      sender: "messaging_service",
    });
    expect(smsReadinessFrom({ env: { ...ACCOUNT_ONLY, platformNumber: true } })).toEqual({ ready: true, sender: "platform_number" });
    expect(pickSmsSender({ ...ACCOUNT_ONLY, messagingService: true }, "+15305551234")).toBe("org_number");
  });

  it("never names a key, a variable or a vendor in what the owner reads", () => {
    const r = smsReadinessFrom({ env: NONE, orgNumber: "", orgName: "ET Electric" });
    const words = [...(r.ready ? [] : r.missing), TEXTS_NOT_READY_LINE, TEXT_NOT_READY_REFUSAL].join(" ");
    expect(words).not.toMatch(/TWILIO|SID|_|twilio|api key|token/i);
  });
});

describe("smsReadiness and sendSms read the same environment", () => {
  const fetchSpy = vi.fn(async (..._a: unknown[]) => new Response("{}", { status: 201 }));
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID", "TWILIO_FROM_NUMBER"]) {
      vi.stubEnv(k, "");
    }
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const org = (n = "") => ({ name: "ET Electric", settings: { sms_from_number: n } });

  it("not ready: the door is told so, and a send reaches nobody", async () => {
    expect(smsEnv()).toEqual(NONE);
    expect(smsReadiness(org())).toEqual({ ready: false, missing: ["A texting account for the app", "A texting number for ET Electric"] });
    expect(await sendSms("(530) 555-0100", "hi", "")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an account with no sender is still not ready, and still sends nothing", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "t");
    expect(smsReadiness(org())).toEqual({ ready: false, missing: ["A texting number for ET Electric"] });
    expect(await sendSms("(530) 555-0100", "hi", "")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ready on the business's own number: sent From it, in +1 form", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "t");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG-test");
    expect(smsReadiness(org("(530) 555-1234"))).toEqual({ ready: true, sender: "org_number" });
    expect(await sendSms("(530) 555-0100", "hi", "(530) 555-1234")).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC-test/Messages.json");
    const params = init.body as URLSearchParams;
    expect(params.get("To")).toBe("+15305550100");
    expect(params.get("From")).toBe("+15305551234");
    expect(params.get("MessagingServiceSid")).toBeNull();
  });

  it("ready on the platform's messaging service when the business has no number", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
    vi.stubEnv("TWILIO_API_KEY_SID", "SK-test");
    vi.stubEnv("TWILIO_API_KEY_SECRET", "s");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG-test");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15305559999");
    expect(smsReadiness(org())).toEqual({ ready: true, sender: "messaging_service" });
    expect(await sendSms("+15305550100", "hi", "")).toBe(true);
    const params = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as URLSearchParams;
    expect(params.get("MessagingServiceSid")).toBe("MG-test");
    expect(params.get("From")).toBeNull();
  });

  it("ready on the platform's bare number as the last resort", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "t");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15305559999");
    expect(smsReadiness(org())).toEqual({ ready: true, sender: "platform_number" });
    expect(await sendSms("+15305550100", "hi", null)).toBe(true);
    const params = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as URLSearchParams;
    expect(params.get("From")).toBe("+15305559999");
  });

  it("a refusal and a dropped connection both answer false, never throw", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "t");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15305559999");
    fetchSpy.mockResolvedValueOnce(new Response("21610 opted out", { status: 400 }));
    expect(await sendSms("+15305550100", "hi")).toBe(false);
    fetchSpy.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await sendSms("+15305550100", "hi")).toBe(false);
  });
});
