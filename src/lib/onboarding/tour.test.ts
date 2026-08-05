import { describe, it, expect } from "vitest";
import { DOCK } from "@/lib/dock";
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
    // Both brothers, both shapes: arithmetic and a fork. Erik on the old permit example: "the
    // example in #7 makes no sense to me nor do my why lines."
    expect(ex).toContain("board count");
    expect(ex).toContain("home runs");
    expect(ex.toLowerCase()).toContain("square footage");
  });

  it("and it promises the draft that comes next, so the hand-off isn't a surprise", () => {
    expect(sayOf(TOUR.find((s) => s.key === "why-how")!.say, STRANGER).toLowerCase()).toContain("draft");
  });
});

describe("it points at things that exist", () => {
  // Anchors the SHELL carries, so they're reachable from any route (topbar.tsx, dock.tsx,
  // setup-button.tsx, account-menu.tsx). `settings-link` is the Settings item INSIDE the account
  // menu — it is not on the settings page, it is the door to it, which is the whole point.
  const SHELL = ["nort", "setup", "quickadd", "search", "bell", "account", "dock", "settings-link"];
  // dock-<sectionKey> is set per section by dock.tsx, on BOTH the desktop rail and the mobile bar.
  const isDockSection = (a: string) => DOCK.some((d) => a === `dock-${d.key}`);
  // Anchors that only exist once you are standing on /settings.
  const settingsOnly = (a: string) => a === "sections-settings" || (a.startsWith("settings-") && a !== "settings-link");

  it("every anchor is one the app sets", () => {
    for (const s of TOUR) {
      if (!s.anchor || settingsOnly(s.anchor) || isDockSection(s.anchor)) continue;
      expect(SHELL, `${s.key} points at ${s.anchor}`).toContain(s.anchor);
    }
  });

  it("a step that points INTO settings also routes there", () => {
    // An anchor that only exists on /settings, shown while standing on /planner, is a dimmed
    // screen and a card pointing at nothing.
    for (const s of TOUR) if (s.anchor && settingsOnly(s.anchor)) expect(s.route, s.key).toMatch(/^\/settings/);
  });

  it("...but the DOOR to settings is anchored in the shell, and does NOT route there", () => {
    // Erik: "ive been asked multiple times where settings is located and in the tour it shows it
    // open but not where the button is." A step that navigates you to /settings can never show
    // you the button, because the button is how you'd have got there.
    const door = TOUR.find((s) => s.anchor === "settings-link")!;
    expect(door, "no step points at the Settings link itself").toBeTruthy();
    expect(door.route, "the door step must not teleport past the door").toBeUndefined();
    // And it comes BEFORE any step that lands on the page.
    const firstOnPage = TOUR.findIndex((s) => s.route?.startsWith("/settings"));
    expect(TOUR.indexOf(door)).toBeLessThan(firstOnPage);
  });

  it("a poke step has something to poke, and waits for a real anchor", () => {
    for (const s of TOUR) {
      if (s.poke) expect(s.anchor, `${s.key} is pokeable but points at nothing`).toBeTruthy();
      if (s.awaits) {
        // It must wait for something the app actually sets, or the tour stops dead.
        expect(
          SHELL.includes(s.awaits) || settingsOnly(s.awaits) || isDockSection(s.awaits),
          `${s.key} awaits ${s.awaits}`,
        ).toBe(true);
        // Waiting for a tap AND asking a question are two different kinds of turn.
        expect(s.ask, `${s.key} both awaits and asks`).toBeUndefined();
      }
    }
  });

  it("the account step names Settings — it used to list everything except it", () => {
    const account = TOUR.find((s) => s.key === "account")!;
    expect(sayOf(account.say, STRANGER).toLowerCase()).toContain("settings");
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
    // Raised 20 -> 24 when Erik asked for the pipeline: "the tour should point out the process
    // starting with leads all the way through". Six steps of run, paid for by folding the three
    // one-line topbar-button steps into one. 24 is the new line, and the next thing that wants in
    // buys its place by taking something else out — the ceiling is the only reason this stayed a
    // tour instead of becoming a manual.
    expect(TOUR.length).toBeLessThanOrEqual(24);
  });

  describe("THE RUN — lead to paid, and it must never overclaim", () => {
    // A truth pass over the code cut ELEVEN claims from the first drafts of these steps. This is
    // the guard that stops them creeping back, because every one of them is a sentence somebody
    // would happily write again — they all SOUND true, and a contractor who believes his estimate
    // priced itself sends one without reading it.
    const said = spoken(STRANGER).join(" ").toLowerCase();

    it("walks the pipeline in the order the work happens", () => {
      const order = ["run-lead", "run-walk", "run-estimate", "run-job", "run-money", "run-win"];
      const at = order.map((k) => TOUR.findIndex((s) => s.key === k));
      expect(at.every((i) => i >= 0), "a run step went missing").toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    });

    it("points at the dock tile it is talking about", () => {
      expect(TOUR.find((s) => s.key === "run-lead")!.anchor).toBe("dock-sales");
      expect(TOUR.find((s) => s.key === "run-job")!.anchor).toBe("dock-jobs");
      // The Money section's key really is `invoices` (dock.ts) even though its label is "Money".
      expect(TOUR.find((s) => s.key === "run-money")!.anchor).toBe("dock-invoices");
    });

    it("never claims an automation the code does not do", () => {
      // Each of these was in a draft and was cut against a specific file:
      //   the app texts the customer      -> convert-menu builds an `sms:` href; HE presses send
      //   hours attach themselves         -> the tech picks the job at clock-in
      //   invoices send on their own       -> finishJob emails only when opts.sendInvoice is ticked
      //   the estimate prices itself       -> nothing prices until Generate Line Items
      for (const bad of [
        "i text them",
        "i send the text",
        "sends itself",
        "send themselves",
        "prices itself",
        "automatically",
        "on their own",
        "70%",
        "80 percent",
      ])
        expect(said, `the tour claims: "${bad}"`).not.toContain(bad);
    });

    it("says out loud where the human still presses the button", () => {
      // The counterweight to the test above: cutting overclaims must not leave it vague.
      expect(said).toContain("you send it");
      expect(said).toContain("until you press generate line items");
      expect(said).toContain("unless you tick the box");
    });

    it("and the trade answer no longer claims to build job codes", () => {
      // saveSetup writes trade_label/city/service_area/rate and seeds a starter walk-through. It
      // never touches job_codes — those come only from importTradeCodePack, called by hand from
      // Settings. This was live in the shipped tour until the run's truth pass found it.
      expect(said).not.toContain("builds your job codes");
      expect(said).toContain("starter job codes");
    });

    it("the tone step names the dial AND the limits that make it safe", () => {
      const tone = sayOf(TOUR.find((s) => s.key === "tone")!.say, STRANGER).toLowerCase();
      expect(tone).toContain("never go first");
      expect(tone).toMatch(/customer|homeowner/);
      expect(TOUR.find((s) => s.key === "tone")!.route).toBe("/settings?tab=you");
    });
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
