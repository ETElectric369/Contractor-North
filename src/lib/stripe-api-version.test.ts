import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * THE STRIPE CLIENT NAMES ITS API VERSION, IN ONE PLACE (cn-v1194). Built with the key alone, the
 * client speaks whatever version the installed SDK was built for, so an SDK upgrade moves every call to
 * a newer Stripe API with no line of the app changing. Three things are held here: the one client is
 * built with the named version; the named version is the one the installed SDK was already using, so
 * naming it changed nothing; and no other file builds a client of its own.
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

  it("the named version is the one the installed SDK was built for, so naming it changed nothing", async () => {
    const sdk = readFileSync(join(ROOT, "node_modules/stripe/cjs/apiVersion.js"), "utf8");
    const own = sdk.match(/exports\.ApiVersion = '([^']+)'/);
    expect(own, "the SDK's own version line was not found in node_modules/stripe/cjs/apiVersion.js").not.toBeNull();
    const { STRIPE_API_VERSION } = await import("@/lib/stripe");
    expect(
      STRIPE_API_VERSION,
      "The installed Stripe SDK was built for another API version than the one the app names. Decide the app's " +
        "version on purpose: read Stripe's changelog between the two, then change STRIPE_API_VERSION in src/lib/stripe.ts.",
    ).toBe(own![1]);
  });

  it("no other file builds a Stripe client of its own", () => {
    const builders = sourceFiles("src").filter((f) => /new Stripe\(/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(builders).toEqual(["src/lib/stripe.ts"]);
  });
});
