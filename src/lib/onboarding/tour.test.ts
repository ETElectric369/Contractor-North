import { describe, it, expect } from "vitest";
import { DOCK } from "@/lib/dock";
import { TOUR, sayOf, tourIndex, type TourCtx } from "./tour";
import { SETUP_PLAYBOOK } from "./setup-playbook";

/** A sentence that CLAIMS where something came from, as opposed to where it lives. */
const ORIGIN_VERB = /\b(came|come|comes|built|builds|build|seeded|seeds|created|creates|set up|sets up|made|makes)\b/i;

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
  // `account-menu` is the PANEL behind the initials — in the shell, reachable from any route, and
  // only in the DOM while the menu is open, which is why its step carries `opens`.
  const SHELL = ["nort", "setup", "quickadd", "search", "bell", "account", "dock", "account-menu"];
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
    const door = TOUR.find((s) => s.key === "settings-door")!;
    expect(door.route, "the door step must not teleport past the door").toBeUndefined();
    // It points at the whole PANEL, and it opens that panel itself — a row-sized hole in the
    // dimmer left the rest of the menu under 72% black, which read as "it never opened".
    expect(door.anchor).toBe("account-menu");
    expect(door.opens).toBe("account");
    expect(sayOf(door.say, STRANGER).toLowerCase()).toContain("settings");
    // And it comes BEFORE any step that lands on the page.
    const firstOnPage = TOUR.findIndex((s) => s.route?.startsWith("/settings"));
    expect(TOUR.indexOf(door)).toBeLessThan(firstOnPage);
  });

  it("NOTHING WAITS FOR A CLICK", () => {
    // Erik: "i dont want it waiting for me to click anything." A step that gates on a tap is a
    // form wearing a tour's clothes. Only `ask` may pause, and that one is his turn to talk.
    for (const s of TOUR) {
      expect(s, `${s.key} still gates on a tap`).not.toHaveProperty("awaits");
      expect(s, `${s.key} still gates on a tap`).not.toHaveProperty("poke");
    }
  });

  it("a step that opens a menu also points at that menu", () => {
    // Opening a panel and then spotlighting something else leaves it hanging over the screen.
    for (const s of TOUR) if (s.opens) expect(s.anchor, `${s.key} opens a menu it never shows`).toBe("account-menu");
  });

  it("the initials beat and the door land back to back", () => {
    // The old `account` step listed sign-out, language and the QR code and never said the word
    // Settings — which is where Settings lives. Now one step shows WHERE the initials are and the
    // next opens them and names the row, so the pair has to stay adjacent and in that order.
    const a = TOUR.findIndex((s) => s.key === "account");
    const b = TOUR.findIndex((s) => s.key === "settings-door");
    expect(b).toBe(a + 1);
    expect(TOUR[a].anchor).toBe("account");
    expect((sayOf(TOUR[a].say, STRANGER) + sayOf(TOUR[b].say, STRANGER)).toLowerCase()).toContain("settings");
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
      //
      // The estimate line moved when cn-v716 rebuilt that surface. It used to be "nothing gets
      // priced until you press Generate Line Items", which was the only human-presses-it beat in
      // that step because everything after the press landed by itself. Now the press is the
      // SECOND gate, not the first, and the copy has to name the one that matters: the tick and
      // the Add.
      expect(said).toContain("you send it");
      expect(said).toContain("tick the ones you want");
      expect(said).toContain("nothing of mine lands until you do");
      expect(said).toContain("unless you tick the box");
    });

    it("the job-codes claim is in the PAST tense, because that is when it was true", () => {
      // A three-way correction worth keeping straight, because I got it wrong twice:
      //
      //   ORIGINAL (false):  "builds your job codes" — present tense, implying the TOUR's trade
      //                      answer seeds them. saveSetup never touches job_codes.
      //   cn-v654 (true):    "what I use to offer you the right starter job codes" — accurate
      //                      system-wide but vague about when.
      //   NOW (precise):     "where your starter job codes CAME FROM" — the trade dropdown at
      //                      /onboarding maps through TRADE_PRESETS[trade].codes -> p_codes ->
      //                      create_organization (migration 0078), which inserts them at signup.
      //                      By the time anyone sees this tour step, that already happened.
      //
      // The audit's skeptic caught an over-correction here: a narrow grep of the settings manager
      // and saveSetup "proved" the claim false and nearly deleted a TRUE sentence. The wiring is
      // one screen earlier, at signup. Assert the true shape, forbid the original false one.
      //   cn-v718 (this):    past tense was never the safeguard — "it's where your starter job
      //                      codes came from" is past tense AND still attributes them to the
      //                      TRADE ANSWER, because "it" is "this is the answer that…". The August
      //                      truth pass caught it again. So the assertion is now about the SOURCE,
      //                      not the tense: any sentence that mentions job codes must name the
      //                      sign-up dropdown in the same breath.
      expect(said).not.toContain("builds your job codes");
      // Only an ORIGIN claim has to name the source. A sentence saying where job codes LIVE
      // ("your crew's scheduling and job codes, behind those sections") is navigation, and true.
      for (const sentence of said.split(/[.!?\n]/).filter((x) => x.includes("job codes") && ORIGIN_VERB.test(x)))
        expect(sentence, `claims an origin for job codes without naming it: "${sentence.trim()}"`)
          .toMatch(/sign-?up|dropdown/);
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

/**
 * THE CLAIMS THAT CAME BACK, AND THE ONES THAT CAN.
 *
 * A truth pass in June cut eleven false claims out of this onboarding, one of which — "builds your
 * job codes" — had already shipped. It came BACK, in a different sentence ("it's where your starter
 * job codes came from"), and survived until the August pass found it again. A finding that can
 * return in a paraphrase needs a test, not a memory.
 *
 * Each of these pins a claim to the code that would have to exist for it to be true. If somebody
 * BUILDS one of these for real, the test is the place to come and delete.
 */
describe("no claim in the onboarding promises something the code does not do", () => {
  const SPOKEN = [TOUR.map((s) => (typeof s.say === "function" ? s.say({} as never) : s.say)).join("\n"),
    SETUP_PLAYBOOK.needs.map((n) => `${n.ask} ${n.why ?? ""}`).join("\n")].join("\n");

  it("does not claim the job codes come from the trade ANSWER — they come from the sign-up dropdown", () => {
    // create_organization seeds job_codes from p_codes, the <Select name="trade"> on /onboarding
    // (onboarding/page.tsx → actions.ts p_codes → 0078_generic_org_seed.sql). saveSetup never
    // touches job_codes. This exact claim has now been written twice and cut twice.
    // Ban the false ATTRIBUTION, not the word. "Your job codes came from the dropdown at sign-up"
    // is the true sentence and has to survive; what must not is anything crediting them to this
    // answer, to Nort, or to the tour.
    expect(SPOKEN).not.toMatch(/(builds|build|sets up|seeds|creates)[^.]{0,40}(your |the )?(starter )?job codes/i);
    expect(SPOKEN).not.toMatch(/job codes[^.]{0,30}(came|come) from (this|that|it|your answer|what you)/i);
    for (const sentence of SPOKEN.split(/[.!?\n]/).filter((x) => /job codes/i.test(x) && ORIGIN_VERB.test(x)))
      expect(sentence, `claims an origin for job codes without naming it: "${sentence.trim()}"`)
        .toMatch(/sign-?up|dropdown/i);
  });

  it("does not promise to DERIVE one answer from another", () => {
    // hear.ts:41 forbids it in terms — "Never infer, never average, never compute" — and cn-v715
    // removed the last need that was gated on the promise.
    expect(SPOKEN).not.toMatch(/worked out from something you already said/i);
    expect(SPOKEN).not.toMatch(/I don'?t make you count it/i);
  });

  it("does not promise to RUN the arithmetic in a why line", () => {
    // Every reader of Need.why stores, displays, shape-checks or quotes it into a prompt. There is
    // no evaluator anywhere.
    expect(SPOKEN).not.toMatch(/times this equals that/i);
    expect(SPOKEN).not.toMatch(/do (that|the) (part|sum|math|maths|arithmetic) myself/i);
  });

  it("does not claim a hold question BLOCKS pricing", () => {
    // holdingNeeds (resolve.ts:95) has no caller and "Start the estimate" is an unguarded link.
    expect(SPOKEN).not.toMatch(/won'?t let you price/i);
    expect(SPOKEN).not.toMatch(/stopper/i);
  });

  it("does not claim the town drives the weather", () => {
    // This answer writes settings.public_city; the weather reads organizations.city, and nothing
    // syncs the two.
    expect(SPOKEN).not.toMatch(/weather on your day/i);
  });

  it("does not claim search covers everything you have typed", () => {
    // /api/search: five tables, names and numbers only, and leads are not among them.
    expect(SPOKEN).not.toMatch(/finds anything you'?ve ever typed/i);
  });

  it("does not describe the estimator appending its lines to the estimate", () => {
    // cn-v716: Generate proposes; nothing lands until the user ticks rows and presses Add.
    expect(SPOKEN).not.toMatch(/marked as measured/i);
  });
});
