import type { Need, Playbook } from "../types";

/**
 * THE CUSTOMER-FACING QUESTION SETS, ONE PER TRADE.
 *
 * `INTAKE_STARTER` (lib/playbook/public-intake) is the trade-neutral five: describe it, when,
 * budget, plans. It is the right thing to seed for a contractor we know nothing about, and it is
 * the wrong thing for the two orgs whose trades we DO know — Erik asked for his and Chris's
 * websites to work "accurately for us", and a deck company's front door should ask whether it is
 * wood or composite rather than leaving that in a paragraph for somebody to read back out.
 *
 * ── THE KEYS ARE THE WHOLE POINT ────────────────────────────────────────────────────────────
 *
 * Every question here that also exists on the trade's walk-through USES THE SAME KEY, with the
 * same slot and the same option strings. That is not tidiness. `answersFromIntake` coerces the
 * customer's answers against the WALK-THROUGH playbook and keeps what matches, so a shared key is
 * the difference between Chris confirming "composite, wraps the corner, in the basin" on site and
 * asking a homeowner all three again with the answers sitting in the lead behind him. A key that
 * drifts here silently stops carrying, which is why `intake.test.ts` asserts the match rather than
 * trusting anybody to remember.
 *
 * The Tahoe Deck walk-through's own note already says this out loud on `project_type`: "Same words
 * as the public configurator on purpose, so a customer's answer carries in."
 *
 * ── WHAT A CUSTOMER IS NOT ASKED ────────────────────────────────────────────────────────────
 *
 *   · anything `measured` — the tape is the contractor's, and `answersFromIntake` refuses a
 *     measured answer even if one arrives, so asking would collect friction and nothing else;
 *   · anything whose answer is a trade judgement — Erik's feed-or-home-runs, Chris's access
 *     rating ("never asked of a homeowner: they all answer 'easy'");
 *   · a `scopes` question, ever — its options are the org's price-list codes.
 *
 * SLOTS ON EVERY NEED. There is no Nort on the public page, so an open need renders nothing at
 * all — an open question here is an invisible one.
 */

/** The four every trade wants and no walk-through asks: when, money, plans, pictures. */
const COMMON: Need[] = [
  {
    key: "timeline",
    label: "Timeline",
    ask: "When are you hoping to have it done?",
    slot: {
      type: "select",
      options: ["As soon as possible", "In the next few weeks", "In the next few months", "Just planning ahead"],
    },
  },
  {
    key: "budget",
    label: "Budget",
    ask: "Do you have a budget range in mind?",
    slot: { type: "select", options: ["Under $5,000", "$5,000 – $15,000", "$15,000 – $50,000", "Over $50,000", "Not sure yet"] },
  },
  {
    key: "has_plans",
    label: "Plans",
    ask: "Do you already have plans or drawings?",
    slot: { type: "select", options: ["Yes", "No"] },
  },
  {
    key: "plan_files",
    label: "Plan files",
    ask: "Upload them here if you have them handy.",
    slot: { type: "file", multi: true, maxMb: 100 },
    when: [{ key: "has_plans", in: ["Yes"] }],
  },
  {
    key: "photos",
    label: "Photos",
    ask: "Photos of the area help a lot — add any you have.",
    slot: { type: "file", multi: true, maxMb: 100 },
  },
];

/**
 * DECKS — TAHOE DECK.
 *
 * project_type, material, shape, wrap_around and trpa are lifted key-for-key and option-for-option
 * from TAHOE_DECK, so all five carry onto Chris's walk-through. Between them they pick the base
 * rate (D1 vs DS8), the composite upgrade (DS2), the cutting-and-waste rate (DS6C), the corner
 * framing (DS6D) and the permitting package (DS3C) — which is to say a customer filling this in
 * has already answered most of what moves the number, without being asked to hold a tape.
 *
 * The dimensions are deliberately absent. They are `measured` on the walk-through and would be
 * refused on arrival; asking a homeowner to guess at a depth only to throw it away is worse than
 * not asking.
 */
export const DECK_INTAKE: Playbook = {
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
    },
    {
      key: "material",
      label: "Decking material",
      ask: "Wood or composite?",
      slot: { type: "select", options: ["Wood", "Composite (Trex / TimberTech)"] },
      when: [
        {
          key: "project_type",
          in: ["New deck", "Full deck replacement", "Resurface — new boards, keep the frame", "Add-on / extension"],
        },
      ],
    },
    {
      key: "shape",
      label: "Shape",
      ask: "Rectangular, or an irregular shape?",
      slot: { type: "select", options: ["Rectangular", "Irregular"] },
      when: [{ key: "project_type", known: true }],
    },
    {
      key: "wrap_around",
      label: "Wraps the house",
      ask: "Does it wrap a corner of the house?",
      slot: { type: "select", options: ["Yes", "No"] },
      when: [{ key: "project_type", known: true }],
    },
    {
      key: "trpa",
      label: "TRPA basin",
      // Plainer than the walk-through's wording — Chris knows what the basin is, a customer in
      // Reno may not. The KEY and the answers are identical, which is what has to match.
      ask: "Is the property inside the Tahoe basin? (If you're not sure, say No and we'll check.)",
      slot: { type: "select", options: ["Yes", "No"] },
    },
    {
      key: "site_notes",
      label: "Anything else",
      ask: "Anything else we should know? Hot tub, awkward access, a deadline — anything.",
      // A slot where the walk-through leaves this OPEN. An open need renders nothing on the public
      // page, and a string still coerces cleanly into an open need on the way back.
      slot: { type: "text", long: true },
    },
    ...COMMON,
  ],
};

/**
 * ELECTRICAL — ET ELECTRIC.
 *
 * work_kind and work carry onto Erik's walk-through and are the two that decide the shape of
 * everything after them: a service call prices off the trip and the hour, a contract job off the
 * takeoff, and `work` is what every later question hangs off. `walls` and `access` carry too —
 * both are things a homeowner can see and neither needs a tape.
 *
 * Not asked: the panel, the feed, the run length, the outlet count. Erik's own note on `access`
 * is the rule for all of them — "don't ask me about a building I'm not standing in" — and it goes
 * double for the person who lives there.
 */
export const ELECTRICAL_INTAKE: Playbook = {
  needs: [
    {
      key: "work_kind",
      label: "Service call or contract",
      ask: "Is this something that's broken, or a project you're planning?",
      slot: { type: "select", options: ["Service call", "Contract job"] },
    },
    {
      key: "work",
      label: "Kind of work",
      ask: "What are we doing? Pick anything that applies.",
      slot: {
        type: "select",
        multi: true,
        options: ["Add circuits", "Lighting", "Service / panel", "EV charger", "Remodel / rough-in", "Troubleshoot", "Generator"],
      },
    },
    {
      key: "walls",
      label: "Walls",
      ask: "Are the walls open, or already finished?",
      slot: { type: "select", options: ["Open", "Finished", "Some of each"] },
      when: [{ key: "work", known: true }],
    },
    {
      key: "access",
      label: "Access",
      ask: "How would we get to it?",
      slot: {
        type: "select",
        options: ["Open / easy", "Attic", "Crawlspace", "From below — cut and drill", "Tight / difficult"],
      },
      when: [{ key: "work", known: true }],
    },
    {
      key: "gotcha",
      label: "Anything that'll bite us",
      ask: "Anything else we should know before we come out?",
      // OPEN on Erik's walk-through; a box here for the same reason as the deck's site_notes.
      slot: { type: "text", long: true },
    },
    ...COMMON,
  ],
};

/**
 * WHICH INTAKE A NEW PUBLIC DOOR STARTS FROM.
 *
 * Matched on `trade_label`, because that is the only trade field an org actually has and it is
 * free text a person typed: "electrical contractor", "deck builder", "Construction". So this
 * looks for the word rather than demanding an enum, and anything it does not recognise gets the
 * trade-neutral five — which is the honest answer for "Construction", and is what a general
 * contractor should see anyway.
 *
 * A SEED IS A STARTING POINT, NEVER A REPLACEMENT. setPublicIntake only reaches this when there is
 * no "Customer intake" form at all; an org that already has one gets its own back, edits intact,
 * however many times the door is switched off and on.
 */
export function intakeStarterForTrade(tradeLabel: string | null | undefined, fallback: Playbook): Playbook {
  const t = String(tradeLabel ?? "").toLowerCase();
  if (/\bdeck/.test(t)) return DECK_INTAKE;
  if (/electric/.test(t)) return ELECTRICAL_INTAKE;
  return fallback;
}
