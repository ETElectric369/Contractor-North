import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRADE_ORDER,
  TRADE_PACKAGES,
  TRADE_PACK_OPTIONS,
  calculatorPackagesFor,
  canonicalCode,
  defaultPermitType,
  isTradeKey,
  tradePackage,
} from "@/lib/trade-package";
import { PERMIT_TYPES } from "@/lib/permit-options";
import { PLAYBOOK_STARTERS } from "@/lib/playbook/starters";

/**
 * THE CODES THE FIVE PRE-1135 PACKS OFFERED (lib/trade-code-packs, deleted in cn-v1135). A company that
 * imported one of these must not get a twin from the registry's list, so every old code is either in
 * the trade's list, one of its aliases, or deliberately dropped (named below with the reason).
 */
const OLD_PACKS: Record<string, string[]> = {
  electrical: ["SVC", "TRBL", "ROUGH", "TRIM", "PANEL", "METER", "LIGHT", "CUSTOM", "LV", "EV", "GEN", "SOLAR", "FIRE", "DEMO", "INSP", "TRAVEL", "MTL", "CLEAN", "WARR", "ADMIN"],
  deck: ["DEMO", "FOOT", "FRAME", "DECK", "RAIL", "STAIR", "FASCIA", "PERGOLA", "FENCE", "WPROOF", "FINISH", "INSP", "TRAVEL", "MTL", "CLEAN", "WARR", "ADMIN"],
  hvac: ["SVC", "TRBL", "INSTALL", "DUCT", "MAINT", "REFRIG", "THERM", "INSP", "TRAVEL", "MTL", "CLEAN", "WARR", "ADMIN"],
  plumbing: ["SVC", "TRBL", "ROUGH", "TRIM", "DRAIN", "WHTR", "GAS", "REPIPE", "INSP", "TRAVEL", "MTL", "CLEAN", "WARR", "ADMIN"],
  general: ["LABOR", "SVC", "INSTALL", "REPAIR", "MEET", "INSP", "TRAVEL", "MTL", "CLEAN", "WARR", "ADMIN"],
};
/** The packs' overhead tail and one-offs, dropped on purpose: SHOP and PTO carry non-billable time,
 *  a company adds its own warranty / admin / material-run buckets, and "custom lighting fab" is one shop's. */
const DROPPED = new Set(["MTL", "CLEAN", "WARR", "ADMIN", "CUSTOM"]);

/** The sign-up lists every company since 0352 was seeded with (lib/trade-codes TRADE_PRESETS before 1135):
 *  the registry keeps every one of them, in that spelling, so an existing company's codes match. */
const SIGNUP_LISTS: Record<string, string[]> = {
  general: ["SVC", "INSTALL", "REPAIR", "LABOR", "MATL", "TRAVEL", "CLEAN", "SHOP", "PTO"],
  deck: ["DEMO", "FOOT", "FRAME", "DECK", "RAIL", "STAIR", "FINISH", "REPAIR", "SVC", "TRAVEL", "SHOP", "PTO"],
  electrical: ["SVC", "ROUGH", "TRIM", "PANEL", "TROUB", "LOW", "GEN", "TRAVEL", "SHOP", "PTO"],
  plumbing: ["SVC", "ROUGH", "FINISH", "DRAIN", "WATER", "GAS", "REPAIR", "TRAVEL", "SHOP", "PTO"],
  hvac: ["SVC", "INSTALL", "DUCT", "MAINT", "REPAIR", "TRAVEL", "SHOP", "PTO"],
  landscaping: ["INSTALL", "MAINT", "IRRIG", "HARD", "CLEAN", "TRAVEL", "SHOP", "PTO"],
  roofing: ["TEAR", "INSTALL", "FLASH", "REPAIR", "SVC", "TRAVEL", "SHOP", "PTO"],
  concrete: ["FORM", "POUR", "FINISH", "DEMO", "REPAIR", "TRAVEL", "SHOP", "PTO"],
  painting: ["PREP", "PAINT", "TRIM", "REPAIR", "TRAVEL", "SHOP", "PTO"],
  tile: ["DEMO", "PREP", "WPROOF", "BACKER", "SET", "GROUT", "REPAIR", "SVC", "TRAVEL", "SHOP", "PTO"],
};

describe("the trade package registry", () => {
  it("has exactly one row per TRADE_ORDER key, keyed by itself, general first and electrical one of ten", () => {
    expect(Object.keys(TRADE_PACKAGES).sort()).toEqual([...TRADE_ORDER].sort());
    for (const k of TRADE_ORDER) expect(TRADE_PACKAGES[k].key).toBe(k);
    expect(TRADE_ORDER[0]).toBe("general");
    expect(TRADE_ORDER).toHaveLength(10);
    expect(isTradeKey("solar")).toBe(false);
    expect(isTradeKey("other")).toBe(false);
    expect(tradePackage("")).toBeNull();
    expect(tradePackage("deck")?.words).toBe("deck builder");
  });

  it("every row's menu and words are set, its starters exist, its permit is a real type and its calculators are packages", () => {
    const starterKeys = new Set(PLAYBOOK_STARTERS.map((s) => s.key));
    for (const k of TRADE_ORDER) {
      const p = TRADE_PACKAGES[k];
      expect(p.menu.trim(), k).not.toBe("");
      expect(p.words.trim(), k).not.toBe("");
      expect(["electrical", "deck", "plumbing", "generic"], k).toContain(p.inspection);
      expect(["deck", "electrical", "neutral"], k).toContain(p.intake);
      if (p.playbookStarter !== null) expect(starterKeys.has(p.playbookStarter), `${k}: ${p.playbookStarter}`).toBe(true);
      expect(PERMIT_TYPES as readonly string[], k).toContain(p.permitType);
      for (const c of p.calculators) expect(["Electrical", "Estimating", "Money", "Field"], k).toContain(c);
      expect(p.calculators, k).toContain("Estimating");
      expect(p.calculators.includes("Electrical"), k).toBe(k === "electrical");
    }
  });

  it("each job-code list is uppercase, unique, at most 18 rows, and keeps every code sign-up seeded before 1135 in that spelling", () => {
    for (const k of TRADE_ORDER) {
      const codes = TRADE_PACKAGES[k].codes.map((c) => c.code);
      expect(codes.length, k).toBeLessThanOrEqual(18);
      expect(new Set(codes).size, k).toBe(codes.length);
      for (const c of codes) expect(c, k).toMatch(/^[A-Z]{2,8}$/);
      for (const c of TRADE_PACKAGES[k].codes) expect(c.description.trim(), `${k} ${c.code}`).not.toBe("");
      for (const c of SIGNUP_LISTS[k]) expect(codes, `${k} lost ${c}`).toContain(c);
      // Non-billable time is SHOP and PTO, nothing else is billed as nothing by default.
      expect(TRADE_PACKAGES[k].codes.filter((c) => !c.billable).map((c) => c.code).sort(), k).toEqual(["PTO", "SHOP"]);
    }
  });

  it("every alias maps to a code in its own list, never to itself, and the old packs' codes all land somewhere", () => {
    for (const k of TRADE_ORDER) {
      const codes = new Set(TRADE_PACKAGES[k].codes.map((c) => c.code));
      for (const [from, to] of Object.entries(TRADE_PACKAGES[k].codeAliases)) {
        expect(codes.has(to), `${k}: ${from} → ${to}`).toBe(true);
        expect(codes.has(from), `${k}: alias ${from} is also a code`).toBe(false);
      }
    }
    for (const [k, old] of Object.entries(OLD_PACKS)) {
      const p = TRADE_PACKAGES[k as keyof typeof TRADE_PACKAGES];
      const codes = new Set(p.codes.map((c) => c.code));
      for (const c of old) {
        const landed = codes.has(c) || c in p.codeAliases || DROPPED.has(c);
        expect(landed, `${k}: the old pack's ${c} is neither in the list, an alias, nor dropped on purpose`).toBe(true);
      }
    }
    expect(canonicalCode("electrical", "trbl")).toBe("TROUB");
    expect(canonicalCode("plumbing", "TRIM")).toBe("FINISH");
    expect(canonicalCode("deck", "RAIL")).toBe("RAIL");
    expect(canonicalCode("general", " mtl ")).toBe("MATL");
  });

  it("the switches are the presets every company was seeded with (features.ts TRADE_FEATURES before 1135)", () => {
    const builder = { kits: true, contracts: true };
    expect(TRADE_PACKAGES.general.features).toEqual(builder);
    expect(TRADE_PACKAGES.deck.features).toEqual(builder);
    expect(TRADE_PACKAGES.roofing.features).toEqual(builder);
    expect(TRADE_PACKAGES.concrete.features).toEqual(builder);
    expect(TRADE_PACKAGES.electrical.features).toEqual({ shop_stock: true, panel_map: true });
    expect(TRADE_PACKAGES.plumbing.features).toEqual({ shop_stock: true });
    expect(TRADE_PACKAGES.hvac.features).toEqual({ shop_stock: true });
    expect(TRADE_PACKAGES.tile.features).toEqual({ kits: true });
    expect(TRADE_PACKAGES.landscaping.features).toEqual({ permits: false });
    expect(TRADE_PACKAGES.painting.features).toEqual({ permits: false });
  });

  it("the starters point only at what exists: deck and electrical have their own; the eight others start neutral and say so", () => {
    expect(TRADE_PACKAGES.deck).toMatchObject({ inspection: "deck", intake: "deck", playbookStarter: "tahoe-deck" });
    expect(TRADE_PACKAGES.electrical).toMatchObject({ inspection: "electrical", intake: "electrical", playbookStarter: "et-electric" });
    expect(TRADE_PACKAGES.plumbing).toMatchObject({ inspection: "plumbing", intake: "neutral", playbookStarter: null });
    for (const k of ["general", "hvac", "landscaping", "roofing", "concrete", "tile", "painting"] as const)
      expect(TRADE_PACKAGES[k], k).toMatchObject({ inspection: "generic", intake: "neutral", playbookStarter: null });
  });

  it("permits default to the trade's permit, Building when nobody said", () => {
    expect(defaultPermitType("electrical")).toBe("Electrical");
    expect(defaultPermitType("plumbing")).toBe("Plumbing");
    expect(defaultPermitType("hvac")).toBe("Mechanical");
    for (const k of ["general", "deck", "landscaping", "roofing", "concrete", "tile", "painting"]) expect(defaultPermitType(k), k).toBe("Building");
    expect(defaultPermitType("")).toBe("Building");
    expect(defaultPermitType(undefined)).toBe("Building");
  });

  it("holds no prompt words: the registry ships to the browser, Nort's words live in lib/trade-nort (server-only)", () => {
    // The Features board, the job codes manager and the Tools page import this file in client
    // chunks; the electrician's NEC sentence and the neutral set used to ride along with them.
    const file = readFileSync(join(process.cwd(), "src/lib/trade-package.ts"), "utf8");
    expect(file).not.toMatch(/ENGINEERING|QUANTITIES|calc_wire_size|like-for-like/);
    expect(file).not.toContain('import "server-only"');
    expect("nort" in TRADE_PACKAGES.electrical).toBe(false);
  });

  it("the calculator packages and the import picker read the registry, in TRADE_ORDER", () => {
    expect(calculatorPackagesFor("electrical")).toEqual(["Electrical", "Estimating", "Money", "Field"]);
    expect(calculatorPackagesFor("deck")).toEqual(["Estimating", "Money", "Field"]);
    expect(calculatorPackagesFor("")).toEqual(["Estimating", "Money", "Field"]);
    expect(TRADE_PACK_OPTIONS.map((o) => o.id)).toEqual([...TRADE_ORDER]);
    expect(TRADE_PACK_OPTIONS[0]).toEqual({ id: "general", label: "General Contractor", count: TRADE_PACKAGES.general.codes.length });
    // The menu rows render as <option> rows (sign-up, Import A Trade's Codes): every word capitalized.
    for (const k of TRADE_ORDER) for (const w of TRADE_PACKAGES[k].menu.split(/[\s/]+/)) expect(w, k).toMatch(/^[A-Z]/);
  });
});
