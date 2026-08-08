import type { Playbook } from "../types";

/**
 * THE DECK WALK-THROUGH — Chris's questions, and where each answer lands in his price.
 *
 * Erik: "for tahoe deck we started with something that kinda worked but i dont know how accurate
 * it was then i thought we were making it more accurate then we changed everything completely so
 * we need to set it up in a way that the answer to the questions DOES exactly what he needs it to
 * do."
 *
 * ── WHY THIS IS BUILT FROM THE CUSTOMER FORM, NOT FROM SCRATCH ──────────────────────────────
 *
 * His public configurator (/estimate/tahoe-deck, live on tahoedeck.com) already asks a specific,
 * working set — walked end to end on 2026-08-06:
 *
 *   PROJECT   what kind of project · engineered plans? · (yes) approved? · (no) how can we picture it
 *   SIZE      length · width/depth · height AS A BAND · decking material · shape · wraps around
 *   DETAILS   sets of stairs · total steps · stair railing · doors · slider doors · TRPA basin
 *
 * The walk-through must ASK THE SAME QUESTIONS IN THE SAME WORDS, because the customer's answers
 * ride in with the lead and the inspector's job is to CONFIRM them, not to re-interview from
 * zero. Where the two differ, they differ on purpose, and there are exactly four differences —
 * this is the "what does the inspector need that the customer doesn't" answer:
 *
 *   1. HEIGHT IS A NUMBER, NOT A BAND. The customer picks "10–20 ft" because he's guessing from
 *      the patio door. Chris measures it. The band drives a supplement tier (DS5A/B/C); the exact
 *      number is what makes the tier right instead of nearly right.
 *   2. RAILING LINEAR FEET IS ASKABLE. The customer never sees it — it's derived from the
 *      footprint. On site Chris can override it, because a real deck's railing is not its
 *      perimeter (a wall runs along one side, a gate interrupts another).
 *   3. ACCESS. Never asked of a homeowner — they'd all say "easy". It IS the labor.
 *   4. WHAT ELSE IS WORTH KNOWING. The open one. The rot behind the ledger, the neighbour's
 *      fence, the crane he'll need.
 *
 * Everything else is the same question, so the same answer carries through and nobody is asked
 * twice. That is the whole point of the playbook being one declaration.
 *
 * ── WHY LINES, IN CHRIS'S SHAPE ─────────────────────────────────────────────────────────────
 *
 * Erik, on his brother: "my brother is going to ask his set of questions they are firm so the why
 * is: because this gets multiplied by that and = x and that feeds the board length generator."
 * Chris's are FORMULA lines almost all the way down — his pricing is arithmetic against a code,
 * which is exactly what makes them checkable. Each one names the code it feeds so the line and
 * the price list can be read against each other.
 */
export const TAHOE_DECK: Playbook = {
  needs: [
    {
      key: "project_type",
      label: "Kind of project",
      ask: "What kind of project is it?",
      slot: {
        type: "select",
        options: [
          "New deck",
          "Full deck replacement",
          "Resurface — new boards, keep the frame",
          "Add-on / extension",
          "Railing only",
          "Stairs only",
          "Repair (rot, damage, loose boards)",
          "Staining / refinishing",
          "Remodel",
        ],
      },
      hold: true,
      feeds: ["what"],
      why: "Picks the base rate — a build prices at D1 per sq ft, a resurface at DS8, and a remodel doesn't price per foot at all.",
      note:
        "Same words as the public configurator on purpose, so a customer's answer carries in and " +
        "he confirms it instead of re-asking. Remodel is the one option the customer form does NOT " +
        "offer — a remodel is scoped on site, never guessed from a web form.",
    },
    {
      key: "length_ft",
      label: "Length",
      ask: "How long is the deck?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "project_type", in: ["New deck", "Full deck replacement", "Resurface — new boards, keep the frame", "Add-on / extension"] }],
      why: "Times the width is the square footage, and that drives the base rate and the board count.",
    },
    {
      key: "width_ft",
      label: "Width",
      ask: "And how deep?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "length_ft", known: true }],
      why: "The other half of the square footage. Two numbers off one tape pull.",
    },
    {
      key: "height_ft",
      label: "Height at the tallest point",
      ask: "How high is it at the tallest point?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "project_type", in: ["New deck", "Full deck replacement", "Add-on / extension", "Railing only", "Stairs only"] }],
      why: "Sets the height supplement — over 10, over 20, over 30 are three different rates per sq ft.",
      note:
        "The customer picked a BAND on the website because he's eyeballing it from the patio door. " +
        "This is the measured number, and it is what makes the tier right instead of nearly right. " +
        "It also decides guardrail: over 30 inches of drop and a rail is code, not an option.",
    },
    {
      key: "material",
      label: "Decking material",
      ask: "Wood or composite?",
      slot: { type: "select", options: ["Wood", "Composite (Trex / TimberTech)"] },
      feeds: ["what"],
      when: [{ key: "project_type", in: ["New deck", "Full deck replacement", "Resurface — new boards, keep the frame", "Add-on / extension"] }],
      why: "Composite adds the DS2 upgrade on every square foot. Wood doesn't.",
    },
    {
      key: "shape",
      label: "Shape",
      ask: "Rectangular, or an irregular shape?",
      slot: { type: "select", options: ["Rectangular", "Irregular"] },
      feeds: ["what"],
      when: [{ key: "length_ft", known: true }],
      why: "Irregular adds the DS6C cutting-and-waste rate per sq ft — more cuts, more offcuts, more time.",
    },
    {
      key: "wrap_around",
      label: "Wraps the house",
      ask: "Does it wrap a corner of the house?",
      slot: { type: "select", options: ["Yes", "No"] },
      feeds: ["what"],
      when: [{ key: "length_ft", known: true }],
      why: "A wrap adds DS6D per sq ft — the corner framing and the transition are the slow part.",
    },
    {
      key: "railing_lf",
      label: "Railing",
      ask: "How much railing, in feet? (leave it blank and I'll take it off the footprint)",
      slot: { type: "number", unit: "lf" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "project_type", in: ["New deck", "Full deck replacement", "Add-on / extension", "Railing only"] }],
      why: "Times the D2 railing rate. Blank means derive it from the perimeter — this is the override for when that's wrong.",
      note:
        "Never asked on the website; it's derived there. A real deck's railing is not its perimeter — " +
        "a wall runs along one side, a gate interrupts another — so on site it is a number he can " +
        "correct, and a blank keeps the derived one rather than zeroing it.",
    },
    {
      key: "stair_flights",
      label: "Sets of stairs",
      ask: "How many sets of stairs?",
      slot: { type: "number" },
      measured: true,
      feeds: ["what"],
      why: "Under 3 steps is a flat D3 per set; 3 or more prices per step at D4. The count decides which.",
    },
    {
      key: "stair_steps",
      label: "Total steps",
      ask: "How many steps altogether?",
      slot: { type: "number" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "stair_flights", known: true }],
      why: "Times the D4 per-step rate on anything over a short set.",
    },
    {
      key: "stair_railing",
      label: "Stair railing",
      ask: "Do the stairs get railing?",
      slot: { type: "select", options: ["Yes", "No"] },
      feeds: ["what"],
      when: [{ key: "stair_flights", known: true }],
      why: "Adds D5 per step of stair railing.",
    },
    {
      key: "man_doors",
      label: "Doors onto the deck",
      ask: "How many regular doors open onto it?",
      slot: { type: "number" },
      measured: true,
      feeds: ["what"],
      why: "Each one adds a DS1B waterproofing detail to the price — the threshold is where a deck leaks into a house.",
    },
    {
      key: "slider_doors",
      label: "Slider doors",
      ask: "And how many sliders?",
      slot: { type: "number" },
      measured: true,
      feeds: ["what"],
      why: "Each one is DS1A — a wider sill and a more expensive detail than a man door.",
    },
    {
      key: "trpa",
      label: "TRPA basin",
      ask: "Is the property in the Tahoe basin?",
      slot: { type: "select", options: ["Yes", "No"] },
      feeds: ["why", "when"],
      why: "TRPA means the DS3C permitting package and a much longer runway before anyone breaks ground.",
    },
    {
      key: "remodel_scopes",
      label: "Remodel scopes",
      ask: "What's in this remodel? Pick the pieces and put a number on each.",
      slot: { type: "scopes", codes: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"] },
      feeds: ["what"],
      when: [{ key: "project_type", in: ["Remodel"] }],
      why: "This IS the price — each piece he picks becomes a line, and the total is the estimate.",
      note:
        "The R codes sit at $0.00 in his price list on purpose. Erik: \"they are based on " +
        "calculations too, when he chooses remodel he needs to be able to choose from a dropdown of " +
        "optional line items to add so he can add a value so it can be calculated ... it gets built " +
        "with the inspection.\" A remodel has no square-foot rate — the scope is chosen standing " +
        "there and priced standing there, and these picks arrive at the estimate as real lines.",
    },
    {
      key: "access",
      label: "Access",
      ask: "How are we getting materials and crew to it?",
      slot: {
        type: "select",
        options: ["Easy — truck to the work", "Tight — carry in", "Difficult — steep or long carry"],
      },
      feeds: ["what"],
      why: "That IS the labor — a long carry can add a day to a deck that measures the same as an easy one.",
      note: "Never asked of a homeowner: they all answer 'easy'. It's an on-site judgement.",
    },
    {
      key: "site_notes",
      label: "Anything else",
      ask: "Anything else worth knowing?",
      feeds: ["why"],
      why: "Adds hours nothing else on the sheet accounts for — the rot behind the ledger, the crane, the fence.",
      note: "OPEN on purpose — no control can hold it, and it's where Nort puts anything it couldn't place.",
    },
  ],
};
