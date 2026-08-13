import { describe, it, expect } from "vitest";
import { ET_ELECTRIC } from "./et-electric";
import { applicableNeeds, clearInapplicable, holdingNeeds, isClosed, isOpen, missingNeeds, splitAsk } from "../resolve";

/**
 * THE ACCEPTANCE TEST IS ERIK'S OWN JOB — 13125 Moraine Rd, said in one breath, unprompted:
 *
 *   "Adding outlets and lights in a storage room they're converting. They're pulling a permit for
 *    occupancy. Main panel's way the hell over on the other side but the meter panel's right here
 *    with two open slots."
 *
 * The shipped sheet answered that by asking him for the panel brand.
 */

describe("it opens with one question", () => {
  it("nothing GATED applies before the work is named", () => {
    const first = applicableNeeds(ET_ELECTRIC, {});
    expect(first.map((n) => n.key)).toEqual(["work_kind", "work", "permitted", "gotcha", "materials_known"]);
    // work_kind joined the opening deliberately — Erik: "a service call title/option in the
    // inspector would be sufficient, these are the ones that would go to the board." It is the
    // shape-decider, so it sits above the work itself. Nothing gated has appeared: every need with
    // a `when` clause is still waiting, which is what this test is actually for.
    expect(first.every((n) => !n.when?.length)).toBe(true);
    // TWO controls now, not one. The rest are open — a sentence, not a box.
    expect(first.filter((n) => !isOpen(n)).map((n) => n.key)).toEqual(["work_kind", "work"]);
  });

  it("WHAT IS ACTUALLY ON SCREEN: the shape-deciders, and the rest are chips", () => {
    // "available is not visible", in the data. `work` shows because it has a control. `permitted`
    // shows despite having none, because it is a HOLD — don't let me price without it. The other
    // two are sentences nobody has reached for yet, so each is one named tap away instead of an
    // empty box sitting between him and the work.
    // THREE now, and the third was asked for by name. That is a real cost against "available is
    // not visible" — every control at the top is one more thing between him and the work — and it
    // is the price of knowing on question one whether this is a half-hour service call.
    const { ask, reach } = splitAsk(ET_ELECTRIC, {});
    expect(ask.map((n) => n.key)).toEqual(["work_kind", "work", "permitted"]);
    expect(reach.map((n) => n.key)).toEqual(["gotcha", "materials_known"]);
  });

  it("and reaching for one puts it up top, never locked away", () => {
    const { ask, reach } = splitAsk(ET_ELECTRIC, {}, new Set(["gotcha"]));
    expect(ask.map((n) => n.key)).toContain("gotcha");
    expect(reach.map((n) => n.key)).toEqual(["materials_known"]);
  });
});

describe("the storage room, turn by turn", () => {
  // What Nort extracts from that one paragraph. Every fact was volunteered.
  const heard = {
    work: ["Add circuits", "Lighting"],
    permitted: "Occupancy — homeowner pulling it",
    power_source: "Meter panel adjacent, 2 open slots; main panel far side",
  };

  it("outlets AND lights — the multi-select the old router couldn't hold", () => {
    expect(applicableNeeds(ET_ELECTRIC, heard).map((n) => n.key)).toContain("power_source");
  });

  it("nothing he already said gets asked back at him", () => {
    const still = missingNeeds(ET_ELECTRIC, heard).map((n) => n.key);
    expect(still).not.toContain("work");
    expect(still).not.toContain("permitted");
    expect(still).not.toContain("power_source");
  });

  it("the next question is THE FORK, and it is the only new one", () => {
    // "Ask me the fork. Don't ask me for its outputs."
    expect(missingNeeds(ET_ELECTRIC, heard).map((n) => n.key)).toContain("feed");
  });

  /**
   * THE ACCEPTANCE TEST — the WHOLE paragraph, every fact he volunteered without being asked:
   *
   *   "2 new circuits one for lights and one for outlets installed new in a finished room with
   *    sheetrock and paint made originally for storage but now converting to living space
   *    requiring four 6" recessed cans connected in the ceiling requiring holes to be drilled in
   *    sheetrock to get wire into place and 2 outlets on each of 3 walls accessible from below by
   *    cutting the outlet holes in sheetrock then drilling down to feed wire from one to another
   *    all the way around connecting to a snap on breaker siemens style, 100 ft of 12.2 romex and
   *    40' of 14/2 romex"
   *
   * The shipped sheet answered that by asking him for the panel brand.
   */
  const said = {
    ...heard,
    walls: "Finished",
    device_count: 6, // "2 outlets on each of 3 walls"
    access: "From below — cut and drill",
    panel_condition: "Siemens snap-on, two slots open",
    materials_known: "100 ft of 12-2, 40 ft of 14-2",
  };

  it("nothing he said is asked back at him — not one of it", () => {
    const still = missingNeeds(ET_ELECTRIC, said).map((n) => n.key);
    for (const k of Object.keys(said)) expect(still, k).not.toContain(k);
  });

  it("...and nothing he said is quietly THROWN AWAY either", () => {
    // The subtler half, and a bug this playbook actually had: `materials_known` used to wait on
    // the feed, so the wire list he volunteers in his opening breath got nulled by
    // clearInapplicable before anybody picked one. A need that can be satisfied before its gate
    // must not have a gate.
    const kept = clearInapplicable(ET_ELECTRIC, said);
    for (const [k, v] of Object.entries(said)) expect(kept[k], k).toEqual(v);
  });

  it("what's left is the fork, the conclusion it leads to, and two numbers he didn't say", () => {
    // feed          the decision he makes standing in front of the customer
    // wiring_method a conclusion, and it only became askable once walls AND permit were both known
    // length_ft     the tape he hasn't pulled
    // ceiling_ft    ladder or lift
    // work_kind leads: he described the whole job in that paragraph and never said whether it was
    // a service call or a contract, and a classification is not something to infer from prose.
    expect(splitAsk(ET_ELECTRIC, said).ask.map((n) => n.key)).toEqual([
      "work_kind",
      "feed",
      "wiring_method",
      "length_ft",
      "ceiling_ft",
    ]);
  });

  it("and the run length does NOT exist yet", () => {
    // "a subpanel makes it 25 ft of feeder, home runs makes it 100+ each"
    expect(missingNeeds(ET_ELECTRIC, heard).map((n) => n.key)).not.toContain("run_ft");
    const decided = { ...heard, feed: "Subpanel at the source" };
    expect(missingNeeds(ET_ELECTRIC, decided).map((n) => n.key)).toContain("run_ft");
  });

  it("wiring method waits for walls AND permit — the conjunction that made it answerable", () => {
    const withFeed = { ...heard, feed: "Subpanel at the source", run_ft: 25 };
    expect(missingNeeds(ET_ELECTRIC, withFeed).map((n) => n.key)).not.toContain("wiring_method");
    // permit was already known from the paragraph; walls is the one that unlocks it.
    expect(missingNeeds(ET_ELECTRIC, { ...withFeed, walls: "Finished" }).map((n) => n.key)).toContain("wiring_method");
  });

  it("ADD WHATEVER IS STATED — the outlet count is asked, and measuring the room does not take it away", () => {
    // Erik, reading his own why line back: "i dont understand the /6 rule, it shouldnt be more
    // complicated than adding whatever is stated." The divisor was an inference off 210.52(A) that
    // I had written into his mouth, and the derivation it promised existed nowhere in the codebase
    // — so pulling out a tape made the outlet count leave the estimate. The more carefully he
    // worked, the less he got.
    const noTape = { work: ["Add circuits"] };
    expect(missingNeeds(ET_ELECTRIC, noTape).map((n) => n.key)).toContain("device_count");

    // Measured room, SAME question. This is the assertion that used to say `not.toContain`.
    const measured = { ...noTape, length_ft: 16, width_ft: 20 };
    expect(missingNeeds(ET_ELECTRIC, measured).map((n) => n.key)).toContain("device_count");
  });

  it("...and his count survives the tape rather than being nulled by it", () => {
    // The old rule cleared this on the grounds that a derived value would replace it. Nothing ever
    // derived one, so the clear was a straight deletion of the only number anybody had.
    const stated = { work: ["Add circuits"], device_count: 6 };
    expect(clearInapplicable(ET_ELECTRIC, { ...stated, length_ft: 16 }).device_count).toBe(6);
  });

  it("no why line in this playbook claims a derivation the code does not perform", () => {
    // The general form of the same mistake: a why line is where the answer lands in the price, and
    // a why line that describes arithmetic nobody wrote is a promise the estimate cannot keep.
    const whys = ET_ELECTRIC.needs.map((n) => `${n.why ?? ""} ${n.note ?? ""}`).join(" ");
    expect(whys).not.toMatch(/divided by \d|\/\s*\d+\s*(gives|=)/i);
  });

  it("fixture count is never asked — that one really is derived", () => {
    expect(ET_ELECTRIC.needs.map((n) => n.key)).not.toContain("fixture_count");
  });

  it("and never about a building he isn't in", () => {
    expect(ET_ELECTRIC.needs.map((n) => n.key)).not.toContain("attic_access");
    expect(ET_ELECTRIC.needs.map((n) => n.key)).not.toContain("crawl_access");
  });
});

describe("the two facts he must not price without", () => {
  it("permit and power source are holds", () => {
    expect(holdingNeeds(ET_ELECTRIC, {}).map((n) => n.key)).toEqual(["permitted"]);
    expect(holdingNeeds(ET_ELECTRIC, { work: ["Add circuits"] }).map((n) => n.key)).toEqual(["power_source", "permitted"]);
  });

  it("both clear once he's said them", () => {
    const heard = { work: ["Add circuits"], power_source: "meter panel, 2 slots", permitted: "Occupancy" };
    expect(holdingNeeds(ET_ELECTRIC, heard)).toEqual([]);
  });
});

describe("this playbook is OPEN, and that is correct for him", () => {
  it("it holds sentences no control can carry", () => {
    expect(isClosed(ET_ELECTRIC, {})).toBe(false);
    expect(ET_ELECTRIC.needs.filter(isOpen).map((n) => n.key)).toEqual([
      "power_source",
      "permitted",
      "gotcha",
      "materials_known",
    ]);
  });

  it("every open need still carries a real question", () => {
    // An open need renders nothing until answered, so `ask` is the ONLY thing a person ever
    // encounters. A blank one is a question that can never be asked.
    for (const n of ET_ELECTRIC.needs.filter(isOpen)) expect(n.ask.trim().length).toBeGreaterThan(10);
  });
});

describe("the playbook is well-formed", () => {
  it("no rule points at a question defined later", () => {
    const seen = new Set<string>();
    for (const n of ET_ELECTRIC.needs) {
      for (const c of n.when ?? []) expect(seen.has(c.key), `${n.key} → ${c.key}`).toBe(true);
      seen.add(n.key);
    }
  });

  it("every membership rule names a real option of a real select", () => {
    const byKey = new Map(ET_ELECTRIC.needs.map((n) => [n.key, n]));
    for (const n of ET_ELECTRIC.needs)
      for (const c of n.when ?? []) {
        if (!("in" in c)) continue;
        const t = byKey.get(c.key)!;
        expect(t.slot?.type, `${n.key} gates on ${c.key}`).toBe("select");
        for (const v of c.in) expect((t.slot as { options: string[] }).options, `${n.key}`).toContain(v);
      }
  });

  it("no duplicate keys", () => {
    const keys = ET_ELECTRIC.needs.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every need says what it feeds and why", () => {
    // The why IS the fuel. A need without one is a question with no judgement behind it.
    for (const n of ET_ELECTRIC.needs) {
      expect(n.feeds?.length, `${n.key} has no feeds`).toBeGreaterThan(0);
      expect(n.why?.trim().length ?? 0, `${n.key} has no why`).toBeGreaterThan(20);
    }
  });

  it("every measured need is a number — a calculator input must be arithmetic", () => {
    for (const n of ET_ELECTRIC.needs.filter((x) => x.measured)) expect(n.slot?.type).toBe("number");
  });
});
