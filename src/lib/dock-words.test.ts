import { describe, it, expect } from "vitest";
import { DOCK, LAPSED_DOCK, visibleDock, type DockNode } from "@/lib/dock";
import { dockLabel, dockTileLabel } from "@/lib/dock-words";
import { dict } from "@/lib/i18n";
import { ALL_ON } from "@/lib/features";

/**
 * THE DOCK'S WORDS IN THE PERSON'S LANGUAGE (cn-v1138; the office's rows too since cn-v1139).
 * lib/dock.ts keeps its English data; the shell's catalog holds sh_dock_<id> for EVERY tile and row
 * (and the lapsed dock's), a row's whenOff words as sh_dock_<id>_off and a tile's whenOnly words as
 * sh_dock_<tile>_only; dockLabel is the one reader every renderer asks. The English it answers is
 * the dock's own label, byte for byte, so nothing the office or a test reads moved.
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

  it("the office's rows in Spanish too (cn-v1139), the glossary's words: Facturas, Nómina, Tarjetas De Tiempo, Lista De Precios; English byte for byte", () => {
    expect(dockLabel(row("m-inv"), "es")).toBe("Facturas");
    expect(dockLabel(row("ma-payroll"), "es")).toBe("Nómina");
    expect(dockLabel(row("sl-leads"), "es")).toBe("Prospectos");
    expect(dockLabel(row("sl-quotes"), "es")).toBe("Presupuestos");
    expect(dockLabel(row("m-clock"), "es")).toBe("Reloj");
    expect(dockLabel(row("ck-cards"), "es")).toBe("Tarjetas De Tiempo");
    expect(dockLabel(row("m-bills"), "es")).toBe("Cuentas Y Órdenes");
    expect(dockLabel(row("m-recon"), "es")).toBe("Conciliar");
    expect(dockLabel(row("m-price"), "es")).toBe("Lista De Precios");
    expect(dockLabel(row("ma-tax"), "es")).toBe("Reporte De Impuestos");
    expect(dockLabel(row("o-team"), "es")).toBe("Equipo");
    expect(dockLabel(row("ma-stock"), "es")).toBe("Inventario");
    expect(dockLabel(row("o-audit"), "es")).toBe("Auditoría De Actividad");
    for (const id of ["m-inv", "ma-payroll", "sl-leads", "m-bills", "ma-stock"]) expect(dockLabel(row(id), "en"), id).toBe(row(id).label);
    // A row no catalog names (a test's stand-in) reads its own label.
    expect(dockLabel({ id: "no-such-row", label: "Whatever It Says" }, "es")).toBe("Whatever It Says");
  });

  it("a row wearing its whenOff words reads sh_dock_<id>_off (Bills → Cuentas): the catalog's English is compared to the label the row wears", () => {
    const bills = visibleDock({ isStaff: true, features: { ...ALL_ON, purchase_orders: false } })
      .flatMap((s) => s.children)
      .find((c) => c.id === "m-bills")!;
    expect(bills.label).toBe("Bills");
    expect(dockLabel(bills, "es")).toBe("Cuentas");
    expect(dockLabel(bills, "en")).toBe("Bills");
    // The guard itself, on a keyed row handed other words: those words stand.
    expect(dockLabel({ id: "t-day", label: "Something Else" }, "es")).toBe("Something Else");
    expect(dockLabel({ id: "m-bills", label: "Something Else" }, "es")).toBe("Something Else");
  });

  it("a tile by its key: Today, Schedule, Clock, Sales, Jobs, Money, Office, You, Tools and the lapsed Plan", () => {
    expect(dockTileLabel(section("today"), "es")).toBe("Hoy");
    expect(dockTileLabel(section("schedule"), "es")).toBe("Agenda");
    expect(dockTileLabel(section("clock"), "es")).toBe("Reloj");
    expect(dockTileLabel(section("sales"), "es")).toBe("Ventas");
    expect(dockTileLabel(section("jobs"), "es")).toBe("Trabajos");
    expect(dockTileLabel(section("invoices"), "es")).toBe("Dinero");
    expect(dockTileLabel(section("you"), "es")).toBe("Tú");
    expect(dockTileLabel(section("office"), "es")).toBe("Oficina");
    expect(dockTileLabel(section("tools"), "es")).toBe("Herramientas");
    expect(dockTileLabel(section("plan"), "es")).toBe("Plan");
    expect(dockTileLabel(section("jobs"), "en")).toBe("Jobs");
    expect(dockTileLabel(section("invoices"), "en")).toBe("Money");
    // The Money tile has no `short` any more (it equalled the label): the phone bar's `s.short ?? tile` draws the tile's words.
    expect(section("invoices").short).toBeUndefined();
  });

  it("a tile reduced to one row reads sh_dock_<tile>_only: Sales with Leads and Estimates off is Customers → Clientes", () => {
    const sales = visibleDock({ isStaff: true, features: { ...ALL_ON, leads: false, estimates: false } }).find((s) => s.key === "sales")!;
    expect(sales.label).toBe("Customers");
    expect(dockTileLabel(sales, "es")).toBe("Clientes");
    expect(dockTileLabel(sales, "en")).toBe("Customers");
  });

  it("every tile and row anybody can see — a tech's, the office's, the lapsed dock's — has a key whose English is the dock's own words", () => {
    for (const s of [...visibleDock({ isStaff: false }), ...visibleDock({ isStaff: true }), LAPSED_DOCK]) {
      expect(dict("en")[`sh_dock_${s.key}`], `tile ${s.key}`).toBe(s.label);
      for (const c of s.children) expect(dict("en")[`sh_dock_${c.id}`], `row ${c.id}`).toBe(c.label);
    }
    // The two variants and the Settings side-tab's group.
    expect(dict("en")["sh_dock_m-bills_off"]).toBe(DOCK.flatMap((s) => s.children).find((c) => c.id === "m-bills")!.whenOff!.label);
    expect(dict("en").sh_dock_sales_only).toBe(DOCK.find((s) => s.key === "sales")!.whenOnly!.label);
    expect(dict("en").sh_dock_settings).toBe("Settings");
    expect(dict("es").sh_dock_settings).toBe("Ajustes");
  });

  it("every sh_dock_ key names a real tile or row (or its _off / _only variant, or the Settings side-tab's group) and is Title Case in both languages", () => {
    const ids = new Set([...DOCK, LAPSED_DOCK].flatMap((s) => [s.key, ...s.children.map((c) => c.id)]));
    /** Sections a renderer synthesizes the way the dock's are drawn (settings-subnav.tsx's group). */
    const synthesized = new Set(["settings"]);
    const keys = Object.keys(dict("en")).filter((k) => k.startsWith("sh_dock_"));
    expect(keys.length).toBeGreaterThanOrEqual(60);
    for (const k of keys) {
      const id = k.slice("sh_dock_".length).replace(/_(off|only)$/, "");
      expect(ids.has(id) || synthesized.has(id), k).toBe(true);
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
