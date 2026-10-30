import { describe, it, expect, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LangProvider } from "@/components/lang-provider";
import { PageHeader } from "@/components/page-header";
import { translator } from "@/lib/i18n";
import { SETTINGS_CLUSTER_KEYS, settingsClusterLabel } from "@/lib/settings-words";
import { words as nav } from "@/lib/words/nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children?: unknown; href: string }) => createElement("a", { href }, children as never),
}));
// The phone's slide-over draws the same rows through the dock's SectionSheet; the desktop column is the proof here.
vi.mock("@/components/section-sheet", () => ({ SectionSheet: () => null }));

import { SettingsSubnav } from "./settings-subnav";

/**
 * THE SETTINGS CLUSTERS IN THE PERSON'S LANGUAGE (cn-v1139, the map in Spanish). The page declares
 * the clusters (settings/page.tsx, each with its English label) and hands the side-tab their names;
 * the side-tab draws them. Both read ONE map, lib/settings-words SETTINGS_CLUSTER_KEYS by cluster id
 * (nv_set_<id>; the You tab is the shell's sh_you), so the word the page hands over and the word the
 * row draws cannot differ — in either direction: the side-tab re-reads the map by id even if a stale
 * server render handed it English. The English of every cluster is byte for byte the label the page
 * declares, and the page's own title is nv_page_settings. (The page is a thousand-line server
 * component over Stripe, QuickBooks and Google Calendar; the parity is proved on the real side-tab
 * and the page's declarations, as settings/clusters.test.ts reads them.)
 */
const dir = join(process.cwd(), "src/app/(app)/settings");
const page = readFileSync(join(dir, "page.tsx"), "utf8");
const subnav = readFileSync(join(dir, "settings-subnav.tsx"), "utf8");
const tEn = translator("en");
const tEs = translator("es");

/** The clusters as the page declares them (the same shape settings/clusters.test.ts reads): id and English label. */
const declared = [...page.matchAll(/id: "([a-z]+)",\n\s+label: (?:"([^"]+)"|t\("([a-z_]+)"\)),\n\s+icon: /g)].map((m) => ({
  id: m[1],
  label: m[2] ?? tEn(m[3]),
}));
/** What page.tsx hands the side-tab in `lang`: each cluster's name through the map, its literal as the fallback. */
const handed = (lang: "en" | "es") => declared.map((c) => ({ id: c.id, label: settingsClusterLabel(c.id, translator(lang)) ?? c.label }));
/** The desktop column's rows, as drawn: [cluster id, the word]. */
const rows = (lang: "en" | "es", clusters: { id: string; label: string }[]) =>
  [
    ...renderToStaticMarkup(
      createElement(LangProvider, { lang } as ComponentProps<typeof LangProvider>, createElement(SettingsSubnav, { clusters, activeTab: "company" })),
    ).matchAll(/<a href="\/settings\?tab=([a-z]+)">([\s\S]*?)<\/a>/g),
  ].map((m) => [m[1], m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()] as [string, string]);

describe("the Settings clusters' words", () => {
  it("the page declares You and the eleven, and the map names every one of them", () => {
    expect(declared.map((c) => c.id).sort()).toEqual(Object.keys(SETTINGS_CLUSTER_KEYS).sort());
    expect(declared).toHaveLength(12);
  });

  it("English: the map's word for each cluster is byte for byte the label the page declares", () => {
    for (const c of declared) expect(settingsClusterLabel(c.id, tEn), c.id).toBe(c.label);
    expect(rows("en", handed("en")).map(([, word]) => word)).toEqual(declared.map((c) => c.label));
  });

  it("Spanish: every cluster reads a Spanish word, and the page's word is the row's word", () => {
    const drawn = rows("es", handed("es"));
    expect(drawn).toHaveLength(12);
    for (const [id, word] of drawn) {
      const c = declared.find((d) => d.id === id)!;
      expect(word, id).toBe(settingsClusterLabel(id, tEs));
      expect(word, id).toBe(handed("es").find((h) => h.id === id)!.label);
      expect(word, `${id} still reads English`).not.toBe(c.label);
    }
    const byId = Object.fromEntries(drawn);
    expect(byId.you).toBe("Tú");
    expect(byId.company).toBe("Empresa");
    expect(byId.getpaid).toBe("Cobros");
    expect(byId.crew).toBe("Cuadrilla Y Tiempo");
    expect(byId.integrations).toBe("Conexiones");
  });

  it("the two cannot disagree: handed English, a Spanish side-tab still draws the map's Spanish, by id", () => {
    expect(rows("es", declared)).toEqual(rows("es", handed("es")));
  });

  it("the page and the side-tab read the ONE map, and the page's title is the catalog's", () => {
    expect(page).toContain('import { settingsClusterLabel } from "@/lib/settings-words";');
    expect(page).toContain("label: settingsClusterLabel(c.id, t) ?? c.label }));");
    expect(subnav).toContain('import { settingsClusterLabel } from "@/lib/settings-words";');
    expect(subnav).toContain("settingsClusterLabel(c.id, t) ?? c.label;");
    // The You tab keeps the shell's own word, on the page and in the map.
    expect(page).toContain('label: t("sh_you"),');
    expect(SETTINGS_CLUSTER_KEYS.you).toBe("sh_you");
    // The page's language is its one profile read (PROFILE_SAFE_COLS carries language); no second query.
    expect(page).toContain("const t = translator(profile?.language);");
    expect(page).not.toContain("currentLang");
    expect(page).toContain('<PageHeader title={t("nv_page_settings")} description={t("nv_desc_settings")} />');
    expect(page).not.toContain('title="Settings"');
    expect(nav.en.nv_page_settings).toBe("Settings");
    expect(nav.en.nv_desc_settings).toBe("Configure every part of your business.");
    const header = (lang: "en" | "es") => {
      const t = translator(lang);
      return renderToStaticMarkup(createElement(PageHeader, { title: t("nv_page_settings"), description: t("nv_desc_settings") }));
    };
    expect(header("en")).toContain(">Settings</h1>");
    expect(header("en")).toContain(">Configure every part of your business.</p>");
    expect(header("es")).toContain(">Ajustes</h1>");
    expect(header("es")).toContain(">Configura cada parte de tu negocio.</p>");
  });
});
