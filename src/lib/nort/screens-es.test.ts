import { describe, it, expect } from "vitest";
import { DOCK, type DockNode, type DockSection } from "@/lib/dock";
import { dockLabel, dockTileLabel } from "@/lib/dock-words";
import { dict } from "@/lib/i18n";
import { SCREENS, TILE_WORD_KEYS, screenPromptBlock } from "@/lib/nort/screens";

/**
 * NORT KNOWS THE SPANISH NAMES (cn-v1139). A Spanish reader's dock says Ventas, Dinero,
 * Presupuestos; the prompt block that tells Nort where every screen is used to say Sales, Money,
 * Estimates and nothing else, so "abre Ventas" was a guess. Under es each `- name path` line keeps
 * its place and gains "(es: …)", read from the SAME catalog key the dock and the page title read,
 * and one line names the tiles whose word is not a screen's own. Under en the block is byte for
 * byte what it was (tests/field-1014-screen.test.ts pins that text; this file pins the Spanish).
 */
const pair = (s: (typeof SCREENS)[number]) => `- ${s.name} ${s.path}`;
const fold = (s: string) => s.trim().toLowerCase();
const rowById = (id: string): DockNode | undefined => {
  for (const s of DOCK) {
    const c = s.children.find((c) => c.id === id);
    if (c) return c;
  }
  return undefined;
};
const sectionByKey = (key: string): DockSection | undefined => DOCK.find((s) => s.key === key);

describe("screenPromptBlock under es", () => {
  const staffEn = screenPromptBlock(true);
  const staffEs = screenPromptBlock(true, "es");
  const techEn = screenPromptBlock(false);
  const techEs = screenPromptBlock(false, "es");

  it("en is unchanged: the default is English, and English carries no second-language word", () => {
    expect(screenPromptBlock(true, "en")).toBe(staffEn);
    expect(screenPromptBlock(false, "en")).toBe(techEn);
    for (const b of [staffEn, techEn]) {
      expect(b).not.toContain("(es:");
      expect(b).not.toContain("tiles in this person's language");
      expect(b).toContain("SCREENS AND THEIR SPOTS (anchor names in [brackets]; <…> is a placeholder you fill):");
    }
  });

  it("es keeps every `- name path` pair, in the registry's order, for the office and for a tech", () => {
    for (const [en, es, staff] of [
      [staffEn, staffEs, true],
      [techEn, techEs, false],
    ] as const) {
      const mine = SCREENS.filter((s) => staff || !s.staffOnly);
      const atEn = mine.map((s) => en.indexOf(pair(s)));
      const atEs = mine.map((s) => es.indexOf(pair(s)));
      for (let i = 0; i < mine.length; i++) {
        expect(atEn[i], `${pair(mine[i])} in en`).toBeGreaterThan(-1);
        expect(atEs[i], `${pair(mine[i])} in es`).toBeGreaterThan(-1);
        if (i) {
          expect(atEn[i]).toBeGreaterThan(atEn[i - 1]);
          expect(atEs[i]).toBeGreaterThan(atEs[i - 1]);
        }
      }
      // Nothing an office line carries was lost on the way: the mark, the query clause, the spots.
      for (const s of mine) {
        const line = es.split("\n").find((l) => l.startsWith(pair(s)))!;
        expect(line, pair(s)).toBeDefined();
        if (s.staffOnly) expect(line).toContain(" (office only)");
        if (s.say) expect(line).toContain(` — ${s.say}`);
        for (const sp of s.spots ?? []) expect(line).toContain(`[${sp.name}] ${sp.say}`);
      }
    }
  });

  it("every screen has a Spanish name, from a real catalog key whose English is the screen's own word", () => {
    for (const s of SCREENS) {
      const en = dict("en")[s.word];
      const es = dict("es")[s.word];
      expect(en, `${s.name}: ${s.word} is not a catalog key`).toBeDefined();
      expect(es, `${s.name}: ${s.word} has no Spanish`).toBeDefined();
      expect(es, `${s.name}: ${s.word} reads English in Spanish`).not.toBe(en);
      // The key names THIS screen: "Job" is in "A job", "Inspection" in "An inspection (the visit sheet)".
      expect(fold(s.name), `${s.name} ↔ ${s.word} "${en}"`).toContain(fold(en));
      expect(staffEs).toContain(`${pair(s)} (es: ${es})`);
      if (s.staffOnly) expect(staffEs).toContain(`${pair(s)} (es: ${es}) (office only)`);
    }
    // The header says what the parenthesis is, once.
    expect(staffEs).toContain('"(es: …)" is the screen\'s name in this person\'s language');
  });

  it("the Spanish words ARE the dock's words: a sh_dock_ key names a real row or tile and reads what dockLabel / dockTileLabel read", () => {
    let fromDock = 0;
    for (const s of SCREENS) {
      if (!s.word.startsWith("sh_dock_")) continue;
      const id = s.word.slice("sh_dock_".length);
      const row = rowById(id);
      const tile = sectionByKey(id);
      expect(row ?? tile, `${s.word}: no dock row or tile ${id}`).toBeDefined();
      const want = row ? dockLabel(row, "es") : dockTileLabel(tile!, "es");
      expect(dict("es")[s.word], s.word).toBe(want);
      expect(staffEs).toContain(`${pair(s)} (es: ${want})`);
      fromDock++;
    }
    expect(fromDock).toBeGreaterThanOrEqual(14);
    // The others are a page's title (nav catalog, pinned to its dock row by tests/nav-titles-match-dock)
    // or the word the app shows a record by — never a string typed into the registry.
    for (const s of SCREENS) {
      if (s.word.startsWith("sh_dock_")) continue;
      expect(s.word, s.name).toMatch(/^(nv_page_|sh_|jb_)/);
    }
    expect(SCREENS.find((s) => s.path === "/quotes")?.word).toBe("sh_dock_sl-quotes");
    expect(staffEs).toContain("- Estimates /quotes (es: Presupuestos) (office only)");
    expect(staffEs).toContain("- Invoices /billing (es: Facturas) (office only)");
    expect(staffEs).toContain("- Leads /leads (es: Prospectos) (office only)");
    expect(staffEs).toContain("- Schedule /schedule (es: Agenda) (office only)");
    expect(techEs).toContain("- My Day /planner (es: Mi Día)");
    expect(techEs).toContain("- Clock /timeclock (es: Reloj)");
  });

  it("the tile line: Ventas = Sales, Dinero = Money, Agenda = Schedule (and Hoy = Today), from the dock's data and words", () => {
    expect(staffEs).toContain("- The dock's tiles in this person's language: Ventas = Sales → /leads · Dinero = Money → /billing · Agenda = Schedule → /schedule · Hoy = Today → /planner");
    for (const k of TILE_WORD_KEYS) {
      const tile = sectionByKey(k)!;
      expect(tile, k).toBeDefined();
      expect(staffEs).toContain(`${dockTileLabel(tile, "es")} = ${tile.label} → ${tile.href}`);
      expect(dockTileLabel(tile, "es")).not.toBe(tile.label);
    }
    // The three the office taps every day land where the dock lands them.
    expect(sectionByKey("sales")!.href).toBe("/leads");
    expect(sectionByKey("invoices")!.href).toBe("/billing");
    expect(sectionByKey("schedule")!.href).toBe("/schedule");
    // The line sits with the screens, before the shell's spots.
    expect(staffEs.indexOf("- The dock's tiles in this person's language:")).toBeLessThan(staffEs.indexOf("- On every screen:"));
  });

  it("a tech's es block names a tech's doors only: his Hoy tile, no Ventas, Dinero or Agenda, no office screen", () => {
    expect(techEs).toContain("- The dock's tiles in this person's language: Hoy = Today → /planner");
    for (const w of ["Ventas", "Dinero", "Agenda", "(office only)", "/leads", "/billing"]) expect(techEs).not.toContain(w);
    for (const s of SCREENS) if (s.staffOnly) expect(techEs).not.toContain(pair(s));
  });
});
