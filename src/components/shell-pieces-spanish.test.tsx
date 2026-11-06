import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGS, dict } from "@/lib/i18n";
import { ALL_ON } from "@/lib/features";
import { esTitleCase } from "../../tests/es-function-words";

/**
 * THE OFF LINE AND THE DIRECTIONS LINK IN SPANISH (the visit-page-in-Spanish wave, cn-v1144): the two
 * shell pieces the visit page draws (components/feature-off-line, components/nav-link) rendered inside
 * a LangProvider with "es" read the shell catalog's words (sh_off, sh_askTheOwner, sh_btn_turnOn,
 * sh_openIn, sh_btn_googleMaps, sh_btn_appleMaps); with no provider they say the English they always
 * said, byte for byte (feature-off-line.test and the job-tabs, bills and route-off-line tests keep
 * pinning that). The maps picker opens on a tap, which a static render has no hand for, so its words
 * are pinned on the source and the catalog.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/settings/features-actions", () => ({ setFeature: vi.fn(async () => ({ ok: true })) }));

const { LangProvider } = await import("@/components/lang-provider");
const { FeatureOffLine } = await import("./feature-off-line");
const { NavLink } = await import("./nav-link");

const es = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="es">{el}</LangProvider>);
const en = (el: ReactElement) => renderToStaticMarkup(el);
const off = (isOwner: boolean) => createElement(FeatureOffLine, { feature: "panel_map", features: { ...ALL_ON, panel_map: false }, isOwner });

describe("the off line speaks Spanish to a Spanish reader", () => {
  it("the owner: Desactivado with a 44px Activar", () => {
    const html = es(off(true));
    expect(html).toContain("Panel Map</span> · Desactivado");
    expect(html).not.toContain("Pídele al Dueño");
    const button = html.match(/<button[^>]*>[^<]*<\/button>/)![0];
    expect(button).toContain(">Activar<");
    expect(button).toMatch(/\bh-11\b/);
    expect(html).not.toMatch(/· Off|Turn On/);
  });

  it("everyone else: Desactivado · Pídele al Dueño, and no button", () => {
    const html = es(off(false));
    expect(html).toContain(" · Desactivado · Pídele al Dueño");
    expect(html).not.toContain("<button");
  });

  it("with no provider the English is the old one, byte for byte", () => {
    expect(en(off(true))).toContain("Panel Map</span> · Off");
    expect(en(off(true))).toContain(">Turn On<");
    expect(en(off(false))).toContain(" · Off · Ask The Owner");
  });
});

describe("the directions link", () => {
  const SRC = readFileSync(join(process.cwd(), "src/components/nav-link.tsx"), "utf8");

  it("renders its caller's words as the door, in either language, before a maps app is chosen", () => {
    const link = <NavLink address="12 Thistlewood Ln, Catbird">Cómo Llegar</NavLink>;
    expect(es(link)).toMatch(/<button type="button" class="[^"]*grow">Cómo Llegar<\/button>/);
    expect(en(link)).toMatch(/<button type="button" class="[^"]*grow">Cómo Llegar<\/button>/);
  });

  it("the first-tap picker reads the catalog: Open in…, and the two apps by their own names", () => {
    expect(SRC).toContain('{t("sh_openIn")}');
    expect(SRC).toContain('{t("sh_btn_googleMaps")}');
    expect(SRC).toContain('{t("sh_btn_appleMaps")}');
    expect(SRC).not.toMatch(/>\s*Google Maps\s*</);
    expect(SRC).not.toMatch(/>\s*Apple Maps\s*</);
    expect(SRC).not.toContain(">Open in…<");
    expect(dict("es").sh_openIn).toBe("Abrir en…");
    expect(dict("es").sh_btn_googleMaps).toBe("Google Maps");
    expect(dict("es").sh_btn_appleMaps).toBe("Apple Maps");
  });
});

describe("the shell keys the wave added (sh_)", () => {
  const sh = CATALOGS.find((c) => c.prefix === "sh_")!;
  const titleCase = (s: string) =>
    s
      .replace(/\{\w+\}/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => /^[¿¡]?[\p{Lu}\p{N}&\/+·(—–]/u.test(w));

  it("names the two screens, every English value is the literal it replaced, and each clickable is Title Case in both languages", () => {
    expect(sh.files).toContain("src/components/feature-off-line.tsx");
    expect(sh.files).toContain("src/components/nav-link.tsx");
    const replaced: Record<string, string> = {
      sh_off: "Off",
      sh_askTheOwner: "Ask The Owner",
      sh_btn_turnOn: "Turn On",
      sh_btn_turningOn: "Turning On…",
      sh_openIn: "Open in…",
      sh_btn_googleMaps: "Google Maps",
      sh_btn_appleMaps: "Apple Maps",
    };
    for (const [k, literal] of Object.entries(replaced)) expect(dict("en")[k], k).toBe(literal);
    for (const k of ["sh_askTheOwner", "sh_btn_turnOn", "sh_btn_turningOn", "sh_btn_googleMaps", "sh_btn_appleMaps"]) {
      expect(titleCase(sh.en[k]), `en:${k}`).toBe(true);
      expect(esTitleCase(sh.es[k]), `es:${k}`).toBe(true); // Spanish: the significant words (cn-v1147)
    }
    // The house words: a switch turns on with Activar (sh_enable) and reads Desactivado off (sh_pushOff…); the owner is el Dueño (nv_role_owner).
    expect(sh.es.sh_btn_turnOn).toBe(dict("es").sh_enable);
    expect(sh.es.sh_off).toBe("Desactivado");
    expect(sh.es.sh_askTheOwner).toContain("Dueño");
    expect(dict("es").nv_role_owner).toBe("Dueño");
    expect(sh.sameInBoth).toEqual(expect.arrayContaining(["sh_btn_googleMaps", "sh_btn_appleMaps"]));
  });
});
