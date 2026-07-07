import { describe, it, expect } from "vitest";
import { composeFrom } from "@/lib/email";

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
