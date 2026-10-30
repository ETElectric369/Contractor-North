import { describe, it, expect } from "vitest";
import { DOCK, LAPSED_DOCK, visibleDock } from "@/lib/dock";
import { dockLabel, dockTileLabel } from "@/lib/dock-words";
import { translator } from "@/lib/i18n";
import { words as shell } from "@/lib/words/shell";
import { ALL_ON, FEATURE_KEYS, type FeatureMap } from "@/lib/features";
import { helpRows } from "@/lib/onboarding/help-rows";

/**
 * THE HONESTY LINE IS TRUE (cn-v1139, E3). sh_spanishCovers promises the dock, the + menu, search, the
 * account menu, the Settings sections and each page's title in Spanish (not "every menu": a page's
 * own ⋯ menu and tab strip stay English with the page's contents). This is the pin that makes the
 * dock's half a checked claim: every dock the shell can draw — a staff seat's, a
 * tech's, the lapsed company's — is resolved under es the way every renderer resolves it (lib/dock
 * visibleDock → lib/dock-words dockLabel / dockTileLabel: the rail, the phone bar, the section strip
 * and sheet, the avatar menu's rows, Search Or Ask), under every switch, and NO English word may
 * remain on a tile, a row or a header: each label under es differs from its English, equals no
 * English dock word, and shares no word with the English map. The only words allowed to stand are a
 * proper noun (North, Nort, OSHA, QuickBooks, LiDAR, AR) and a word the shell catalog declares the
 * same in both languages on purpose (sameInBoth: "Plan" is the Spanish word too). The help rows
 * (Search Or Ask's with Nort on, the account menu's Help with Nort off) resolve in es by the same rule.
 */
const PROPER_NOUNS = ["North", "Nort", "OSHA", "QuickBooks", "LiDAR", "AR"];
const SAME_BY_DECLARATION = shell.sameInBoth.map((k) => shell.en[k]);
const ALLOWED_SAME = new Set([...PROPER_NOUNS, ...SAME_BY_DECLARATION]);
/** English glue a half-translated label leaks ("Lista of Precios"); "a" is left out: it is a Spanish word too. */
const ENGLISH_GLUE = new Set(["and", "the", "of", "for", "to", "in", "on", "your", "my", "all", "new", "with", "from", "by", "at", "or"]);

const wordsOf = (s: string) => s.split(/[\s·]+/).filter((w) => /\p{L}/u.test(w));

/** Every English word the dock's data carries: tiles, rows, headers, a row's whenOff words, a tile's whenOnly words, a tile's short. */
const ENGLISH_LABELS = new Set<string>();
for (const s of [...DOCK, LAPSED_DOCK]) {
  ENGLISH_LABELS.add(s.label);
  if (s.short) ENGLISH_LABELS.add(s.short);
  if (s.whenOnly) ENGLISH_LABELS.add(s.whenOnly.label);
  for (const c of s.children) {
    ENGLISH_LABELS.add(c.label);
    if (c.whenOff) ENGLISH_LABELS.add(c.whenOff.label);
  }
}
const ENGLISH_WORDS = new Set([...ENGLISH_LABELS].flatMap(wordsOf).map((w) => w.toLowerCase()));

/** Why a label resolved under es is not Spanish, or null when it is. */
function notSpanish(es: string, en: string): string | null {
  if (ALLOWED_SAME.has(en)) return null;
  if (es === en) return `still the English "${en}"`;
  if (ENGLISH_LABELS.has(es)) return `"${es}" is an English dock word`;
  for (const w of wordsOf(es)) {
    if (ALLOWED_SAME.has(w)) continue;
    if (ENGLISH_WORDS.has(w.toLowerCase())) return `"${es}" holds the English word "${w}"`;
    if (ENGLISH_GLUE.has(w.toLowerCase())) return `"${es}" holds the English word "${w}"`;
  }
  return null;
}

type Seat = { name: string; isStaff: boolean; features: FeatureMap; lapsed?: boolean };
const SEATS: Seat[] = [];
for (const isStaff of [true, false]) {
  const who = isStaff ? "staff" : "tech";
  SEATS.push({ name: `${who}, everything on`, isStaff, features: ALL_ON });
  for (const k of FEATURE_KEYS) SEATS.push({ name: `${who}, ${k} off`, isStaff, features: { ...ALL_ON, [k]: false } as FeatureMap });
  SEATS.push({ name: `${who}, Leads and Estimates off (the Sales tile reads Customers)`, isStaff, features: { ...ALL_ON, leads: false, estimates: false } as FeatureMap });
  SEATS.push({ name: `${who}, lapsed`, isStaff, features: ALL_ON, lapsed: true });
}

type Resolved = { where: string; en: string; es: string; own: string };
/** The dock this seat sees, every tile, row and header, resolved in both languages the way the renderers resolve it. */
function resolve(seat: Seat): Resolved[] {
  const out: Resolved[] = [];
  for (const s of visibleDock({ isStaff: seat.isStaff, features: seat.features, lapsed: seat.lapsed })) {
    out.push({ where: `tile ${s.key}`, en: dockTileLabel(s, "en"), es: dockTileLabel(s, "es"), own: s.label });
    for (const c of s.children) out.push({ where: `${c.header ? "header" : "row"} ${c.id}`, en: dockLabel(c, "en"), es: dockLabel(c, "es"), own: c.label });
  }
  return out;
}

describe("the dock in Spanish: the one a staff seat, a tech and a lapsed company see", () => {
  it("under every switch, no English word remains on any tile, row or header resolved under es", () => {
    const problems: string[] = [];
    let labels = 0;
    for (const seat of SEATS) {
      const rows = resolve(seat);
      expect(rows.length, seat.name).toBeGreaterThan(0);
      for (const r of rows) {
        labels++;
        const why = notSpanish(r.es, r.en);
        if (why) problems.push(`${seat.name} › ${r.where}: ${why}`);
      }
    }
    // The floors keep the sweep honest: two roles, a seat per switch, the variants and the lapsed dock.
    expect(SEATS.length).toBeGreaterThanOrEqual(20);
    expect(labels).toBeGreaterThanOrEqual(500);
    expect(problems, "sh_spanishCovers promises the dock: give the row its Spanish in lib/words/shell.ts (sh_dock_<id>)").toEqual([]);
  });

  it("the English side is the dock's own label, byte for byte: nothing moved to make the Spanish true", () => {
    for (const seat of SEATS) for (const r of resolve(seat)) expect(r.en, `${seat.name} › ${r.where}`).toBe(r.own);
  });

  it("a staff seat's tiles: Hoy, Agenda, Ventas, Trabajos, Dinero, Oficina, Herramientas — and the Money and Office headers in Spanish", () => {
    const rows = resolve({ name: "staff", isStaff: true, features: ALL_ON });
    expect(rows.filter((r) => r.where.startsWith("tile")).map((r) => r.es)).toEqual(["Hoy", "Agenda", "Ventas", "Trabajos", "Dinero", "Oficina", "Herramientas"]);
    expect(rows.filter((r) => r.where.startsWith("header")).map((r) => r.es)).toEqual([
      "Facturación", "Administración", "Obligaciones", "Recursos Humanos", "Inventario", "Historial",
    ]);
    expect(rows.find((r) => r.where === "row ma-payroll")?.es).toBe("Nómina");
    expect(rows.find((r) => r.where === "row j-to_be_scheduled")?.es).toBe("Por Programar");
  });

  it("a tech's tiles: Hoy, Reloj, Trabajos, Oficina, Tú, Herramientas — his rows and the two Office headers he keeps, in Spanish", () => {
    const rows = resolve({ name: "tech", isStaff: false, features: ALL_ON });
    expect(rows.filter((r) => r.where.startsWith("tile")).map((r) => r.es)).toEqual(["Hoy", "Reloj", "Trabajos", "Oficina", "Tú", "Herramientas"]);
    expect(rows.filter((r) => r.where.startsWith("header")).map((r) => r.es)).toEqual(["Obligaciones", "Recursos Humanos"]);
    expect(rows.find((r) => r.where === "row ck-clock")?.es).toBe("Reloj");
    expect(rows.find((r) => r.where === "row y-settings")?.es).toBe("Tus Ajustes");
    expect(rows.find((r) => r.where === "row y-handbook")?.es).toBe("Manual");
    // Nothing of the office's leaks onto his: no Money, no Schedule, no staff-only Office row.
    expect(rows.map((r) => r.where)).not.toEqual(expect.arrayContaining(["tile invoices", "tile schedule", "row o-team", "header o-diag-h"]));
  });

  it("the lapsed dock, for the owner and the crew alike: Plan (the one word the same in both, by the catalog's declaration) over four Spanish rows", () => {
    expect(SAME_BY_DECLARATION).toContain("Plan");
    for (const isStaff of [true, false]) {
      const rows = resolve({ name: "lapsed", isStaff, features: ALL_ON, lapsed: true });
      expect(rows.map((r) => r.es)).toEqual(["Plan", "Elegir Un Plan", "Ajustes", "Descargar Para Tu Contador", "Descargar Todo"]);
    }
  });

  it("the variants a switch puts on a row or a tile read Spanish too: Cuentas for Bills, Clientes for the Sales tile reduced to Customers", () => {
    const bills = resolve({ name: "po off", isStaff: true, features: { ...ALL_ON, purchase_orders: false } as FeatureMap }).find((r) => r.where === "row m-bills");
    expect(bills).toMatchObject({ en: "Bills", es: "Cuentas" });
    const sales = resolve({ name: "sales → customers", isStaff: true, features: { ...ALL_ON, leads: false, estimates: false } as FeatureMap }).find((r) => r.where === "tile sales");
    expect(sales).toMatchObject({ en: "Customers", es: "Clientes" });
  });

  it("no tile carries a `short`: the phone bar draws `s.short ?? tile`, and a short is English data no catalog translates", () => {
    for (const s of [...DOCK, LAPSED_DOCK]) expect(s.short, `tile ${s.key}: give it a sh_dock_ key instead of a short`).toBeUndefined();
  });
});

describe("the help rows resolve in es", () => {
  const es = translator("es");
  const en = translator("en");
  const DONE = { full_name: "Pat Lee", trade: "Electrical", city: "Truckee", service_area: "Tahoe", labor_rate: 120 };

  it("Search Or Ask's rows (Nort on) and the account menu's Help rows (Nort off): every label and every sentence of their own differs from the English and holds no English glue", () => {
    const cases = [
      { onboarded: false, setup: {} },
      { onboarded: true, setup: { ...DONE, service_area: null, labor_rate: null } },
      { onboarded: true, setup: DONE },
    ];
    let compared = 0;
    for (const nortOn of [true, false]) {
      for (const c of cases) {
        const rowsEs = helpRows({ isStaff: true, nortOn, features: ALL_ON, t: es, ...c });
        const rowsEn = helpRows({ isStaff: true, nortOn, features: ALL_ON, t: en, ...c });
        expect(rowsEs.map((r) => r.key)).toEqual(rowsEn.map((r) => r.key));
        rowsEs.forEach((r, i) => {
          compared++;
          expect(r.label, `${r.key} label`).not.toBe(rowsEn[i].label);
          for (const w of wordsOf(r.label)) expect(ENGLISH_GLUE.has(w.toLowerCase()), `${r.key} label "${r.label}" holds "${w}"`).toBe(false);
          // Show Me How's line lists the lessons' own titles, which stay English by design
          // (lib/onboarding/help-rows: the lessons and the setup questions are the office's).
          if (r.key === "lessons") return;
          expect(r.sub, `${r.key} sub`).not.toBe(rowsEn[i].sub);
          if (r.key === "finish") expect(r.sub).toMatch(/^Todavía falta: /);
          else for (const w of wordsOf(r.sub)) expect(ENGLISH_GLUE.has(w.toLowerCase()), `${r.key} sub "${r.sub}" holds "${w}"`).toBe(false);
        });
      }
    }
    expect(compared).toBeGreaterThanOrEqual(16);
    // A tech has no help rows in any language (the setup is the office's).
    expect(helpRows({ isStaff: false, onboarded: false, setup: {}, nortOn: true, features: ALL_ON, t: es })).toEqual([]);
  });

  it("the four doors by name, Title Case: Empieza Aquí, Terminar La Configuración · Pendiente: 2, Muéstrame Cómo, Repetir La Configuración", () => {
    expect(helpRows({ isStaff: true, onboarded: false, setup: {}, nortOn: true, features: ALL_ON, t: es }).map((r) => r.label)).toEqual([
      "Empieza Aquí", "Muéstrame Cómo", "Repetir La Configuración",
    ]);
    const finish = helpRows({ isStaff: true, onboarded: true, setup: { ...DONE, service_area: null, labor_rate: null }, nortOn: false, features: ALL_ON, t: es });
    expect(finish.map((r) => r.label)).toEqual(["Terminar La Configuración · Pendiente: 2", "Muéstrame Cómo", "Repetir La Configuración"]);
    for (const r of finish) for (const w of wordsOf(r.label)) expect(w, r.label).toMatch(/^[\p{Lu}\p{N}]/u);
  });
});
