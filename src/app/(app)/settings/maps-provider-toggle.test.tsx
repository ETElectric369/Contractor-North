import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict } from "@/lib/i18n";

/**
 * THE MAPS CARD SAYS WHAT THIS DEVICE DOES (cn-v1185). It drew Apple Maps as chosen on a device that
 * had chosen nothing, and offered Apple Maps on an Android phone, where it cannot navigate (a tech's
 * report: "Apple maps does not work on my phone"). A static render is the device before anything is
 * read from it: nothing chosen. What the card does on an Android phone happens in an effect, which a
 * static render has no hand for, so that branch is pinned on the source and the rule it reads is
 * tabled in lib/maps.test.ts.
 */
const { LangProvider } = await import("@/components/lang-provider");
const { MapsProviderToggle } = await import("./maps-provider-toggle");

const en = (el: ReactElement) => renderToStaticMarkup(el);
const es = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="es">{el}</LangProvider>);
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const TOGGLE = src("src/app/(app)/settings/maps-provider-toggle.tsx");

describe("the maps card before anything is chosen", () => {
  it("offers both apps, draws neither as chosen, and says the first tap will ask", () => {
    const html = en(createElement(MapsProviderToggle));
    expect(html).toContain("Apple Maps");
    expect(html).toContain("Google Maps");
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain("seaglass-active");
    expect(html).toContain("Not chosen yet. The first Navigate tap asks.");
    expect(html).toContain("Which app the Navigate buttons open for driving directions.");
    // 44px targets on both buttons.
    expect(html.match(/<button[^>]*\bmin-h-11\b/g)).toHaveLength(2);
  });

  it("in Spanish the sentences follow the reader; the two apps keep their names", () => {
    const html = es(createElement(MapsProviderToggle));
    expect(html).toContain(dict("es").sh_mapsWhich);
    expect(html).toContain(dict("es").sh_mapsNotChosen);
    expect(html).toContain("Apple Maps");
    expect(html).toContain("Google Maps");
    expect(html).not.toMatch(/Which app|Not chosen yet/);
  });
});

describe("a device with no Apple Maps", () => {
  it("the card reads the one rule and offers no choice there", () => {
    expect(TOGGLE).toContain("appleMapsWorksHere(navigator.userAgent)");
    expect(TOGGLE).toContain("mapsProviderHere(stored, navigator.userAgent)");
    // The Android branch returns the one sentence and nothing to tap.
    expect(TOGGLE).toMatch(/if \(!appleWorks\) return <p[^>]*>\{t\("sh_mapsGoogleOnly"\)\}<\/p>;/);
    expect(dict("en").sh_mapsGoogleOnly).toBe("The Navigate buttons open Google Maps on this phone. Apple Maps is only on Apple devices.");
    expect(dict("es").sh_mapsGoogleOnly).toContain("Google Maps");
  });

  it("the Navigate link reads the same rule, so it never asks there and never opens Apple Maps", () => {
    const link = src("src/components/nav-link.tsx");
    expect(link).toContain("setProvider(mapsProviderHere(stored, navigator.userAgent))");
    // The old read obeyed whatever was stored, on every device.
    expect(link).not.toMatch(/if \(p === "google" \|\| p === "apple"\) setProvider\(p\)/);
  });

  it("the card's words are the shell catalog's, and the leak scan reads the file", () => {
    const sh = CATALOGS.find((c) => c.files.includes("src/components/nav-link.tsx"))!;
    expect(sh.files).toContain("src/app/(app)/settings/maps-provider-toggle.tsx");
    for (const k of ["sh_mapsWhich", "sh_mapsNotChosen", "sh_mapsGoogleOnly"] as const) {
      expect(dict("en")[k]).toBeTruthy();
      expect(dict("es")[k]).toBeTruthy();
      expect(dict("es")[k]).not.toBe(dict("en")[k]);
    }
  });
});
