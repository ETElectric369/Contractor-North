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
      why: "Picks which questions come next — everything else on the sheet hangs off this one.",
      note:
        "Multi on purpose. The storage room was outlets AND lights on two circuits, and a router that " +
        "only holds one answer is how the whole sheet asked the wrong questions.",
    },

    // ── THE OPEN ONES. No slot, so no control can hold them and none renders until answered. ──
    {
      key: "power_source",
      label: "Where the power's coming from",
      ask: "Where's the power coming from — which panel, how far, what's open in it?",
      feeds: ["what", "where"],
      hold: true,
      when: [{ key: "work", in: NEEDS_POWER }],
      why: "Decides subpanel or home runs — and that sets every run length, wire size and trip count after it.",
      note:
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
      why: "Permitted for occupancy means an inspection before cover — that's a second trip in the price.",
      note:
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
      why: "Adds hours nothing else on the sheet accounts for — it's half of what goes wrong.",
      note:
        "The meter base pulling off the wall. The dog. The tenant who's only there Tuesdays. Nobody's " +
        "template has a box for it and it's half of what goes wrong.",
    },

    // ── THE CLOSED ONES. Cold, offline, deterministic, and ORDERED. ──
    {
      key: "feed",
      label: "Feed",
      ask: "Subpanel, or home runs?",
      slot: { type: "select", options: ["Subpanel at the source", "Home runs to the existing panel", "Existing sub has room"] },
      feeds: ["what"],
      when: [{ key: "power_source", known: true }],
      why: "Sets the wire and the labor for everything after it — nothing downstream gets asked until it's settled.",
    },
    {
      key: "run_ft",
      label: "Run (ft)",
      ask: "How far, source to the work?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "feed", known: true }],
      why: "Times the wire cost per foot, plus the conduit — 25 ft of feeder or 100-plus each way.",
      note:
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
      why: "Roughly doubles the labor on its own — and finished plus permitted is two trips however small the job is.",
      note:
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
      why: "Sets the material — fish it, EMT or MC. It's what the walls and the permit add up to.",
      note:
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
      why: "Wall feet divided by 6 gives the outlet count under 210.52(A) — that's arithmetic, not a question.",
      note:
        "Under 210.52(A) no point along a wall is more than 6 ft from a receptacle, so the count comes out of the " +
        "wall feet — ask me the room and show me the count. On the storage room that's 3 walls and a roll-up, which " +
        "changes the answer, and it's arithmetic, not a question. But only when I've given you the room: if I haven't, " +
        "the count is a fair thing to ask.",
    },
    {
      key: "width_ft",
      label: "Room width",
      ask: "And how wide?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "length_ft", known: true }],
      why: "Times the length is the square footage, and that sizes the lighting.",
      note: "Two numbers I read off one tape pull.",
    },
    {
      key: "ceiling_ft",
      label: "Ceiling height",
      ask: "Ceiling height?",
      slot: { type: "number", unit: "ft" },
      measured: true,
      feeds: ["what"],
      when: [{ key: "work", in: ["Lighting", "Remodel / rough-in"] }],
      why: "Drives can spacing, and decides ladder or lift — ten feet is a different day than eight.",
    },
    {
      key: "device_count",
      label: "How many outlets",
      ask: "How many outlets are we putting in?",
      slot: { type: "number" },
      measured: true,
      feeds: ["what"],
      // ASK IT ONLY IF I DIDN'T GIVE YOU THE ROOM. Erik: "i dont necessarily want it to never ask
      // me an outlet count, thats important and if it cant be resolved from the info then its an
      // appropriate question." Measure the room and it's arithmetic; skip the tape and it's a
      // question — and the moment the dimensions arrive this stops applying and the derived count
      // wins, with clearInapplicable nulling whatever was guessed.
      when: [{ key: "work", in: ["Add circuits", "Remodel / rough-in"] }, { key: "length_ft", unknown: true }],
      why: "Times the per-outlet price. Second choice — if I gave you the room you already have it off wall feet.",
      note:
        "Second choice, not the first. If I've walked it with a tape you already have the count off wall feet and " +
        "asking is noise. If I haven't — quoting off a phone call, or the room's full of somebody's storage — then " +
        "my number is the best number there is and you should take it.",
    },
    {
      key: "panel_condition",
      label: "Panel",
      ask: "What's the panel — brand, size, any room in it?",
      slot: { type: "text" },
      feeds: ["what", "why"],
      when: [{ key: "work", in: ["Service / panel", "Add circuits", "EV charger", "Generator"] }],
      why: "Decides breaker or service change — Zinsco or FPE turns a $400 circuit into a panel swap.",
      note:
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
      why: "That IS the labor — cut-and-drill from below prices nothing like an open wall.",
      note:
        "The storage room was 'from below, cut the outlet holes and drill wall to wall' — that IS the labor, and it's " +
        "not attic and it's not crawlspace. Don't ask me about a building I'm not standing in.",
    },
    {
      key: "materials_known",
      label: "Wire and parts",
      ask: "What are you putting in it?",
      // OPEN, and UNGATED. Both on purpose, and the second one is a bug this playbook had:
      // gating it on the feed meant a wire list he volunteered in his opening breath — which he
      // does constantly — got NULLED by clearInapplicable the moment it was written, because the
      // feed hadn't been picked yet. A need that can be satisfied before its gate must not have
      // one. Open because "100 ft of 12-2 and 40 of 14-2, snap-on Siemens" is a sentence, so it
      // stays a chip until he reaches for it rather than an empty paragraph box on every job.
      feeds: ["what"],
      why: "Goes straight to the takeoff — when I say it, take it; when I don't, the price book fills it.",
      note:
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
