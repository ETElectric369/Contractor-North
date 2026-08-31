import { describe, it, expect } from "vitest";
import { deriveSiteChrome } from "./site-chrome";
import { getOrgSettings } from "@/lib/org-settings";
import type { PublicOrg } from "@/lib/public-org";

/**
 * THE ESTIMATE-CTA PRECEDENCE (one derivation, every CTA on the public site rides it):
 *   catalog configurator  >  live intake door  >  on-page contact anchor.
 * The intake tier is what finally gave the estimator a visible presence on hosted sites —
 * before it, only external websites ever linked /intake/<handle>. The fallback tier is the
 * no-dead-ends guarantee: door off → buttons quietly return to the contact form, never a 404.
 */

function org(settings: Record<string, unknown>): PublicOrg {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Test Org",
    phone: null,
    email: null,
    license: null,
    logo_url: null,
    city: null,
    state: null,
    updated_at: null,
    settings: getOrgSettings(settings),
  };
}

describe("deriveSiteChrome estimate-CTA precedence", () => {
  it("catalog configurator outranks a live intake door", () => {
    const c = deriveSiteChrome(org({ public_handle: "demo", estimating_mode: "catalog" }), { onHomepage: true, intakeOn: true });
    expect(c.estimateHref).toBe("/estimate/demo");
    expect(c.hasConfigurator).toBe(true);
    expect(c.hasIntake).toBe(false);
    expect(c.hasEstimateDoor).toBe(true);
  });

  it("a live intake door becomes the estimator CTA for non-catalog orgs", () => {
    const c = deriveSiteChrome(org({ public_handle: "demo" }), { onHomepage: true, intakeOn: true });
    expect(c.estimateHref).toBe("/intake/demo");
    expect(c.hasIntake).toBe(true);
    expect(c.hasEstimateDoor).toBe(true);
    expect(c.ctaLabel).toBe("Request a free estimate");
    expect(c.shortCta).toBe("Get an estimate");
  });

  it("door off falls back to the on-page contact anchor — never a dead route", () => {
    const c = deriveSiteChrome(org({ public_handle: "demo" }), { onHomepage: true, intakeOn: false });
    expect(c.estimateHref).toBe("#contact-form");
    expect(c.hasIntake).toBe(false);
    expect(c.hasEstimateDoor).toBe(false);
  });

  it("the owner's own CTA wording still wins on the intake tier", () => {
    const c = deriveSiteChrome(org({ public_handle: "demo", estimate_cta_label: "Price My Project" }), { onHomepage: true, intakeOn: true });
    expect(c.estimateHref).toBe("/intake/demo");
    expect(c.ctaLabel).toBe("Price My Project");
    expect(c.shortCta).toBe("Price My Project");
  });
});
