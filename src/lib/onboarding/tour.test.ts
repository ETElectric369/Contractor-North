import { describe, it, expect } from "vitest";
import { TOUR, sayOf, tourIndex, type TourCtx } from "./tour";
import { SETUP_PLAYBOOK } from "./setup-playbook";

/** Somebody Nort has never met, and somebody he has. Lines that change must work for both. */
const STRANGER: TourCtx = { first: "", trade: "", city: "", rate: "", returning: false };
const KNOWN: TourCtx = { first: "Erik", trade: "electrical contractor", city: "Truckee", rate: "$145", returning: true };
const spoken = (c: TourCtx) => TOUR.map((s) => sayOf(s.say, c));

/**
 * The tour is DATA, so it can be wrong in the ways data is wrong: a typo'd key makes a step
 * unanswerable, a missing `say` makes Nort mute, a duplicate key makes "resume" land somewhere
 * random. None of those throw — they just quietly waste the one chance you get to teach somebody.
 */

describe("every question the tour asks is a real one", () => {
  it("each `ask` names a need in SETUP_PLAYBOOK", () => {
    const keys = new Set(SETUP_PLAYBOOK.needs.map((n) => n.key));
    for (const s of TOUR) if (s.ask) expect(keys, `${s.key} asks ${s.ask}`).toContain(s.ask);
  });

  it("the questions come in the playbook's own order — no zig-zag", () => {
    const order = SETUP_PLAYBOOK.needs.map((n) => n.key);
    const asked = TOUR.filter((s) => s.ask).map((s) => s.ask!);
    expect(asked).toEqual([...asked].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  });

  it("NORT IS THE FIRST THING, and he asks rather than tells", () => {
    // Erik: "people need to know how Nort works first and foremost". The old version opened with
    // five text boxes, which teaches that the assistant is a garnish.
    expect(TOUR[0].anchor).toBe("nort");
    expect(TOUR[0].ask).toBeTruthy();
  });
});

describe("the why-line lesson is actually in here", () => {
  const said = spoken(STRANGER).join(" ").toLowerCase();

  it("says what a why line IS, shows one, and says how to write it", () => {
    // "i didnt even know what a why line really meant until you showed me" — the whole reason the
    // tour exists. A tour that skips this is the form it replaced.
    for (const key of ["why-what", "why-example", "why-how"]) expect(TOUR.map((s) => s.key)).toContain(key);
    expect(said).toContain("why line");
  });

  it("the example is a REAL one, not a description of one", () => {
    // An abstract "explain your reasoning" teaches nothing. The example carries a concrete cost.
    const ex = sayOf(TOUR.find((s) => s.key === "why-example")!.say, STRANGER).toLowerCase();
    expect(ex).toContain("permit");
    expect(ex).toContain("second trip");
  });

  it("and it promises the draft that comes next, so the hand-off isn't a surprise", () => {
    expect(sayOf(TOUR.find((s) => s.key === "why-how")!.say, STRANGER).toLowerCase()).toContain("draft");
  });
});

describe("it points at things that exist", () => {
  // The anchors the shell actually carries (topbar.tsx, dock.tsx, setup-button.tsx).
  const ANCHORS = ["nort", "setup", "quickadd", "search", "bell", "account", "dock"];

  it("every anchor is one the app sets", () => {
    for (const s of TOUR) {
      if (!s.anchor) continue;
      // settings-<cluster> is set per cluster by SettingsSubnav; the rest are the shell's.
      if (s.anchor.startsWith("settings-")) continue;
      expect(ANCHORS, `${s.key} points at ${s.anchor}`).toContain(s.anchor);
    }
  });

  it("a step that points INTO settings also routes there", () => {
    // An anchor that only exists on /settings, shown while standing on /planner, is a dimmed
    // screen and a card pointing at nothing.
    for (const s of TOUR)
      if (s.anchor?.startsWith("settings-")) expect(s.route, s.key).toMatch(/^\/settings/);
  });

  it("the things Erik named by hand are all covered", () => {
    // "where the button is for nort … how does the nav work and where are the settings and my qr
    // code and all the things"
    const anchored = TOUR.map((s) => s.anchor);
    for (const a of ["nort", "dock", "account"]) expect(anchored).toContain(a);
    const said = spoken(STRANGER).join(" ").toLowerCase();
    expect(said).toContain("qr code");
    expect(said).toContain("settings");
  });
});

describe("well-formed", () => {
  it("unique keys — resume lands where it was left", () => {
    const keys = TOUR.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("nothing is mute or nameless, for a stranger OR for somebody he knows", () => {
    for (const c of [STRANGER, KNOWN])
      for (const s of TOUR) {
        expect(s.title.trim().length, s.key).toBeGreaterThan(2);
        expect(sayOf(s.say, c).trim().length, s.key).toBeGreaterThan(40);
      }
  });

  it("HE USES YOUR NAME WHEN HE HAS IT, and doesn't ask for it back", () => {
    // Erik: "nort beginning to get to know you a person and recognize your name if youve already
    // input it". A thing that says "tell me your name" with the name on screen behind it reads as
    // not really listening — which is exactly the reader who is least sure they belong here.
    const hello = sayOf(TOUR[0].say, KNOWN);
    expect(hello).toContain("Erik");
    expect(hello.toLowerCase()).not.toContain("tell me your name");
    // ...and a stranger still gets asked.
    expect(sayOf(TOUR[0].say, STRANGER).toLowerCase()).toContain("tell me your name");
  });

  it("no line leaves a hole when he knows nothing — no 'out of undefined'", () => {
    for (const t of spoken(STRANGER)) {
      expect(t).not.toContain("undefined");
      expect(t).not.toMatch(/\s,|\s\./); // a dangling comma or stop where a value was meant to go
    }
  });

  it("it is a tour, not an epic — this gets taken standing in a truck", () => {
    expect(TOUR.length).toBeLessThanOrEqual(20);
  });

  it("THE LOOP CLOSES BOTH WAYS — he says back what he knows, and what he is for", () => {
    // Erik: "Nort gets to know me and i get to know Nort … he needs me to know he exists and for
    // me to know that he knows that i know he knows." Every question before this one is Nort
    // learning HIM; a loop that only runs one way is a form.
    const recap = TOUR.find((s) => s.key === "recap")!;
    const known = sayOf(recap.say, KNOWN);
    expect(known).toContain("Erik");
    expect(known).toContain("Truckee");
    expect(known).toContain("$145");
    // ...and his own half: what he does, and the promise about numbers.
    expect(known.toLowerCase()).toContain("every screen");
    expect(known.toLowerCase()).toContain("make a number up");
    // A stranger gets the same handshake without dangling commas where facts should be.
    const cold = sayOf(recap.say, STRANGER);
    expect(cold).not.toContain("undefined");
    expect(cold.toLowerCase()).toContain("every screen");
  });

  it("resume is total: an unknown or missing key starts at the beginning", () => {
    expect(tourIndex("why-how")).toBe(TOUR.findIndex((s) => s.key === "why-how"));
    expect(tourIndex("nope")).toBe(0);
    expect(tourIndex(null)).toBe(0);
    expect(tourIndex(undefined)).toBe(0);
  });
});
