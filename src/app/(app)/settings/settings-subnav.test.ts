import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useSearchParams: () => new URLSearchParams("tab=money") }));

import { SettingsSubnav } from "./settings-subnav";
import { LangProvider } from "@/components/lang-provider";
import { SETTINGS_CLUSTER_KEYS, roleLabel, settingsClusterLabel } from "@/lib/settings-words";
import { dict, translator } from "@/lib/i18n";

/**
 * THE SETTINGS SIDE-TAB IN THE PERSON'S LANGUAGE (cn-v1139): the group is Settings → Ajustes
 * (sh_dock_settings, through the SectionSheet's dockTileLabel like a tile's), and every cluster's
 * name comes through lib/settings-words by its id — one explicit map shared with settings/page.tsx
 * — never by a cluster id happening to be a dock row's key. English byte for byte.
 */
const clusters = [
  { id: "you", label: "You" },
  { id: "company", label: "Company" },
  { id: "money", label: "Money" },
  { id: "docs", label: "Estimates & Invoices" },
  { id: "integrations", label: "Connections" },
  { id: "someday", label: "Not Yet Named" },
];
const render = (lang: "en" | "es") =>
  renderToStaticMarkup(createElement(LangProvider, { lang, children: createElement(SettingsSubnav, { clusters, activeTab: "money" }) }));
const words = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** The desktop column's rows, in order. */
const column = (html: string) => Array.from(html.matchAll(/<a\b[^>]*data-tour="settings-[a-z]+"[^>]*>([\s\S]*?)<\/a>/g)).map((m) => words(m[1]));

describe("the Settings side-tab's words", () => {
  it("in English: Settings and the clusters' own labels, byte for byte", () => {
    const html = render("en");
    expect(column(html)).toEqual(["You", "Company", "Money", "Estimates & Invoices", "Connections", "Not Yet Named"]);
    expect(html).toContain('title="Settings — Money"');
  });

  it("in Spanish: Ajustes and the clusters through the map — Tú, Empresa, Dinero, Presupuestos Y Facturas, Conexiones; an id the map does not name keeps its label", () => {
    const html = render("es");
    expect(column(html)).toEqual(["Tú", "Empresa", "Dinero", "Presupuestos Y Facturas", "Conexiones", "Not Yet Named"]);
    expect(html).toContain('title="Ajustes — Dinero"');
    expect(html).not.toContain(">Company<");
  });

  it("every cluster settings/page.tsx declares is in the map, each to a key the catalog holds, Title Case in both languages", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/settings/page.tsx"), "utf8");
    const ids = [...page.matchAll(/id: "([a-z]+)",\n\s+label: (?:"[^"]+"|t\("[a-z_]+"\)),\n\s+icon: /g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(11);
    for (const id of ids) {
      const key = SETTINGS_CLUSTER_KEYS[id];
      expect(key, `cluster "${id}" has no key in lib/settings-words`).toBeDefined();
      for (const lang of ["en", "es"] as const) {
        const text = dict(lang)[key];
        expect(text, `${lang}:${key}`).toBeDefined();
        for (const w of text.split(" ")) expect(w, `${lang}:${key} "${text}"`).toMatch(/^[\p{Lu}&]/u);
      }
    }
    // The English of each key is the literal the page declares (the You tab reads sh_you already).
    for (const id of ids.filter((i) => i !== "you")) {
      const literal = page.match(new RegExp(`id: "${id}",\\n\\s+label: "([^"]+)"`))?.[1];
      expect(dict("en")[SETTINGS_CLUSTER_KEYS[id]], id).toBe(literal);
    }
    expect(settingsClusterLabel("you", translator("es"))).toBe("Tú");
    expect(settingsClusterLabel("company", translator("en"))).toBe("Company");
    expect(settingsClusterLabel("no-such-cluster", translator("es"))).toBeUndefined();
  });

  it("a person's role, by the same kind of map: Owner → Dueño, Admin → Administrador, Office → Oficina, Tech → Técnico", () => {
    const es = translator("es");
    expect(["owner", "admin", "office", "tech"].map((r) => roleLabel(r, es))).toEqual(["Dueño", "Administrador", "Oficina", "Técnico"]);
    expect(["owner", "admin", "office", "tech"].map((r) => roleLabel(r, translator("en")))).toEqual(["Owner", "Admin", "Office", "Tech"]);
    expect(roleLabel("user", es)).toBeUndefined();
    expect(roleLabel(null, es)).toBeUndefined();
  });

  it("the side-tab draws its names through the map, not the raw label, in both shapes (the sheet's rows and the desktop column)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/settings/settings-subnav.tsx"), "utf8");
    expect(src).toContain("const name = (c: SettingsCluster) => settingsClusterLabel(c.id, t) ?? c.label;");
    expect(src).toContain("label: name(c),");
    expect(src).toContain('<span className="relative z-10">{name(c)}</span>');
    expect(src).not.toContain("{c.label}");
    // The group stays "Settings" in the data and reads Ajustes through the dock's key.
    expect(src).toContain('label: "Settings",');
    expect(dict("es").sh_dock_settings).toBe("Ajustes");
  });
});
