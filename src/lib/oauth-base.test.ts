import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthRedirectBase } from "./oauth-base";

const req = (url: string) => new Request(url);

afterEach(() => vi.unstubAllEnvs());

describe("oauthRedirectBase — the OAuth round-trip stays on the host that holds the cookies", () => {
  it("an app host uses the REQUEST's own origin, even when the env pin points elsewhere", () => {
    // The cutover bug: session + oauth_state cookies are host-only on app.contractornorth.com,
    // but OAUTH_REDIRECT_BASE pinned the callback to vercel.app → ?gcal=denied forever.
    vi.stubEnv("OAUTH_REDIRECT_BASE", "https://contractor-north.vercel.app");
    expect(oauthRedirectBase(req("https://app.contractornorth.com/api/google/connect"))).toBe(
      "https://app.contractornorth.com",
    );
  });

  it("vercel deploy hosts and localhost are app hosts too (each keeps its own round-trip)", () => {
    expect(oauthRedirectBase(req("https://contractor-north.vercel.app/api/google/connect"))).toBe(
      "https://contractor-north.vercel.app",
    );
    expect(oauthRedirectBase(req("http://localhost:3000/api/quickbooks/connect"))).toBe("http://localhost:3000");
  });

  it("a non-app host (an org's custom domain) falls back to the env pin", () => {
    vi.stubEnv("OAUTH_REDIRECT_BASE", "https://app.contractornorth.com");
    expect(oauthRedirectBase(req("https://tahoedeck.com/api/google/connect"))).toBe(
      "https://app.contractornorth.com",
    );
  });
});
