import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { composeFrom, sendEmail } from "@/lib/email";
import { reportError } from "@/lib/observe";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const BASE = "ET Electric <noreply@etelectric369.com>";

describe("composeFrom — per-org sender name over the verified address", () => {
  it("no fromName → the platform EMAIL_FROM verbatim", () => {
    expect(composeFrom(BASE)).toBe(BASE);
    expect(composeFrom(BASE, null)).toBe(BASE);
    expect(composeFrom(BASE, "")).toBe(BASE);
  });

  it("swaps the display name but keeps the verified sending address (DKIM stays aligned)", () => {
    expect(composeFrom(BASE, "Tahoe Deck")).toBe('"Tahoe Deck" <noreply@etelectric369.com>');
  });

  it("works when EMAIL_FROM is a bare address", () => {
    expect(composeFrom("onboarding@resend.dev", "Acme")).toBe('"Acme" <onboarding@resend.dev>');
  });

  it("neutralizes header-injection via the org name (no CRLF / stray address escapes the quotes)", () => {
    const evil = 'Evil" <hacker@evil.com>\r\nBcc: victim@x.com';
    const out = composeFrom(BASE, evil);
    expect(out).not.toMatch(/[\r\n]/); // no header break → no injected Bcc/extra headers
    expect(out.match(/<[^>]+>/g)).toEqual(["<noreply@etelectric369.com>"]); // only the real address is a deliverable address
    expect(out).not.toContain("<hacker@evil.com>"); // the injected address can't function (angle brackets stripped)
    expect(out.startsWith('"')).toBe(true); // the whole payload stays inside the quoted display name
  });

  it("falls back to Contractor North when the name sanitizes to empty", () => {
    expect(composeFrom(BASE, '"""')).toBe('"Contractor North" <noreply@etelectric369.com>');
  });
});

/**
 * A SEND THAT DID NOT GO IS FILED (cn-v1129, the review's integrations-05): the result was
 * returned and two callers dropped it; a dropped connection escaped as a throw. Both land in
 * the error sink now, and the caller still gets { ok: false }.
 */
describe("sendEmail files its failures", () => {
  const filed = () => vi.mocked(reportError).mock.calls.filter((c) => c[0] === "email:send");
  beforeEach(() => {
    vi.mocked(reportError).mockClear();
    vi.stubEnv("RESEND_API_KEY", "re_test_key_for_this_test_only");
    vi.stubEnv("EMAIL_FROM", "Contractor North <noreply@example.com>");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("a refusal from the mail service: ok false as before, and one row with the status and the words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":"The from address is not verified"}', { status: 422 })));
    const out = await sendEmail({ to: "larkspur@example.com", subject: "Your estimate", html: "<p>hi</p>" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("422");
    expect(filed()).toHaveLength(1);
    expect((filed()[0][1] as Error).message).toContain("Resend 422");
    expect(filed()[0][2]).toEqual({ toDomain: "example.com", status: 422 }); // the domain, never the person or the subject
  });

  it("a dropped connection: no throw to the caller, ok false, and one row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const out = await sendEmail({ to: "larkspur@example.com", subject: "Your estimate", html: "<p>hi</p>" });
    expect(out).toEqual({ ok: false, error: "Email failed: the mail service could not be reached." });
    expect(filed()).toHaveLength(1);
    expect((filed()[0][1] as Error).message).toBe("fetch failed");
    expect(filed()[0][2]).toEqual({ toDomain: "example.com" });
  });

  it("a send that went files nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"id":"em_1"}', { status: 200 })));
    expect(await sendEmail({ to: "larkspur@example.com", subject: "s", html: "h" })).toEqual({ ok: true });
    expect(filed()).toHaveLength(0);
  });
});
