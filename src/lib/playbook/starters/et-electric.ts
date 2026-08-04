import type { Playbook } from "../types";

/**
 * ERIK'S PLAYBOOK — ET ELECTRIC.
 *
 * A DRAFT, written from what he has said across this build, for him to correct. The `why` lines
 * are the point: they are not documentation, they are the FUEL. They are what Nort reads to know
 * WHEN a question is worth asking, WHAT a bad answer costs, and when to shut up because he already
 * said it. A need with no `why` is a question with no judgement behind it.
 *
 * Where a line quotes him, it quotes him. Where it reasons about the trade, that reasoning is mine
 * and he should cut it — an inference dressed as his own judgement is worse than a blank.
 *
 * THE JOB THIS WAS BUILT AGAINST, in his words, in one breath, unprompted:
 *
 *   "2 new circuits one for lights and one for outlets installed new in a finished room with
 *    sheetrock and paint made originally for storage but now converting to living space requiring
 *    four 6" recessed cans connected in the ceiling requiring holes to be drilled in sheetrock to
 *    get wire into place and 2 outlets on each of 3 walls accessible from below by cutting the
 *    outlet holes in sheetrock then drilling down to feed wire from one to another all the way
 *    around connecting to a snap on breaker siemens style, 100 ft of 12.2 romex and 40' of 14/2
 *    romex"
 *
 * NINE FACTS. The shipped sheet answered that paragraph by asking him for the panel brand.
 */

const WORK = ["Add circuits", "Lighting", "Service / panel", "EV charger", "Remodel / rough-in", "Troubleshoot", "Generator"];
const NEEDS_POWER = ["Add circuits", "Lighting", "EV charger", "Remodel / rough-in", "Generator"];

export const ET_ELECTRIC: Playbook = {
  needs: [
    {
      key: "work",
      label: "Kind of work",
      ask: "What are we doing here?",
      slot: { type: "select", multi: true, options: WORK },
      feeds: ["what"],
      why: "Multi on purpose. The storage room was outlets AND lights on two circuits, and a router that only holds one answer is how the whole sheet asked the wrong questions.",
    },

    // ── THE OPEN ONES. No slot, so no control can hold them and none renders until answered. ──
    {
      key: "power_source",
      label: "Where the power's coming from",
      ask: "Where's the power coming from — which panel, how far, what's open in it?",
      feeds: ["what", "where"],
      hold: true,
      when: [{ key: "work", in: NEEDS_POWER }],
      why:
        "If the main panel's far, something closer usually is — a meter main, a sub, a J-box with room. " +
        "Two open slots at a close panel is either ONE 2-pole feeding a subpanel — short runs after that, room to grow — " +
        "or TWO 1-pole meaning exactly two circuits, each going the long way. Run length, wire size, conduit, breakers, " +
        "labor and trip count all hang off that one decision, and it's a decision I make standing in front of the customer. " +
        "Ask me the fork. Don't ask me for its outputs.",
    },
    {
      key: "permitted",
      label: "Permit, and what for",
      ask: "Is anybody pulling a permit, and what for?",
      feeds: ["why", "when", "what"],
      hold: true,
      why:
        "Not yes/no, and usually not me. On the storage room the homeowner is pulling one for OCCUPANCY — " +
        "I'm just doing the work so they can get it. That single fact reclassifies the room: receptacle spacing " +
        "off wall feet, AFCI, smoke and CO, and an inspection before anything gets covered. That's a rough-in " +
        "hold point and a second trip. Price it without knowing and the second trip isn't in the number.",
    },
    {
      key: "gotcha",
      label: "Anything that'll bite us",
      ask: "Anything here that's going to bite us?",
      feeds: ["why"],
      why: "The meter base pulling off the wall. The dog. The tenant who's only there Tuesdays. Nobody's template has a box for it and it's half of what goes wrong.",
    },

    // ── THE CLOSED ONES. Cold, offline, deterministic, and ORDERED. ──
    {
      key: "feed",
      label: "Feed",
      ask: "Subpanel, or home runs?",
      slot: { type: "select", options: ["Subpanel at the source", "Home runs to the existing panel", "Existing sub has room"] },
      feeds: ["what"],
      when: [{ key: "power_source", known: true }],
      why: "The fork itself. Everything about wire and labor is downstream of it, so nothing downstream gets asked until it's settled.",
    },
    {
      key: "run_ft",
      label: "Run (ft)",
      ask: "How far, source to the work?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "feed", known: true }],
      why:
        "Only after the feed is decided. Before that the number doesn't exist — a subpanel makes it 25 ft of feeder, " +
        "home runs makes it 100+ each, and there's no single answer to give. Asking me for one number too early is " +
        "exactly what sends my brain sideways.",
    },
    {
      key: "walls",
      label: "Walls",
      ask: "Walls open, or already finished?",
      slot: { type: "select", options: ["Open", "Finished", "Some of each"] },
      feeds: ["what"],
      when: [{ key: "work", in: WORK }],
      why:
        "Probably a 2x labor swing on its own. Finished means cutting and patching — and finished PLUS permitted means " +
        "they have to see it before it's covered, so it's two trips no matter how small the job is.",
    },
    {
      key: "wiring_method",
      label: "Wiring method",
      ask: "Fish it, or run surface?",
      slot: { type: "select", options: ["Fish it", "Surface EMT", "Surface MC", "Not decided yet"] },
      feeds: ["what"],
      when: [{ key: "walls", known: true }, { key: "permitted", known: true }],
      why:
        "This is a CONCLUSION, not an observation. Asking it before the wall finish and the permit are both known is " +
        "asking me to write the spec for a job I haven't designed yet. Once I know both, it's one tap.",
    },
    {
      key: "length_ft",
      label: "Room length",
      ask: "How long is the room?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "work", in: ["Add circuits", "Lighting", "Remodel / rough-in"] }],
      why:
        "NEVER ask me how many outlets. Under 210.52(A) no point along a wall is more than 6 ft from a receptacle, " +
        "so the count comes out of the wall feet — ask me the room and show me the count. On the storage room that's " +
        "3 walls and a roll-up, which changes the answer, and it's arithmetic either way, not a question.",
    },
    {
      key: "width_ft",
      label: "Room width",
      ask: "And how wide?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "length_ft", known: true }],
      why: "With the length this gives square footage, which sizes the lighting. Two numbers I read off one tape pull.",
    },
    {
      key: "ceiling_ft",
      label: "Ceiling height",
      ask: "Ceiling height?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "work", in: ["Lighting", "Remodel / rough-in"] }],
      why: "Drives can spacing and whether I'm on a ladder or a lift. Ten feet is a different day than eight.",
    },
    {
      key: "panel_condition",
      label: "Panel",
      ask: "What's the panel — brand, size, any room in it?",
      slot: { type: "text" },
      feeds: ["what", "why"],
      when: [{ key: "work", in: ["Service / panel", "Add circuits", "EV charger", "Generator"] }],
      why:
        "Zinsco or Federal Pacific and I'm not adding a breaker to it at all — that turns a $400 circuit into a service " +
        "change, and the customer needs to hear that from me on site, not in an estimate three days later. " +
        "One text box, because 'Siemens, 200A, two slots open' is one thing I say, not three fields.",
    },
    {
      key: "access",
      label: "Access",
      ask: "How am I getting to it?",
      slot: { type: "select", options: ["Open / easy", "Attic", "Crawlspace", "From below — cut and drill", "Tight / difficult"] },
      feeds: ["what"],
      when: [{ key: "work", in: WORK }],
      why:
        "The storage room was 'from below, cut the outlet holes and drill wall to wall' — that IS the labor, and it's " +
        "not attic and it's not crawlspace. Don't ask me about a building I'm not standing in.",
    },
    {
      key: "materials_known",
      label: "Wire and parts",
      ask: "What are you putting in it?",
      slot: { type: "text", long: true },
      feeds: ["what"],
      when: [{ key: "feed", known: true }],
      why:
        "Half the time I already know: '100 ft of 12-2 and 40 of 14-2, snap-on Siemens.' When I say it, take it and " +
        "stop asking. When I don't, that's when the price book earns its keep — but don't make me dictate a takeoff " +
        "I haven't done yet.",
    },
  ],
};

/**
 * WHAT I DELIBERATELY DID NOT PUT IN, and why — each of these was on his real sheet and each one
 * failed him on 13125 Moraine Rd:
 *
 *   device_count / fixture_count  — 210.52 derives receptacles from wall feet. Asking a man to
 *                                   count outlets he hasn't laid out yet is asking for a guess and
 *                                   then pricing it as a fact.
 *   attic_access / crawl_access   — two questions about a building he wasn't in. Folded into one
 *                                   `access` whose options are the ways he actually gets to work.
 *   "Panel" as a bare label       — not a question. It transmits nothing about the answer wanted,
 *                                   which is why he typed 2 into it and then 2 again into the next
 *                                   box. It is now a sentence.
 *   permit as a checkbox          — a boolean cannot hold "the homeowner is pulling one for
 *                                   occupancy", which is the version that changes the price. It ate
 *                                   the answer twice (cn-v617) before it was even asked properly.
 */
