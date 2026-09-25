import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashCode, hashSecret } from "@/lib/portal/code";

/**
 * The portal sign-in's server actions (0331), with the database and the mail stubbed: what they
 * hand the database, what they refuse before it, where the code is sent, and the cookie they set.
 * The database's own rules are proven for real in portal-code.integration.test. No email is sent:
 * sendEmail is a stub.
 */
const rpc = vi.fn();
const sendEmail = vi.fn();
const reportError = vi.fn();
const rateLimited = vi.fn();
const jar = new Map<string, { value: string; opts: Record<string, unknown> }>();
let requestCookie: string | undefined;

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
  cookies: async () => ({
    get: (name: string) => (name === "cn_portal" && requestCookie ? { name, value: requestCookie } : undefined),
    set: (name: string, value: string, opts: Record<string, unknown>) => jar.set(name, { value, opts }),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ rpc }) }));
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => reportError(...a) }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimited: (...a: unknown[]) => rateLimited(...a),
  clientIp: (h: Headers) => (h.get("x-forwarded-for") || "").split(",")[0].trim() || "anon",
}));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: (...a: unknown[]) => sendEmail(...a) }));

const { sendPortalCode, checkPortalCode, signOutPortal } = await import("./actions");

const TOKEN = "b".repeat(32);
const ISSUED = {
  ok: true,
  code_id: "11111111-1111-4111-8111-111111111111",
  channel: "email",
  to: "mcpowder@comcast.net",
  expires_at: "2026-09-24T12:10:00Z",
  org: { name: "ET Electric", phone: "(530) 555-0100", email: "office@example.com", glass_tint: "#006d8f" },
};

beforeEach(() => {
  rpc.mockReset();
  sendEmail.mockReset().mockResolvedValue({ ok: true });
  reportError.mockReset();
  rateLimited.mockReset().mockResolvedValue(false);
  jar.clear();
  requestCookie = undefined;
});

describe("Send My Code", () => {
  it("sends the code to the address the DATABASE read off the customer, from the business, and never bccs the owner", async () => {
    rpc.mockResolvedValue({ data: ISSUED, error: null });
    const r = await sendPortalCode(TOKEN);
    expect(r).toEqual({ ok: true, maskedEmail: "m*******@comcast.net" });

    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("portal_code_issue");
    expect(Object.keys(args).sort()).toEqual(["p_channel", "p_hash", "p_salt", "p_token"]); // no address, ever
    expect(args.p_token).toBe(TOKEN);
    expect(args.p_channel).toBe("email");
    expect(args.p_salt).toMatch(/^[0-9a-f]{32}$/);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("mcpowder@comcast.net");
    expect(mail.subject).toBe("Your ET Electric code");
    expect(mail.fromName).toBe("ET Electric");
    expect(mail.replyTo).toBe("office@example.com");
    expect(mail.bcc).toBeUndefined();
    // The code in the email is the one whose salted hash the database holds, and the database never saw it.
    const code = String(mail.html).match(/>(\d{6})</)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    expect(hashCode(code!, args.p_salt)).toBe(args.p_hash);
    expect(JSON.stringify(args)).not.toContain(code!);
    expect(mail.html).toMatch(/works for 10 minutes/);
  });

  it("per-IP ceiling: over it, nothing is asked of the database and nothing is sent (and it fails closed)", async () => {
    rateLimited.mockResolvedValue(true);
    expect(await sendPortalCode(TOKEN)).toEqual({ ok: false, reason: "busy" });
    expect(rpc).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    const [key, limit, windowSeconds, opts] = rateLimited.mock.calls[0];
    expect(key).toBe("portal-code-send:203.0.113.9");
    expect(limit).toBe(10);
    expect(windowSeconds).toBe(3600);
    expect(opts).toEqual({ failClosed: true });
  });

  it("per-link window: 'too_many' comes back with the minutes to wait, nothing sent", async () => {
    const retry = new Date(Date.now() + 7.5 * 60_000).toISOString();
    rpc.mockResolvedValue({ data: { ok: false, reason: "too_many", retry_at: retry }, error: null });
    expect(await sendPortalCode(TOKEN)).toEqual({ ok: false, reason: "too_many", retryMinutes: 8 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("no email on file, or a turned-off link: said, not sent", async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, reason: "no_email" }, error: null });
    expect(await sendPortalCode(TOKEN)).toEqual({ ok: false, reason: "no_email" });
    rpc.mockResolvedValueOnce({ data: { ok: false, reason: "no_link" }, error: null });
    expect(await sendPortalCode(TOKEN)).toEqual({ ok: false, reason: "no_link" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a failed send is never silent: reported, and the customer reads 'couldn't send'", async () => {
    rpc.mockResolvedValue({ data: ISSUED, error: null });
    sendEmail.mockResolvedValue({ ok: false, error: "Email failed: 500" });
    expect(await sendPortalCode(TOKEN)).toEqual({ ok: false, reason: "send_failed" });
    expect(reportError).toHaveBeenCalledWith("portal.codeSend", expect.any(Error));
  });

  it("not a link's shape: no database call at all", async () => {
    expect(await sendPortalCode("../../etc")).toEqual({ ok: false, reason: "no_link" });
    expect(rpc).not.toHaveBeenCalled();
    expect(rateLimited).not.toHaveBeenCalled();
  });
});

describe("Open My Page (the code check)", () => {
  const SALT = "00112233445566778899aabbccddeeff";
  const tryOk = (code: string, left: number) => ({
    data: { state: "check", code_id: ISSUED.code_id, salt: SALT, hash: hashCode(code, SALT), tries_left: left },
    error: null,
  });

  it("not six digits: refused before the database, and it costs no try", async () => {
    expect(await checkPortalCode(TOKEN, "12345")).toEqual({ ok: false, reason: "format" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a wrong code says how many tries are left and signs nothing in", async () => {
    rpc.mockResolvedValueOnce(tryOk("111111", 3));
    expect(await checkPortalCode(TOKEN, "222222")).toEqual({ ok: false, reason: "wrong", triesLeft: 3 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe("portal_code_try");
    expect(jar.size).toBe(0);
  });

  it("expired, out of tries, none waiting: the database's answer, in its own words", async () => {
    for (const state of ["expired", "used_up", "no_code", "no_link"] as const) {
      rpc.mockResolvedValueOnce({ data: { state }, error: null });
      expect(await checkPortalCode(TOKEN, "123456")).toEqual({ ok: false, reason: state });
    }
    expect(jar.size).toBe(0);
  });

  it("the right code: spent with the hash it made, and this device gets a cookie holding a secret whose hash the database keeps", async () => {
    rpc.mockResolvedValueOnce(tryOk("042917", 4)).mockResolvedValueOnce({ data: true, error: null });
    expect(await checkPortalCode(TOKEN, " 042 917 ")).toEqual({ ok: true });

    const [fn, args] = rpc.mock.calls[1];
    expect(fn).toBe("portal_code_redeem");
    expect(args.p_token).toBe(TOKEN);
    expect(args.p_code_id).toBe(ISSUED.code_id);
    expect(args.p_hash).toBe(hashCode("042917", SALT));

    const c = jar.get("cn_portal");
    expect(c?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(c!.value)).toBe(args.p_session_hash);
    expect(args.p_session_hash).not.toBe(c!.value);
    expect(c?.opts).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: `/portal/${TOKEN}`, maxAge: 30 * 24 * 3600 });
  });

  it("spent between the try and now (a second tab, a newer code): said, and no cookie", async () => {
    rpc.mockResolvedValueOnce(tryOk("042917", 4)).mockResolvedValueOnce({ data: false, error: null });
    expect(await checkPortalCode(TOKEN, "042917")).toEqual({ ok: false, reason: "spent" });
    expect(jar.size).toBe(0);
  });

  it("per-IP tries ceiling: over it, no try is spent", async () => {
    rateLimited.mockResolvedValue(true);
    expect(await checkPortalCode(TOKEN, "123456")).toEqual({ ok: false, reason: "busy" });
    expect(rpc).not.toHaveBeenCalled();
    expect(rateLimited.mock.calls[0].slice(0, 3)).toEqual(["portal-code-try:203.0.113.9", 30, 900]);
  });
});

describe("Sign Out On This Device", () => {
  it("ends the session by its hash and clears the cookie on the link's path", async () => {
    requestCookie = "c".repeat(64);
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await signOutPortal(TOKEN)).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("portal_session_end", { p_token: TOKEN, p_session_hash: hashSecret("c".repeat(64)) });
    expect(jar.get("cn_portal")).toMatchObject({ value: "", opts: { path: `/portal/${TOKEN}`, maxAge: 0 } });
  });
});
