import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE STRIPE CLIENT NAMES ITS API VERSION, IN ONE PLACE (cn-v1194). Built with the key alone, the
 * client speaks whatever version the installed SDK was built for, so an SDK upgrade moves every call to
 * a newer Stripe API with no line of the app changing. Three things are held here: the one client is
 * built with the named version; the named version is a real one and no later than the one the installed
 * SDK was built for; and no other file builds a client of its own.
 *
 * UNTIL cn-v1210 the second of those read "the named version IS the installed SDK's", which was true of
 * SDK 17.7 on the day the version was named and is what made naming it change nothing. The SDK is now
 * 23.1, built for a later API, and the app still speaks the version it names: that is the point of
 * naming it. What every call sends on that version is held in tests/stripe-wire.test.ts.
 */
const built = vi.hoisted(() => [] as unknown[][]);
vi.mock("stripe", () => ({
  default: class {
    constructor(...args: unknown[]) {
      built.push(args);
    }
  },
}));
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn() }));

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

describe("the Stripe client names its API version", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    built.length = 0;
  });

  it("the one client is built with the key and the named version, and only once", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "placeholder-for-this-test");
    vi.resetModules();
    const { getStripe, STRIPE_API_VERSION } = await import("@/lib/stripe");
    getStripe();
    getStripe();
    expect(built).toEqual([["placeholder-for-this-test", { apiVersion: STRIPE_API_VERSION }]]);
  });

  it("the named version is a dated Stripe version, and no later than the one the installed SDK was built for", async () => {
    const sdk = readFileSync(join(ROOT, "node_modules/stripe/cjs/apiVersion.js"), "utf8");
    const own = sdk.match(/exports\.ApiVersion = '([^']+)'/);
    expect(own, "the SDK's own version line was not found in node_modules/stripe/cjs/apiVersion.js").not.toBeNull();
    const { STRIPE_API_VERSION } = await import("@/lib/stripe");
    const dated = /^(\d{4}-\d{2}-\d{2})\.[a-z]+$/;
    expect(STRIPE_API_VERSION).toMatch(dated);
    expect(own![1]).toMatch(dated);
    expect(
      STRIPE_API_VERSION.slice(0, 10) <= own![1].slice(0, 10),
      "The app names a Stripe API version LATER than the one the installed SDK was built for: the SDK knows nothing of it. " +
        "Upgrade the SDK first, or name a version it was built for or an earlier one.",
    ).toBe(true);
  });

  it("no other file builds a Stripe client of its own", () => {
    const builders = sourceFiles("src").filter((f) => /new Stripe\(/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(builders).toEqual(["src/lib/stripe.ts"]);
  });
});
