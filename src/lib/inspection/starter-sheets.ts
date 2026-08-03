import { parseInspectionSchema, type InspectionField } from "./schema";

/**
 * THE SHEET A NEW COMPANY STARTS WITH.
 *
 * Nothing in this repo has ever seeded a `forms` row with `is_inspection`. The onboarding seed
 * makes job codes and stops. So the progressive-disclosure sheet — showIf, visibleFields,
 * clearHiddenAnswers, all of it shipped and tested — has had NOTHING TO RENDER on any org that
 * did not hand-author a template. Two consequences, both observed:
 *
 *   · Andrew Cohen signed up as the first outside tenant and his inspection page had no questions
 *     on it at all. He did not report a bug, because an empty form looks like a thin product, not
 *     a broken one.
 *   · Erik's own inspections show empty answer sets on 27 of 28 — read for months as "he doesn't
 *     fill these in". He does. He typed 281 characters of notes and 348 of materials on the ones
 *     that mattered. The SHEET was empty because no sheet existed.
 *
 * So this file is the difference between a feature and a demo.
 *
 * THE SHAPE OF EVERY SHEET HERE IS THE SAME, and it is the whole thesis:
 *   ONE router question, then a fan-out. `visibleFields(sheet, {})` must return EXACTLY ONE field
 *   — you land on one question, not ten. Answer it and the two or three that apply to that kind of
 *   work appear. That is the difference between a form and a wall.
 *
 * DATA, NOT CODE — the determinism boundary. These are seeds a tenant OWNS and edits, not
 * behaviour branching on trade. A contractor whose work does not fit rewrites the sheet; nothing
 * in the app asks "what trade is this" at runtime. Per-trade must be data.
 *
 * The questions are deliberately the ones that change the PRICE, not the ones that make a tidy
 * record. A question whose answer never moves a number is a question asked of a man on a ladder
 * for nothing.
 */

export type StarterTrade = "electrical" | "deck" | "plumbing" | "generic";

interface Starter {
  /** The forms.name the tenant will see and can rename. */
  name: string;
  fields: unknown[];
}

/** work_type is the router on every sheet — one key, so the estimator reads one shape everywhere. */
const ROUTER = "work_type";

const STARTERS: Record<StarterTrade, Starter> = {
  // ── ELECTRICAL ────────────────────────────────────────────────────────────────
  electrical: {
    name: "Site inspection",
    fields: [
      {
        key: ROUTER,
        label: "What kind of work",
        type: "select",
        options: ["Service / panel", "Lighting", "Circuits / outlets", "EV charger", "Troubleshoot"],
      },
      // Service/panel — the amperage and the brand are the two facts that decide the whole job.
      { key: "panel_amps", label: "Existing service size (A)", type: "number", measured: true, showIf: { key: ROUTER, in: ["Service / panel", "EV charger"] } },
      { key: "panel_brand", label: "Panel brand", type: "text", showIf: { key: ROUTER, in: ["Service / panel", "EV charger"] } },
      // Zinsco and Federal Pacific are refuse-to-add-a-breaker panels — this answer can turn a
      // $400 circuit into a $4,000 service change, so it is asked before anyone quotes.
      { key: "panel_full", label: "Panel full / obsolete", type: "checkbox", showIf: { key: ROUTER, in: ["Service / panel", "Circuits / outlets", "EV charger"] } },
      { key: "overhead_underground", label: "Service drop", type: "select", options: ["Overhead", "Underground"], showIf: { key: ROUTER, in: ["Service / panel"] } },
      { key: "fixture_count", label: "How many fixtures", type: "number", measured: true, showIf: { key: ROUTER, in: ["Lighting"] } },
      { key: "ceiling_height", label: "Ceiling height (ft)", type: "number", measured: true, showIf: { key: ROUTER, in: ["Lighting"] } },
      { key: "device_count", label: "How many devices", type: "number", measured: true, showIf: { key: ROUTER, in: ["Circuits / outlets"] } },
      { key: "run_ft", label: "Longest run (ft)", type: "number", measured: true, showIf: { key: ROUTER, in: ["Lighting", "Circuits / outlets", "EV charger"] } },
      { key: "charger_amps", label: "Charger size (A)", type: "number", measured: true, showIf: { key: ROUTER, in: ["EV charger"] } },
      { key: "symptom", label: "What's it doing", type: "textarea", showIf: { key: ROUTER, in: ["Troubleshoot"] } },
      // Apply to every kind of work — but asked only once the work is named, so the sheet
      // never opens as a list of questions about a job nobody has described yet.
      { key: "access", label: "Access", type: "select", options: ["Open / easy", "Attic or crawl", "Finished walls", "Tight / difficult"], showIf: { key: ROUTER, in: ["Service / panel","Lighting","Circuits / outlets","EV charger","Troubleshoot"] } },
      { key: "permit", label: "Permit needed", type: "checkbox", showIf: { key: ROUTER, in: ["Service / panel","Lighting","Circuits / outlets","EV charger","Troubleshoot"] } },
    ],
  },

  // ── DECK / GENERAL CONTRACTING ────────────────────────────────────────────────
  deck: {
    name: "Site inspection",
    fields: [
      {
        key: ROUTER,
        label: "What kind of work",
        type: "select",
        options: ["New deck", "Deck repair", "Railing", "Stairs", "Remodel / other"],
      },
      // Length × width feed measurementsFromAnswers → sqft → kit sizing. These two keys are the
      // reason the estimator can price a deck without anyone doing arithmetic on a tailgate.
      { key: "length", label: "Length (ft)", type: "number", measured: true, showIf: { key: ROUTER, in: ["New deck", "Deck repair"] } },
      { key: "width", label: "Width (ft)", type: "number", measured: true, showIf: { key: ROUTER, in: ["New deck", "Deck repair"] } },
      { key: "height_ft", label: "Height off grade (ft)", type: "number", measured: true, showIf: { key: ROUTER, in: ["New deck", "Deck repair", "Stairs"] } },
      { key: "decking_material", label: "Decking material", type: "select", options: ["Pressure treated", "Cedar", "Redwood", "Composite", "Match existing"], showIf: { key: ROUTER, in: ["New deck", "Deck repair"] } },
      { key: "railing_ft", label: "Railing (linear ft)", type: "number", measured: true, showIf: { key: ROUTER, in: ["New deck", "Railing"] } },
      { key: "stair_count", label: "How many steps", type: "number", measured: true, showIf: { key: ROUTER, in: ["Stairs"] } },
      { key: "rot_extent", label: "What's rotten", type: "textarea", showIf: { key: ROUTER, in: ["Deck repair"] } },
      { key: "scope_other", label: "Scope", type: "textarea", showIf: { key: ROUTER, in: ["Remodel / other"] } },
      // Apply to every kind of work — asked once the work is named (see above).
      { key: "access", label: "Access", type: "select", options: ["Drive right up", "Carry 50-100 ft", "Steep / difficult", "Crane or lift"], showIf: { key: ROUTER, in: ["New deck","Deck repair","Railing","Stairs","Remodel / other"] } },
      { key: "permit", label: "Permit needed", type: "checkbox", showIf: { key: ROUTER, in: ["New deck","Deck repair","Railing","Stairs","Remodel / other"] } },
    ],
  },

  // ── PLUMBING ──────────────────────────────────────────────────────────────────
  plumbing: {
    name: "Site inspection",
    fields: [
      {
        key: ROUTER,
        label: "What kind of work",
        type: "select",
        options: ["Water heater", "Repipe", "Fixture", "Drain / sewer", "Leak"],
      },
      { key: "heater_type", label: "Water heater type", type: "select", options: ["Tank", "Tankless", "Heat pump"], showIf: { key: ROUTER, in: ["Water heater"] } },
      { key: "heater_gallons", label: "Size (gal)", type: "number", measured: true, showIf: { key: ROUTER, in: ["Water heater"] } },
      { key: "fuel", label: "Fuel", type: "select", options: ["Gas", "Electric", "Propane"], showIf: { key: ROUTER, in: ["Water heater"] } },
      { key: "pipe_material", label: "Existing pipe", type: "select", options: ["Copper", "PEX", "Galvanized", "CPVC", "Poly-B"], showIf: { key: ROUTER, in: ["Repipe", "Leak"] } },
      { key: "fixture_count", label: "How many fixtures", type: "number", measured: true, showIf: { key: ROUTER, in: ["Repipe", "Fixture"] } },
      { key: "run_ft", label: "Run (ft)", type: "number", measured: true, showIf: { key: ROUTER, in: ["Repipe", "Drain / sewer"] } },
      { key: "line_size", label: "Line size (in)", type: "number", measured: true, showIf: { key: ROUTER, in: ["Drain / sewer"] } },
      { key: "symptom", label: "What's it doing", type: "textarea", showIf: { key: ROUTER, in: ["Leak", "Drain / sewer"] } },
      { key: "access", label: "Access", type: "select", options: ["Open / easy", "Attic or crawl", "Slab", "Finished walls"], showIf: { key: ROUTER, in: ["Water heater","Repipe","Fixture","Drain / sewer","Leak"] } },
      { key: "permit", label: "Permit needed", type: "checkbox", showIf: { key: ROUTER, in: ["Water heater","Repipe","Fixture","Drain / sewer","Leak"] } },
    ],
  },

  // ── GENERIC — the fallback for a trade we have no starter for ─────────────────
  // Deliberately thin. A wrong question is worse than a missing one: it teaches the person that
  // the sheet does not understand their work, and they stop filling it in.
  generic: {
    name: "Site inspection",
    fields: [
      { key: ROUTER, label: "What kind of work", type: "select", options: ["New install","Repair","Replacement","Service call","Other"] },
      { key: "scope", label: "Scope", type: "textarea", showIf: { key: ROUTER, in: ["New install","Repair","Replacement","Service call","Other"] } },
      { key: "size", label: "Size / quantity", type: "number", measured: true, showIf: { key: ROUTER, in: ["New install","Repair","Replacement","Service call","Other"] } },
      { key: "symptom", label: "What's it doing", type: "textarea", showIf: { key: ROUTER, in: ["Repair","Service call"] } },
      { key: "access", label: "Access", type: "select", options: ["Open / easy", "Tight", "Difficult"], showIf: { key: ROUTER, in: ["New install","Repair","Replacement","Service call","Other"] } },
      { key: "permit", label: "Permit needed", type: "checkbox", showIf: { key: ROUTER, in: ["New install","Repair","Replacement","Service call","Other"] } },
    ],
  },
};

/**
 * Map a free-text trade label onto a starter. Substring matching on purpose: the label comes from
 * a person saying what they do ("electrical contractor", "I build decks", "general contractor"),
 * not from a dropdown. Unrecognised → generic, never an empty sheet.
 */
export function starterTradeFor(tradeLabel: string | null | undefined): StarterTrade {
  const t = (tradeLabel ?? "").toLowerCase();
  if (!t.trim()) return "generic";
  if (/electric|sparky|low.?voltage|solar/.test(t)) return "electrical";
  if (/deck|carpent|framing|general contract|\bgc\b|remodel|builder|construction/.test(t)) return "deck";
  if (/plumb|pipe|hvac|mechanical|drain/.test(t)) return "plumbing";
  return "generic";
}

/** The starter sheet for a trade, already parsed + validated through the real schema parser. */
export function starterSheet(trade: StarterTrade): { name: string; fields: InspectionField[] } {
  const s = STARTERS[trade] ?? STARTERS.generic;
  return { name: s.name, fields: parseInspectionSchema(s.fields) };
}

/** The raw schema to persist into forms.schema — the stored shape, pre-parse. */
export function starterSchemaJson(trade: StarterTrade): unknown[] {
  return (STARTERS[trade] ?? STARTERS.generic).fields;
}

export const STARTER_TRADES = Object.keys(STARTERS) as StarterTrade[];
