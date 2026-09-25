import { describe, it, expect } from "vitest";
import {
  CODES_PER_DAY,
  CODE_MAX_TRIES,
  checkRefusalWords,
  codeMatches,
  codeSentWords,
  generateCode,
  hashCode,
  hashSecret,
  isSessionSecret,
  liveCodeWords,
  maskEmail,
  maskPhone,
  minutesUntil,
  newSalt,
  newSessionSecret,
  normalizeCode,
  sendRefusalWords,
} from "./code";
import {
  PORTAL_COOKIE,
  PORTAL_OFFICE_COOKIE,
  PORTAL_OFFICE_COOKIE_SECONDS,
  PORTAL_OFFICE_SESSION_SECONDS,
  PORTAL_SESSION_SECONDS,
  portalCookieOptions,
  portalTokenFromPath,
} from "./session-cookie";

/**
 * 0331's pure half: the code, its hash, the session secret, the masking and the words. The atomic
 * half (one live code, the send window, the try counter, expiry, sessions) is proven against the
 * database in portal-code.integration.test; the server actions that join the two are in
 * app/portal/[token]/actions.test.
 */
const TOKEN = "a".repeat(32);

describe("the code", () => {
  it("is six digits, zero-padded, and not the same twice in a row (in practice)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const c = generateCode();
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(490);
  });

  it("is stored as sha256(salt:code): salted, so the same code hashes apart for two customers", () => {
    const s1 = newSalt();
    const s2 = newSalt();
    expect(s1).toMatch(/^[0-9a-f]{32}$/);
    expect(s1).not.toBe(s2);
    expect(hashCode("123456", s1)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode("123456", s1)).toBe(hashCode("123456", s1));
    expect(hashCode("123456", s1)).not.toBe(hashCode("123456", s2));
    expect(hashCode("123456", s1)).not.toBe(hashCode("123457", s1));
    // The known answer, so a change of scheme can't slip by: sha256("00112233445566778899aabbccddeeff:000000").
    // (computed outside the app: printf '%s' '…:000000' | shasum -a 256)
    expect(hashCode("000000", "00112233445566778899aabbccddeeff")).toBe(
      "44151b4727ebb9b7818574644077eaafaed4055c28faf7d211e710c700d683f1",
    );
  });

  it("matches only the right code, and a malformed stored hash is simply no match", () => {
    const salt = newSalt();
    const stored = hashCode("042917", salt);
    expect(codeMatches("042917", salt, stored)).toBe(true);
    expect(codeMatches("042918", salt, stored)).toBe(false);
    expect(codeMatches("42917", salt, stored)).toBe(false);
    expect(codeMatches("042917", newSalt(), stored)).toBe(false);
    expect(codeMatches("042917", salt, "not-a-hash")).toBe(false);
    expect(codeMatches("042917", salt, stored.toUpperCase())).toBe(false);
  });

  it("reads what a person types or pastes: digits only, exactly six", () => {
    expect(normalizeCode("123456")).toBe("123456");
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
    expect(normalizeCode("12345")).toBeNull();
    expect(normalizeCode("1234567")).toBeNull();
    expect(normalizeCode("abcdef")).toBeNull();
    expect(normalizeCode(123456)).toBeNull();
    expect(normalizeCode(undefined)).toBeNull();
  });
});

describe("the session", () => {
  it("is 32 random bytes in the cookie and only its sha256 in the database", () => {
    const a = newSessionSecret();
    const b = newSessionSecret();
    expect(isSessionSecret(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(hashSecret(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(a)).not.toBe(a);
    expect(hashSecret(a)).toBe(hashSecret(a));
    expect(isSessionSecret("x".repeat(64))).toBe(false);
    expect(isSessionSecret(a.slice(1))).toBe(false);
    expect(isSessionSecret(undefined)).toBe(false);
  });

  it("the cookie: httpOnly, Secure, SameSite=Lax, scoped to this link's pages, 30 days", () => {
    const o = portalCookieOptions(TOKEN);
    expect(PORTAL_COOKIE).toBe("cn_portal");
    expect(o.httpOnly).toBe(true);
    expect(o.secure).toBe(true); // tests run outside development
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe(`/portal/${TOKEN}`);
    expect(o.maxAge).toBe(PORTAL_SESSION_SECONDS);
    expect(PORTAL_SESSION_SECONDS).toBe(30 * 24 * 3600);
    expect(portalCookieOptions(TOKEN, 0).maxAge).toBe(0);
  });

  it("the office's look rides its own cookie, which outlives its 8-hour session so an ended look can say so", () => {
    expect(PORTAL_OFFICE_COOKIE).toBe("cn_portal_office");
    expect(PORTAL_OFFICE_COOKIE).not.toBe(PORTAL_COOKIE);
    expect(PORTAL_OFFICE_SESSION_SECONDS).toBe(8 * 3600);
    expect(PORTAL_OFFICE_COOKIE_SECONDS).toBeGreaterThan(PORTAL_OFFICE_SESSION_SECONDS);
  });

  it("knows a portal page's link from its path, and nothing else", () => {
    expect(portalTokenFromPath(`/portal/${TOKEN}`)).toBe(TOKEN);
    expect(portalTokenFromPath(`/portal/${TOKEN}/`)).toBe(TOKEN);
    expect(portalTokenFromPath(`/portal/${TOKEN}/jobs/22222222-2222-4222-8222-222222222222`)).toBe(TOKEN);
    expect(portalTokenFromPath("/portal/short")).toBeNull();
    expect(portalTokenFromPath(`/i/${TOKEN}`)).toBeNull();
    expect(portalTokenFromPath(`/portal/${TOKEN}x`)).toBeNull();
  });
});

describe("masking", () => {
  it("shows the first letter and the domain, never the name", () => {
    expect(maskEmail("mcpowder@comcast.net")).toBe("m*******@comcast.net");
    expect(maskEmail("  Erik@ETElectric.com ")).toBe("E***@ETElectric.com");
    // A short name doesn't give its length away.
    expect(maskEmail("jo@x.co")).toBe("j***@x.co");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
  });

  it("an address that isn't one masks to null (the page then says to ask the business)", () => {
    for (const bad of [null, undefined, "", "   ", "no-at-sign", "@nobody.com", "someone@", "someone@localhost"]) {
      expect(maskEmail(bad)).toBeNull();
    }
  });

  it("the SMS seam masks a phone to its last four", () => {
    expect(maskPhone("(530) 555-0100")).toBe("•••-•••-0100");
    expect(maskPhone("12")).toBeNull();
  });
});

describe("the words", () => {
  it("counts the tries down, and says when the last one went", () => {
    expect(CODE_MAX_TRIES).toBe(5);
    expect(checkRefusalWords("wrong", "ET Electric", 4)).toBe("That code didn't match. 4 tries left.");
    expect(checkRefusalWords("wrong", "ET Electric", 1)).toBe("That code didn't match. 1 try left.");
    expect(checkRefusalWords("wrong", "ET Electric", 0)).toMatch(/last try\. Send a new code\./);
    expect(checkRefusalWords("expired", "ET Electric")).toMatch(/more than 10 minutes old/);
    expect(checkRefusalWords("used_up", "ET Electric")).toMatch(/Send a new one/);
    expect(checkRefusalWords("no_link", "ET Electric")).toBe("This link was turned off. Ask ET Electric for a new one.");
  });

  it("a refused send says when to try again, rounded up to a whole minute", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(minutesUntil("2026-09-24T12:07:10Z", now)).toBe(8);
    expect(minutesUntil("2026-09-24T12:00:05Z", now)).toBe(1);
    expect(minutesUntil("2026-09-24T11:59:00Z", now)).toBe(1);
    expect(minutesUntil(null, now)).toBe(15);
    expect(sendRefusalWords("too_many", "ET Electric", 8)).toMatch(/try again in 8 minutes/);
    expect(sendRefusalWords("too_many", "ET Electric", 1)).toMatch(/try again in 1 minute\./);
    expect(CODES_PER_DAY).toBe(10);
    expect(sendRefusalWords("day_limit", "ET Electric", 14 * 60 + 5)).toBe(
      "That's as many codes as we send in one day. Use the newest one in your email, try again in about 15 hours, or ask ET Electric for help.",
    );
    expect(sendRefusalWords("day_limit", "ET Electric", 40)).toMatch(/try again in 40 minutes,/);
    expect(sendRefusalWords("no_email", "ET Electric")).toBe(
      "ET Electric doesn't have an email for you yet. Ask them to add it so we can send your code.",
    );
  });

  it("a send says every earlier code stopped working; a code already out says when it went", () => {
    expect(codeSentWords("m*******@comcast.net")).toBe(
      "We sent a 6-digit code to m*******@comcast.net. It works for 10 minutes. Any code we sent before this one no longer works.",
    );
    expect(liveCodeWords("m*******@comcast.net", 0)).toBe("We emailed a code to m*******@comcast.net just now. Enter it below.");
    expect(liveCodeWords("m*******@comcast.net", 1)).toBe("We emailed a code to m*******@comcast.net 1 minute ago. Enter it below.");
    expect(liveCodeWords("m*******@comcast.net", 7)).toMatch(/ 7 minutes ago\. /);
  });

  it("no answer ever prints an address", () => {
    const all = [
      ...(["no_link", "no_email", "too_many", "day_limit", "channel_unavailable", "busy", "send_failed"] as const).map((r) => sendRefusalWords(r, "B", 3)),
      ...(["wrong", "expired", "used_up", "spent", "no_code", "no_link", "format", "busy", "error"] as const).map((r) =>
        checkRefusalWords(r, "B", 2),
      ),
    ];
    for (const w of all) expect(w).not.toMatch(/@/);
  });
});
