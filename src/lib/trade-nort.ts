import "server-only";

/**
 * NORT'S TRADE-SHAPED WORDS, one set per trade — the prompt sentences that lib/nort/trade-prompt, the
 * estimator (quotes/actions.ts) and the public site chat (api/site-chat) shape into instructions.
 *
 * SERVER-ONLY ON PURPOSE (cn-v1135, skeptic #41's S4): these are prompt words, and the registry they
 * used to sit in (lib/trade-package) is imported by client components — the Features board, the job
 * codes manager, the Tools page — so the electrician's NEC sentence and the neutral set were shipped
 * in every browser chunk that read a trade's menu row. `import "server-only"` makes a client import
 * a build error; trade-nort.test holds that no "use client" file imports this module.
 *
 * ONE ROW PER TradeKey (the Record type insists, so a new trade cannot fall through to nothing by
 * accident). Electrical's words are today's, byte for byte (cn-v339, cn-v1128: an electrician's
 * prompt is unchanged); the nine other trades share ONE neutral set that names no trade's parts —
 * Nort's examples are the company's own or shapes (NORT_EXAMPLES_RULE) — except the deck row, whose
 * photo line names what a photo of a deck shows (the site chat already said it).
 */
import { isTradeKey, type TradeKey } from "@/lib/trade-package";

/** The trade-shaped sentences in Nort's instructions, the estimator's prompt and the site chat. */
export type TradeNortWords = {
  /** Nort's ENGINEERING line of the research-mode estimating method (lib/nort/trade-prompt). */
  engineering: string;
  /** The estimator's research-mode QUANTITIES sentence (quotes/actions.ts). Catalog mode has its own. */
  estimatorQuantities: string;
  /** The clarifying questions a good estimator asks before pricing. */
  clarifying: string;
  /** What web research pulls for a line the book can't price. */
  webSpecs: string;
  /** The facts worth a tile on the windshield card. */
  cardFacts: string;
  /** VOICE RULE 3: the make-or-break assumptions to confirm before pricing a big list out loud. */
  assumptions: string;
  /** Site chat, research mode: the example of a SET PACKAGE the script might price. */
  siteChatPackage: string;
  /** Site chat, research mode: what moves month to month (so it is researched live). */
  siteChatMoving: string;
  /** Site chat, research mode: the small stuff bundled into ONE materials line, never itemized. */
  siteChatSmallStuff: string;
  /** Site chat: what to look for in a customer's photo. */
  siteChatPhoto: string;
};

/**
 * THE NEUTRAL WORDS — every trade but electrical, and a company whose trade isn't known. They name no
 * trade's parts: Nort's examples are the company's own or shapes (NORT_EXAMPLES_RULE).
 */
export const NEUTRAL_NORT: TradeNortWords = {
  engineering:
    "- ENGINEERING: work sizes and quantities out from the measurements and THIS trade's own rules and code — don't eyeball them, and show the arithmetic so it's verifiable.",
  estimatorQuantities:
    "QUANTITIES: calculate per THIS trade's own rules and code from the measurements given — areas = length × width, linear feet, counts — don't eyeball, and show the arithmetic. ",
  clarifying: "residential vs commercial, the size of what's there, etc.",
  webSpecs: "pull the real specs and sizes",
  cardFacts: "gate/lockbox code, balance due, hours today, next appointment",
  assumptions:
    "the ones that change everything in THIS trade (the kind of work, the size or type of what's there, permitted or not). Ask that one question up front",
  siteChatPackage: "a set package the script prices for that kind of job",
  siteChatMoving: "Material prices move month to month",
  siteChatSmallStuff: "fasteners, clips, sealant and the small hardware",
  siteChatPhoto: "what's there, its size and condition, and the access",
};

/** The electrician's field-tested words, kept for electrical work word for word (cn-v339, cn-v1128). */
export const ELECTRICAL_NORT: TradeNortWords = {
  engineering:
    "- ENGINEERING: calculate the real numbers per NEC — CALL the calc tools (calc_wire_size, calc_voltage_drop, calc_conduit_fill, calc_box_fill) for exact answers, don't eyeball sizes/quantities, and show what they returned so it's verifiable.",
  estimatorQuantities:
    "QUANTITIES: calculate per the governing code for this trade — don't eyeball. For anything the CALCULATOR TOOLS cover (wire size, voltage drop, conduit fill, box fill) CALL THE TOOL instead of working the tables from memory; they return the exact NEC answer plus the code rule behind it. Reasoning a table in your head is where wrong numbers come from. ",
  clarifying: "residential vs commercial, panel size, etc.",
  webSpecs: "pull real specs like wire/breaker sizes",
  cardFacts: "gate/lockbox code, balance due, hours today, amp size, next appointment",
  assumptions:
    "the ones that change everything: fuel type (propane / natural gas), panel or service size, overhead vs underground, permitted or not. Ask 'Propane or natural gas?' up front",
  siteChatPackage: "a like-for-like panel swap",
  siteChatMoving: "Copper, breakers, EV chargers and fixtures move month to month",
  siteChatSmallStuff: "wire, nuts, staples, screws, straps",
  siteChatPhoto: "panel brand & amperage, wiring/condition, access",
};

/** One row per trade, in TRADE_ORDER (general first, electrical last — the registry's order). */
export const TRADE_NORT: Record<TradeKey, TradeNortWords> = {
  general: NEUTRAL_NORT,
  deck: { ...NEUTRAL_NORT, siteChatPhoto: "deck size/shape, its condition, and the access" },
  plumbing: NEUTRAL_NORT,
  hvac: NEUTRAL_NORT,
  landscaping: NEUTRAL_NORT,
  roofing: NEUTRAL_NORT,
  concrete: NEUTRAL_NORT,
  tile: NEUTRAL_NORT,
  painting: NEUTRAL_NORT,
  electrical: ELECTRICAL_NORT,
};

/** The trade-shaped words for a prompt: the trade's own, or the neutral set when no trade is known. */
export const tradeNort = (key: unknown): TradeNortWords => (isTradeKey(key) ? TRADE_NORT[key] : NEUTRAL_NORT);
