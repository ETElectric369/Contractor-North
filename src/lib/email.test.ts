import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { composeFrom, renderPlatformNoticeEmail, sendEmail } from "@/lib/email";
import { reportError } from "@/lib/observe";
import { reportBlocker } from "@/lib/observe-blocker";

vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn() }));

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

/**
 * THE KEY IS DEAD (cn-v1136): a 401 or 403 from Resend refuses every company's mail until the key
 * is replaced — a BLOCKER, which pages North's own team on its first sighting. Every other refusal
 * is one email's trouble and stays an error.
 */
describe("sendEmail: a refused key is a blocker", () => {
  beforeEach(() => {
    vi.mocked(reportError).mockClear();
    vi.mocked(reportBlocker).mockClear();
    vi.stubEnv("RESEND_API_KEY", "re_test_key_for_this_test_only");
    vi.stubEnv("EMAIL_FROM", "Contractor North <noreply@example.com>");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([401, 403])("Resend %s: ok false as before, one blocker row with the status and the domain, no plain error row", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"message":"API key is invalid"}', { status })));
    const out = await sendEmail({ to: "larkspur@example.com", subject: "Your estimate", html: "<p>hi</p>" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain(String(status));
    expect(reportBlocker).toHaveBeenCalledTimes(1);
    const [where, err, extra] = vi.mocked(reportBlocker).mock.calls[0];
    expect(where).toBe("email:send");
    expect((err as Error).message).toBe(`Resend ${status}: {"message":"API key is invalid"}`);
    expect(extra).toEqual({ toDomain: "example.com", status });
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([400, 422, 429, 500])("Resend %s stays an error, never a blocker", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    await sendEmail({ to: "larkspur@example.com", subject: "s", html: "h" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportBlocker).not.toHaveBeenCalled();
  });

  it("a dropped connection stays an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await sendEmail({ to: "larkspur@example.com", subject: "s", html: "h" });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportBlocker).not.toHaveBeenCalled();
  });
});

/**
 * A NOTE FROM NORTH ITSELF (cn-v1137): the billing notices are North writing to the contractor, not
 * the contractor writing to a customer — North's header, no "Hi <name>", signed "— Contractor North",
 * and no company's name anywhere in it. The words go through the same escape as every other email.
 */
describe("renderPlatformNoticeEmail — a note from North itself", () => {
  const html = renderPlatformNoticeEmail({
    heading: "Your Free Trial Ends In 5 Days",
    message: "Pick a plan in Settings › Getting Paid to keep the crew working.",
    cta: { label: "Open Settings", href: "https://app.contractornorth.com/settings?tab=getpaid" },
  });

  it("North's header, the heading and the message, signed — Contractor North, and no Hi <name>", () => {
    expect(html).toContain('<div style="font-size:20px;font-weight:700">Contractor North</div>');
    expect(html).toContain("Your Free Trial Ends In 5 Days");
    expect(html).toContain("Pick a plan in Settings › Getting Paid to keep the crew working.");
    expect(html).toContain("— Contractor North");
    expect(html).not.toMatch(/\bHi\b/);
    expect(html).not.toContain("Thank you");
  });

  it("the button carries its words and its address; without a cta there is no button", () => {
    expect(html).toContain('<a href="https://app.contractornorth.com/settings?tab=getpaid"');
    expect(html).toContain(">Open Settings</a>");
    const plain = renderPlatformNoticeEmail({ heading: "Your Subscription Has Ended", message: "Pick a plan to continue." });
    expect(plain).not.toContain("<a ");
    expect(plain).toContain("Your Subscription Has Ended");
  });

  it("escapes the heading, the message and the button's words, and a quote in the address cannot open a second attribute", () => {
    const hostile = renderPlatformNoticeEmail({
      heading: "<script>alert(1)</script> & co",
      message: "a < b > c",
      cta: { label: "<b>Open</b>", href: 'https://x.test/?a="onmouseover="alert(1)' },
    });
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(hostile).toContain("a &lt; b &gt; c");
    expect(hostile).toContain("&lt;b&gt;Open&lt;/b&gt;");
    expect(hostile).toContain('href="https://x.test/?a=&quot;onmouseover=&quot;alert(1)"');
    expect(hostile).not.toContain('"onmouseover="');
  });

  it("takes no company, so no company's name can leak into another's mail: the only name in it is North's", () => {
    const names = [...html.matchAll(/font-weight:700">([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual(["Contractor North"]);
    expect(html).not.toContain("Larkspur");
  });
});
