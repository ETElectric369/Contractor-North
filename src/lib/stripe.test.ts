import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * THE ONE SWITCH, SAID OUT LOUD (cn-v1129, the review's integrations-01): billingEnabled is both
 * the paywall switch and the card-payments switch, and an empty STRIPE_SECRET_KEY in production
 * used to open the wall silently. Now the layout's gate files one row per server instance — a
 * BLOCKER (cn-v1136): platform-wide, so its first sighting pages North's own team.
 */
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn() }));

async function fresh() {
  vi.resetModules();
  const blocker = await import("@/lib/observe-blocker");
  vi.mocked(blocker.reportBlocker).mockClear();
  const stripe = await import("@/lib/stripe");
  return { stripe, reportBlocker: vi.mocked(blocker.reportBlocker) };
}

describe("stripeConfigAlarm", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("no key in production: one row, and only one however often the gate runs", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { stripe, reportBlocker } = await fresh();
    stripe.stripeConfigAlarm();
    stripe.stripeConfigAlarm();
    stripe.stripeConfigAlarm();
    expect(reportBlocker).toHaveBeenCalledTimes(1);
    expect(reportBlocker.mock.calls[0][0]).toBe("stripe:config");
    expect((reportBlocker.mock.calls[0][1] as Error).message).toContain("STRIPE_SECRET_KEY is missing");
    expect((reportBlocker.mock.calls[0][1] as Error).message).toContain("paywall is off");
  });

  it("a key present in production: silent", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_present_for_this_test");
    const { stripe, reportBlocker } = await fresh();
    stripe.stripeConfigAlarm();
    expect(reportBlocker).not.toHaveBeenCalled();
  });

  it("no key outside production (dev, CI, preview): silent", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { stripe, reportBlocker } = await fresh();
    stripe.stripeConfigAlarm();
    vi.stubEnv("VERCEL_ENV", "preview");
    stripe.stripeConfigAlarm();
    expect(reportBlocker).not.toHaveBeenCalled();
  });
});

describe("stripeLivemode reads the key itself", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ["sk_test_abc", false],
    ["rk_test_abc", false],
    ["sk_live_abc", true],
    ["rk_live_abc", true],
    ["", false],
  ])("%s → live %s", async (key, live) => {
    vi.stubEnv("STRIPE_SECRET_KEY", key);
    const { stripe } = await fresh();
    expect(stripe.stripeLivemode()).toBe(live);
  });
});

describe("the one place each fact lives (source pins)", () => {
  const tap = readFileSync("src/app/(app)/billing/tap-actions.ts", "utf8");
  const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
  it("Tap to Pay imports stripeLivemode from lib/stripe and keeps no copy", () => {
    expect(tap).toMatch(/import \{[^}]*stripeLivemode[^}]*\} from "@\/lib\/stripe"/);
    expect(tap).not.toContain("function stripeLivemode(");
  });
  it("the app layout sounds the alarm right where the wall is decided", () => {
    const alarm = layout.indexOf("stripeConfigAlarm();");
    const gate = layout.indexOf("if (billingEnabled && org && !hasActiveAccess(org)");
    expect(alarm).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(alarm);
    expect(gate - alarm).toBeLessThan(80);
  });
});
