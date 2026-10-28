import { describe, it, expect } from "vitest";
import { DOCK, LAPSED_DOCK, visibleDock, type DockNode } from "@/lib/dock";
import { dockLabel, dockTileLabel } from "@/lib/dock-words";
import { dict } from "@/lib/i18n";
import { ALL_ON } from "@/lib/features";

/**
 * THE DOCK'S WORDS IN THE PERSON'S LANGUAGE (cn-v1138). lib/dock.ts keeps its English data; the
 * shell's catalog holds sh_dock_<id> for every tile and row a TECH can see (and the lapsed dock's);
 * dockLabel is the one reader every renderer asks. The English it answers is the dock's own label,
 * byte for byte, so nothing the office or a test reads moved.
 */
const row = (id: string): DockNode => {
  for (const s of [...DOCK, LAPSED_DOCK]) {
    const c = s.children.find((c) => c.id === id);
    if (c) return c;
  }
  throw new Error(`no dock row ${id}`);
};
const section = (key: string) => [...DOCK, LAPSED_DOCK].find((s) => s.key === key)!;
/** Erik's law for a clickable: every word begins with a capital, a digit or a symbol. */
const titleCase = (s: string) => s.split(/\s+/).every((w) => /^[\p{Lu}\p{N}&]/u.test(w));

describe("dockLabel", () => {
  it("a tech's row in Spanish; in English it is the row's own label, byte for byte", () => {
    expect(dockLabel(row("t-day"), "es")).toBe("Mi Día");
    expect(dockLabel(row("ck-clock"), "es")).toBe("Reloj");
    expect(dockLabel(row("j-all"), "es")).toBe("Todos");
    expect(dockLabel(row("j-in_progress"), "es")).toBe("En Curso");
    expect(dockLabel(row("o-comply"), "es")).toBe("Cumplimiento");
    expect(dockLabel(row("o-forms"), "es")).toBe("Formularios");
    expect(dockLabel(row("y-settings"), "es")).toBe("Tus Ajustes");
    expect(dockLabel(row("y-handbook"), "es")).toBe("Manual");
    for (const id of ["t-day", "ck-clock", "j-all", "j-in_progress", "o-comply", "y-settings", "y-handbook"]) {
      expect(dockLabel(row(id), "en"), id).toBe(row(id).label);
    }
  });

  it("a row without a key (the office's) falls back to its label in both languages", () => {
    expect(dockLabel(row("m-inv"), "es")).toBe("Invoices");
    expect(dockLabel(row("ma-payroll"), "es")).toBe("Payroll");
    expect(dockLabel(row("sl-leads"), "en")).toBe("Leads");
    expect(dockLabel({ id: "no-such-row", label: "Whatever It Says" }, "es")).toBe("Whatever It Says");
  });

  it("a row wearing its whenOff words keeps them: the catalog's English is compared to the label first", () => {
    const bills = visibleDock({ isStaff: true, features: { ...ALL_ON, purchase_orders: false } })
      .flatMap((s) => s.children)
      .find((c) => c.id === "m-bills")!;
    expect(bills.label).toBe("Bills");
    expect(dockLabel(bills, "es")).toBe("Bills");
    // The guard itself, on a keyed row handed other words: those words stand.
    expect(dockLabel({ id: "t-day", label: "Something Else" }, "es")).toBe("Something Else");
  });

  it("a tile by its key: Today, Clock, Jobs, You and the lapsed Plan; a tile with no key keeps its words", () => {
    expect(dockTileLabel(section("today"), "es")).toBe("Hoy");
    expect(dockTileLabel(section("clock"), "es")).toBe("Reloj");
    expect(dockTileLabel(section("jobs"), "es")).toBe("Trabajos");
    expect(dockTileLabel(section("you"), "es")).toBe("Tú");
    expect(dockTileLabel(section("office"), "es")).toBe("Oficina");
    expect(dockTileLabel(section("tools"), "es")).toBe("Herramientas");
    expect(dockTileLabel(section("plan"), "es")).toBe("Plan");
    expect(dockTileLabel(section("invoices"), "es")).toBe("Money");
    expect(dockTileLabel(section("jobs"), "en")).toBe("Jobs");
  });

  it("every tile and row a tech can see has a key whose English is the dock's own words, and so does the lapsed dock", () => {
    for (const s of [...visibleDock({ isStaff: false }), LAPSED_DOCK]) {
      expect(dict("en")[`sh_dock_${s.key}`], `tile ${s.key}`).toBe(s.label);
      for (const c of s.children) expect(dict("en")[`sh_dock_${c.id}`], `row ${c.id}`).toBe(c.label);
    }
  });

  it("every sh_dock_ key names a real tile or row and is Title Case in both languages", () => {
    const ids = new Set([...DOCK, LAPSED_DOCK].flatMap((s) => [s.key, ...s.children.map((c) => c.id)]));
    const keys = Object.keys(dict("en")).filter((k) => k.startsWith("sh_dock_"));
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const k of keys) {
      expect(ids.has(k.slice("sh_dock_".length)), k).toBe(true);
      for (const lang of ["en", "es"] as const) expect(titleCase(dict(lang)[k]), `${lang}:${k} "${dict(lang)[k]}"`).toBe(true);
    }
  });
});

describe("the lapsed dock's Download Everything row (cn-v1138)", () => {
  it("is the fourth row, after the accountant's, Title Case in both languages, to Settings › Getting Paid", () => {
    expect(LAPSED_DOCK.children.map((c) => c.id)).toEqual(["lp-pick", "lp-settings", "lp-accountant", "lp-export"]);
    const r = LAPSED_DOCK.children[3];
    expect(r).toMatchObject({ id: "lp-export", label: "Download Everything", href: "/settings?tab=getpaid" });
    expect(titleCase(r.label)).toBe(true);
    expect(dockLabel(r, "es")).toBe("Descargar Todo");
    expect(dockLabel(r, "en")).toBe("Download Everything");
    // Every renderer that reads visibleDock sees it while lapsed, for the owner and the crew alike.
    for (const isStaff of [true, false]) {
      expect(visibleDock({ isStaff, lapsed: true })[0].children.map((c) => c.id)).toContain("lp-export");
    }
  });
});
