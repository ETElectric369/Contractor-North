/**
 * THE TRADE PACKAGE — ONE row per trade, everything a company gets for picking it at sign-up (or in
 * Settings › Features › Change My Trade), in one place.
 *
 * Erik, 2026-10-27: "we are setting this up for all contractors so not electricians first, contractors
 * first … lets roll out the per trade packages yes and we will be testing them." Before cn-v1135 a
 * trade's package existed in PIECES across eight files keyed on settings.trade (job codes in two lists
 * that disagreed, switches, the inspection starter, the public intake, the calculator packages, Nort's
 * words), and nine shared doors still assumed an electrician. Every reader now reads THIS table; the
 * Record type and trade-package.test insist on one row per TRADE_ORDER key, so a new trade cannot
 * silently fall through anywhere.
 *
 * WHAT A ROW HOLDS points only at homes that exist today. Nothing here is invented for a trade nobody on
 * North does yet (the no-speculation law; lib/playbook/starters/index.ts "one honest entry at a time"):
 * a plumber's or landscaper's playbook, intake, kits and prices arrive as DRAFTS from the first plumber
 * and landscaper on North, so those slots are null / neutral and the app says so where it matters.
 *
 * Electrical is one row of ten, written last.
 *
 * NORT'S WORDS ARE NOT HERE. This registry is read by client components (the Features board, the job
 * codes manager, the Tools page), so it holds only what a browser may see; the trade-shaped prompt
 * sentences (the electrician's, byte for byte, and the neutral set the nine other trades share) live
 * in lib/trade-nort, a server-only module keyed on the same TradeKey.
 *
 * IMPORTS: only types from features.ts (it imports TRADE_ORDER from trade-codes, which re-exports it
 * from here) — no runtime cycle. permit-options has no imports of its own.
 */
import type { FeatureMap } from "@/lib/features";
import { PERMIT_TYPES } from "@/lib/permit-options";

/** Ordered for the sign-up dropdown — General first, then the trades. Never electrical first. */
export const TRADE_ORDER = [
  "general", "deck", "electrical", "plumbing", "hvac", "landscaping", "roofing", "concrete", "tile", "painting",
] as const;
export type TradeKey = (typeof TRADE_ORDER)[number];
export const isTradeKey = (v: unknown): v is TradeKey =>
  typeof v === "string" && (TRADE_ORDER as readonly string[]).includes(v);

export type JobCodeSeed = { code: string; description: string; billable: boolean };
/** The inspection starter sheets that exist (lib/inspection/starter-sheets STARTERS). */
export type InspectionStarter = "electrical" | "deck" | "plumbing" | "generic";
/** The public-intake starters that exist (lib/playbook/starters/intake). */
export type IntakeStarter = "deck" | "electrical" | "neutral";
/** The calculator packages on the Tools page (tools-view.tsx). */
export type CalculatorPackage = "Electrical" | "Estimating" | "Money" | "Field";
export type PermitType = (typeof PERMIT_TYPES)[number];

export type TradePackage = {
  key: TradeKey;
  /** The sign-up dropdown row ("Deck / Carpentry") — an <option> is a clickable, so Title Case. */
  menu: string;
  /** What you'd call the person who does it ("deck builder") — prompts and sentences. */
  words: string;
  /** THE job-code list: sign-up seeds it whole; "Import A Trade's Codes" offers it; one spelling. */
  codes: JobCodeSeed[];
  /** Old spellings of a code in this list (the pre-1135 packs): an import skips a code a company
   *  already has under either, so nobody gets a twin. */
  codeAliases: Record<string, string>;
  /** The switches that start ON beyond the blank preset (lib/features BLANK_PRESET). */
  features: Partial<FeatureMap>;
  inspection: InspectionStarter;
  intake: IntakeStarter;
  /** A playbook starter written by somebody who does this work (lib/playbook/starters), or null. */
  playbookStarter: string | null;
  calculators: CalculatorPackage[];
  /** What a new permit defaults to for this trade. */
  permitType: PermitType;
};

// ── shared code rows ─────────────────────────────────────────────────────────────────────────────
const SVC: JobCodeSeed = { code: "SVC", description: "Service call", billable: true };
const TRAVEL: JobCodeSeed = { code: "TRAVEL", description: "Travel time", billable: true };
const SHOP: JobCodeSeed = { code: "SHOP", description: "Shop / yard time", billable: false };
const PTO: JobCodeSeed = { code: "PTO", description: "Paid time off", billable: false };
const INSP: JobCodeSeed = { code: "INSP", description: "Inspection / permit", billable: true };
const REPAIR: JobCodeSeed = { code: "REPAIR", description: "Repair", billable: true };
const DEMO: JobCodeSeed = { code: "DEMO", description: "Demo / teardown", billable: true };
const row = (code: string, description: string, billable = true): JobCodeSeed => ({ code, description, billable });

const UNIVERSAL: CalculatorPackage[] = ["Estimating", "Money", "Field"];
const BUILDER: Partial<FeatureMap> = { kits: true, contracts: true };

// ── THE TEN ROWS, in TRADE_ORDER; electrical last ────────────────────────────────────────────────
export const TRADE_PACKAGES: Record<TradeKey, TradePackage> = {
  general: {
    key: "general",
    menu: "General Contractor",
    words: "general contractor",
    codes: [
      SVC,
      row("INSTALL", "Install / build"),
      REPAIR,
      row("LABOR", "General labor"),
      row("MATL", "Material run"),
      row("MEET", "Meeting / consult"),
      TRAVEL,
      row("CLEAN", "Cleanup"),
      INSP,
      SHOP,
      PTO,
    ],
    codeAliases: { MTL: "MATL" },
    features: BUILDER,
    inspection: "generic",
    intake: "neutral",
    playbookStarter: null,
    calculators: UNIVERSAL,
    permitType: "Building",
  },
  deck: {
    key: "deck",
    menu: "Deck / Carpentry",
    words: "deck builder",
    codes: [
      DEMO,
      row("FOOT", "Footings / posts"),
      row("FRAME", "Framing / substructure"),
      row("DECK", "Decking install"),
      row("RAIL", "Railing"),
      row("STAIR", "Stairs"),
      row("FASCIA", "Fascia / trim"),
      row("PERGOLA", "Pergola / shade structure"),
      row("FENCE", "Fence"),
      row("WPROOF", "Waterproofing / flashing"),
      row("FINISH", "Finish / seal / stain"),
      REPAIR,
      SVC,
      TRAVEL,
      INSP,
      SHOP,
      PTO,
    ],
    codeAliases: {},
    features: BUILDER,
    inspection: "deck",
    intake: "deck",
    playbookStarter: "tahoe-deck",
    calculators: UNIVERSAL,
    permitType: "Building",
  },
  plumbing: {
    key: "plumbing",
    menu: "Plumbing",
    words: "plumber",
    codes: [
      SVC,
      row("TROUB", "Troubleshooting / diagnostics"),
      row("ROUGH", "Rough-in"),
      row("FINISH", "Finish / fixtures"),
      row("DRAIN", "Drain / sewer"),
      row("WATER", "Water heater"),
      row("GAS", "Gas line"),
      row("REPIPE", "Repipe"),
      REPAIR,
      TRAVEL,
      INSP,
      SHOP,
      PTO,
    ],
    codeAliases: { TRBL: "TROUB", TRIM: "FINISH", WHTR: "WATER" },
    features: { shop_stock: true },
    inspection: "plumbing",
    intake: "neutral",
    playbookStarter: null,
    calculators: UNIVERSAL,
    permitType: "Plumbing",
  },
  hvac: {
    key: "hvac",
    menu: "HVAC",
    words: "HVAC contractor",
    codes: [
      SVC,
      row("TROUB", "Troubleshooting / diagnostics"),
      row("INSTALL", "Install / changeout"),
      row("DUCT", "Ductwork"),
      row("MAINT", "Maintenance / tune-up"),
      row("REFRIG", "Refrigerant / charging"),
      row("THERM", "Thermostat / controls"),
      REPAIR,
      TRAVEL,
      INSP,
      SHOP,
      PTO,
    ],
    codeAliases: { TRBL: "TROUB" },
    features: { shop_stock: true },
    inspection: "generic",
    intake: "neutral",
    playbookStarter: null,
    calculators: UNIVERSAL,
    permitType: "Mechanical",
  },
  landscaping: {
    key: "landscaping",
    menu: "Landscaping",
    words: "landscaper",
    codes: [
      row("INSTALL", "Install / planting"),
      row("MAINT", "Maintenance"),
      row("IRRIG", "Irrigation"),
      row("HARD", "Hardscape"),
      row("CLEAN", "Cleanup / haul"),
      TRAVEL,
      SHOP,
      PTO,
    ],
    codeAliases: {},
    features: { permits: false },
    inspection: "generic",
    intake: "neutral",
    playbookStarter: null,
    calculators: UNIVERSAL,
    permitType: "Building",
  },
  roofing: {
    key: "roofing",
    menu: "Roofing",
    words: "roofer",
    codes: [
      row("TEAR", "Tear-off"),
      row("INSTALL", "Install / re-roof"),
      row("FLASH", "Flashing / detail"),
      REPAIR,
      SVC,
      TRAVEL,
      INSP,
      SHOP,
      PTO,
    ],
    codeAliases: {},
    features: BUILDER,
    inspection: "generic",
    intake: "neutral",
    playbookStarter: null,
    calculators: UNIVERSAL,
    permitType: "Building",
  },
  concrete: {
    key: "concrete",
    menu: "Concrete / Masonry",
    words: "concrete and masonry contractor",
    codes: [
      row("FORM", "Form / prep"),
      row("POUR", "Pour"),
      row("FINISH", "Finish"),
      row("DEMO", "Demo"),
      REPAIR,
      TRAVEL,
      INSP,
      SHOP,
      PTO,
    ],
    codeAliases: {},
    features: BUILDER,
    inspection: "generic",
    intake: "neutral",
    playbookStarter: null,
    calculators: UNIVERSAL,
    permitType: "Building",
  },
  tile: {
    key: "tile",
    menu: "Tile / Flooring",
    words: "tile and flooring installer",
    codes: [
      row("DEMO", "Demo / tear-out"),
      row("PREP", "Substrate prep / leveling"),
      row("WPROOF", "Waterproofing / membrane"),
      row("BACKER", "Backer board / underlayment"),
      row("SET", "Tile setting / install"),
      row("GROUT", "Grout / seal"),
      row("REPAIR", "Repair / regrout"),
      SVC,
      TRAVEL,
      SHOP,
      PTO,
    ],
    codeAliases: {},
    features: { kits: true },
    inspection: "generic",
    intake: "neutral",
    playbookStarter: null,
    calculators: UNIVERSAL,
    permitType: "Building",
  },
  painting: {
    key: "painting",
    menu: "Painting",
    words: "painter",
    codes: [
      row("PREP", "Prep / mask"),
      row("PAINT", "Paint / spray"),
      row("TRIM", "Trim / detail"),
      row("REPAIR", "Repair / patch"),
      TRAVEL,
      SHOP,
      PTO,
    ],
    codeAliases: {},
    features: { permits: false },
    inspection: "generic",
    intake: "neutral",
    playbookStarter: null,
    calculators: UNIVERSAL,
    permitType: "Building",
  },
  electrical: {
    key: "electrical",
    menu: "Electrical",
    words: "electrical contractor",
    codes: [
      SVC,
      row("ROUGH", "Rough-in wiring"),
      row("TRIM", "Trim-out / devices"),
      row("PANEL", "Panel / service upgrade"),
      row("METER", "Meter / service entrance"),
      row("TROUB", "Troubleshooting"),
      row("LOW", "Low voltage / data"),
      row("LIGHT", "Lighting install"),
      row("EV", "EV charger install"),
      row("GEN", "Generator install"),
      row("SOLAR", "Solar / battery storage"),
      row("FIRE", "Fire alarm / smoke detectors"),
      row("DEMO", "Demolition / removal"),
      TRAVEL,
      INSP,
      SHOP,
      PTO,
    ],
    codeAliases: { TRBL: "TROUB", LV: "LOW" },
    features: { shop_stock: true, panel_map: true },
    inspection: "electrical",
    intake: "electrical",
    playbookStarter: "et-electric",
    calculators: ["Electrical", ...UNIVERSAL],
    permitType: "Electrical",
  },
};

// ── READERS ──────────────────────────────────────────────────────────────────────────────────────
/** The package for a stored or picked key; null for "other", blank, or anything unknown. */
export function tradePackage(key: unknown): TradePackage | null {
  return isTradeKey(key) ? TRADE_PACKAGES[key] : null;
}

/** What a new permit defaults to: the trade's permit, or Building when no trade is known. */
export const defaultPermitType = (key: unknown): PermitType => tradePackage(key)?.permitType ?? "Building";

/** The calculator packages a company's Tools page opens on. */
export const calculatorPackagesFor = (key: unknown): CalculatorPackage[] => tradePackage(key)?.calculators ?? UNIVERSAL;

/** Resolve a code a company already has to the registry's spelling for this trade (aliases fold). */
export function canonicalCode(key: TradeKey, code: string): string {
  const c = code.trim().toUpperCase();
  return TRADE_PACKAGES[key].codeAliases[c] ?? c;
}

/** Lightweight rows for the "Import A Trade's Codes" picker, in TRADE_ORDER (never electrical first). */
export const TRADE_PACK_OPTIONS = TRADE_ORDER.map((k) => ({
  id: k,
  label: TRADE_PACKAGES[k].menu,
  count: TRADE_PACKAGES[k].codes.length,
}));
