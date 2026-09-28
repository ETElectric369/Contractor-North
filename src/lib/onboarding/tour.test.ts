import { describe, it, expect } from "vitest";
import { DOCK } from "@/lib/dock";
import { ALL_ON, type FeatureKey, type FeatureMap } from "@/lib/features";
import { LESSONS, TOUR, WHY_LINE_FEEDS_ESTIMATE, gateOn, lessonBlurb, lessonByKey, lessonOn, sayOf, stepWords, stepsOn, tourIndex, type TourCtx } from "./tour";
import { factsForEstimatorByProvenance } from "@/lib/playbook/answers";
import { WHY_SHAPES } from "@/lib/playbook/why";

/**
 * THE SPLIT (cn-v726): TOUR is now ONLY the setup — every step asks something saveSetup writes,
 * or closes the loop. The teaching became LESSONS, replayable from the cap and offered inline.
 * Content pins that used to scan TOUR scan ALL_STEPS; structure pins name the lesson they mean.
 */
const ALL_STEPS = [...TOUR, ...LESSONS.flatMap((l) => l.steps)];
const findStep = (key: string) => ALL_STEPS.find((s) => s.key === key)!;
import { SETUP_PLAYBOOK } from "./setup-playbook";
import { TRADE_WORDS } from "@/lib/org-trade";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Everything on but these switches. */
const off = (...keys: FeatureKey[]) => ({ ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) }) as FeatureMap;

/** A sentence that CLAIMS where something came from, as opposed to where it lives. */
const ORIGIN_VERB = /\b(came|come|comes|built|builds|build|seeded|seeds|created|creates|set up|sets up|made|makes)\b/i;

/** Somebody Nort has never met, and somebody he has. Lines that change must work for both. */
const STRANGER: TourCtx = { first: "", trade: "", city: "", rate: "", returning: false };
const KNOWN: TourCtx = { first: "Erik", trade: "electrical contractor", city: "Truckee", rate: "$145", returning: true };
const spoken = (c: TourCtx) => ALL_STEPS.map((s) => sayOf(s.say, c));

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
    // five text boxes, which teaches that the assistant is a garnish. His home is Search Or Ask now
    // (W1-09: Talk To Nort is its first row), so that is what the first step points at.
    expect(TOUR[0].anchor).toBe("ask");
    expect(TOUR[0].ask).toBeTruthy();
  });
});

describe("the why-line lesson is actually in here", () => {
  const said = spoken(STRANGER).join(" ").toLowerCase();

  it("says what a why line IS, shows one, and says how to write it", () => {
    // "i didnt even know what a why line really meant until you showed me" — the whole reason the
    // tour exists. A tour that skips this is the form it replaced.
    for (const key of ["why-what", "why-example", "why-how"]) expect(lessonByKey("why-lines")!.steps.map((s) => s.key)).toContain(key);
    expect(said).toContain("why line");
  });

  it("the example shows all three shapes as whole lines, in no trade's words", () => {
    // An abstract "explain your reasoning" teaches nothing, so each shape is a whole line. But it
    // was a deck builder's board count and an electrician's subpanel, shown to every trade, and
    // neither was even live. Erik: "Nort cant be giving examples that dont make sense like in the
    // tour." The shapes come from lib/playbook/why, so the lesson and the why box never drift.
    const ex = sayOf(findStep("why-example").say, STRANGER);
    for (const s of WHY_SHAPES) expect(ex).toContain(s.example);
    expect(ex).not.toMatch(/board count|joist|subpanel|home runs?|panel|breaker|outlet|deck builder|electrician/i);
  });

  it("and it promises the draft that comes next, so the hand-off isn't a surprise", () => {
    expect(sayOf(findStep("why-how").say, STRANGER).toLowerCase()).toContain("draft");
  });
});

describe("it points at things that exist", () => {
  // Anchors the SHELL carries, so they're reachable from any route (topbar.tsx, dock.tsx,
  // account-menu.tsx). `ask` is Search Or Ask (W1-09: it replaced Nort's button, the search button
  // and the graduation cap, so `nort`, `search` and `setup` are gone). `settings-link` is the
  // Settings item INSIDE the account menu — it is not on the settings page, it is the door to it,
  // which is the whole point. `account-menu` is the PANEL behind the initials — in the shell,
  // reachable from any route, and only in the DOM while the menu is open, which is why its step
  // carries `opens`.
  const SHELL = ["ask", "quickadd", "bell", "account", "dock", "account-menu"];
  // dock-<sectionKey> is set per section by dock.tsx, on BOTH the desktop rail and the mobile bar.
  const isDockSection = (a: string) => DOCK.some((d) => a === `dock-${d.key}`);
  // Anchors that only exist once you are standing on /settings.
  const settingsOnly = (a: string) => a === "sections-settings" || (a.startsWith("settings-") && a !== "settings-link");

  it("every anchor is one the app sets — the tour's and every lesson's", () => {
    for (const s of ALL_STEPS) {
      if (!s.anchor || settingsOnly(s.anchor) || isDockSection(s.anchor)) continue;
      expect(SHELL, `${s.key} points at ${s.anchor}`).toContain(s.anchor);
    }
  });

  it("the shell really carries those anchors (topbar.tsx, account-menu.tsx, dock.tsx)", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const bar = read("src/components/app-shell/topbar.tsx");
    for (const a of ["ask", "quickadd", "bell", "account"]) expect(bar, a).toContain(`data-tour="${a}"`);
    expect(read("src/components/account-menu.tsx")).toContain('data-tour="account-menu"');
    expect(read("src/components/app-shell/dock.tsx")).toContain('data-tour="dock"');
    // The dock tiles a step points at are tiles (not behind the initials).
    for (const s of ALL_STEPS) {
      if (s.anchor && isDockSection(s.anchor)) expect(DOCK.find((d) => `dock-${d.key}` === s.anchor)?.inMenu, s.key).toBeFalsy();
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
    const door = findStep("settings-door");
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

  it("the initials beat and the door are ONE step now, and it still says everything both did", () => {
    // History of this pair, because it has moved twice and each move had a reason:
    //   v1: one `account` step that listed sign-out, language and the QR code and never said the
    //       word "Settings" — which is where Settings lives. Split into two.
    //   v2: `account` (here are your initials) + `settings-door` (opened, and Settings named) —
    //       the adjacency this test used to pin.
    //   v3 (now): merged back into settings-door alone, when the service_area ask bought its
    //       place under the 24-step ceiling. Safe THIS time because the driver's `opens` does the
    //       reveal the teaser step existed for — v1's failure was missing WORDS, not a missing
    //       step. So the assertion is on the words: one step must locate the initials, open the
    //       menu, and name Settings.
    const door = findStep("settings-door");
    expect(ALL_STEPS.find((s) => s.key === "account")).toBeUndefined();
    expect(door.anchor).toBe("account-menu");
    expect(door.opens).toBe("account");
    const said = sayOf(door.say, STRANGER).toLowerCase();
    expect(said).toContain("initials");
    expect(said).toContain("settings");
    expect(said).toContain("qr code");
  });

  it("the things Erik named by hand are all covered", () => {
    // "where the button is for nort … how does the nav work and where are the settings and my qr
    // code and all the things"
    const anchored = ALL_STEPS.map((s) => s.anchor);
    // "account-menu" since the merge — the initials are still pointed at, as the opened panel.
    // "ask" since W1-09 — Nort's button is Search Or Ask.
    for (const a of ["ask", "dock", "account-menu"]) expect(anchored).toContain(a);
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

  it("A TRADE PICKED AT SIGN-UP IS NEVER ASKED AGAIN, and the starters are described as they are", () => {
    // Sign-up keeps the trade key (0352); the layout hands its words in through lib/org-trade.
    const trade = TOUR.find((s) => s.key === "trade")!;
    const known = sayOf(trade.say, { ...STRANGER, trade: "plumber" });
    expect(known).toContain("plumber");
    expect(known.toLowerCase()).not.toContain("what trade are you in");
    const cold = sayOf(trade.say, STRANGER).toLowerCase();
    expect(cold).toContain("what trade are you in");
    // There are three trade starters and a general set (STARTER_FOR_TRADE), not "four", and a
    // "first trade word" doesn't pick anything when sign-up already did.
    for (const t of [known.toLowerCase(), cold]) {
      expect(t).not.toContain("four starter");
      expect(t).not.toContain("first trade word");
    }
    expect(cold).toMatch(/electrical, deck and plumbing/);
  });

  it("THE TRADE READS AS A SENTENCE whatever words it is: never 'I've got you as painter'", () => {
    // The key's own words need an article ("painter"), a company's own may not take one
    // ("Construction"), so the line says "your trade" and the words follow it.
    const trade = TOUR.find((s) => s.key === "trade")!;
    for (const words of [...Object.values(TRADE_WORDS), "Construction"]) {
      const ctx = { ...KNOWN, trade: words };
      const lines = [sayOf(trade.say, ctx), sayOf(TOUR[0].say, ctx)];
      for (const t of lines) {
        expect(t).toContain(`your trade`);
        expect(t).toContain(words);
        expect(t).not.toContain(`got you as ${words}`);
        expect(t).not.toContain(`, ${words} out of`);
      }
    }
    expect(sayOf(TOUR[0].say, { ...KNOWN, trade: "painter" })).toContain("I've already got you as Erik out of Truckee, and your trade as painter.");
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

    it("walks the pipeline in the order the work happens — inside its LESSON now", () => {
      const steps = lessonByKey("how-a-job-runs")!.steps;
      const order = ["run-lead", "run-walk", "run-estimate", "run-job", "run-money", "run-win"];
      const at = order.map((k) => steps.findIndex((s) => s.key === k));
      expect(at.every((i) => i >= 0), "a run step went missing").toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    });

    it("points at the dock tile it is talking about", () => {
      expect(findStep("run-lead").anchor).toBe("dock-sales");
      expect(findStep("run-job").anchor).toBe("dock-jobs");
      // The Money section's key really is `invoices` (dock.ts) even though its label is "Money".
      expect(findStep("run-money").anchor).toBe("dock-invoices");
    });

    it("names the job's clock by the words on it: Clock In at the top, never TIME (W1-20)", () => {
      // TIME is the dock slot's name in code and a hover title a phone never shows; the only "Time"
      // a person can see on a job is the tab, which no longer clocks anyone in.
      const s = findStep("run-job");
      for (const c of [STRANGER, KNOWN])
        for (const say of [s.say, s.plain!.say]) {
          const line = sayOf(say, c);
          expect(line).toContain("tap Clock In at the top of the job");
          expect(line).not.toMatch(/\bTIME\b|Time tab/);
        }
      const button = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-time-button.tsx"), "utf8");
      expect(button).toContain('{state === "in" && "Clock In"}');
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
    // "why-how" left the TOUR in the cn-v726 split; resuming its key now correctly falls back to
    // the start rather than landing mid-list of a different script — which is exactly why the
    // driver keys its resume storage PER SCRIPT (cn.tour.step vs cn.lesson.<key>).
    expect(tourIndex("rate")).toBe(TOUR.findIndex((s) => s.key === "rate"));
    expect(tourIndex("why-how")).toBe(0);
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

  it("says the estimate reads why lines ONLY when the estimator really does", () => {
    // "when I write the estimate, your why line is what tells me where that answer lands" was
    // false: Start The Estimate hands the estimator "label: answer" and nothing else. The switch is
    // held to the estimator's own output, so making it read why lines fails here until the lesson
    // is flipped with it.
    const why = "Sets the trip count, which is the labor line.";
    const pb = { needs: [{ key: "trips", label: "Trips", ask: "How many trips?", slot: { type: "number" as const }, why }] };
    const facts = factsForEstimatorByProvenance(pb, { trips: 2 }, new Set()).hand;
    expect(facts).toContain("Trips");
    expect(facts.includes(why)).toBe(WHY_LINE_FEEDS_ESTIMATE);

    const uses = findStep("why-uses");
    const on = sayOf(stepWords(uses, true).say, STRANGER).toLowerCase();
    const off = sayOf(stepWords(uses, false).say, STRANGER).toLowerCase();
    for (const t of [on, off]) {
      if (!WHY_LINE_FEEDS_ESTIMATE) {
        expect(t).not.toMatch(/write the estimate, your why line|estimate gets written, your why line/);
        // What IS true today: the walk-through fill reads it, and it shows under the question.
        expect(t).toContain("walk-through");
        expect(t).toContain("under the question");
      }
    }
    // Either way, it still never claims to run the sum.
    expect(on).toContain("i don't run the sum");
    expect(off).toContain("nothing runs the sum");
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

/**
 * NORT SWITCHED OFF (0352, rule k): the Lessons still run from the cap and the Playbook strip, but
 * nobody is speaking as Nort. Neutral words when off, the same words when on.
 */
describe("with Nort off, a lesson speaks as nobody", () => {
  const AS_NORT = /\bI\b|\bI['’]|\bme\b|\bmy\b|\bmine\b|\bNort\b/;

  it("no lesson title, line or blurb says 'I' or names Nort", () => {
    for (const l of LESSONS) {
      expect(lessonBlurb(l, false), l.key).not.toMatch(AS_NORT);
      for (const s of l.steps) {
        const w = stepWords(s, false);
        expect(w.title, s.key).not.toMatch(AS_NORT);
        for (const c of [STRANGER, KNOWN]) expect(sayOf(w.say, c), s.key).not.toMatch(AS_NORT);
      }
    }
  });

  it("with Nort on, every lesson reads exactly as it did", () => {
    for (const l of LESSONS) {
      expect(lessonBlurb(l, true)).toBe(l.blurb);
      for (const s of l.steps) expect(stepWords(s, true)).toEqual({ title: s.title, say: s.say });
    }
  });

  it("the neutral words keep the promises the Nort words make", () => {
    const off = LESSONS.flatMap((l) => l.steps).map((s) => sayOf(stepWords(s, false).say, STRANGER)).join(" ").toLowerCase();
    expect(off).toContain("tick the ones you want");
    expect(off).toContain("nothing lands until you do");
    expect(off).toContain("unless you tick the box");
    expect(off).toContain("you send it");
    // With Nort off, the walk-through's say-it button is "Just Say It" (tell-nort.tsx).
    expect(off).toContain("just say it");
  });
});

/**
 * THE TOUR READS THE SWITCHES (W1-09). A gated step whose switch is off is skipped, Show Me How
 * lists only lessons whose gate is on, and the settings door names what the avatar menu holds for
 * THIS company — the estimate QR only with Leads on, Tools only with Calculators on.
 */
describe("the tour reads the switches", () => {
  const keys = (steps: { key: string }[]) => steps.map((s) => s.key);
  const run = lessonByKey("how-a-job-runs")!.steps;

  it("a gate is one switch, or several meaning any of them; no gate is always on", () => {
    expect(gateOn(undefined, off("leads"))).toBe(true);
    expect(gateOn("leads", off("leads"))).toBe(false);
    expect(gateOn(["leads", "estimates"], off("leads"))).toBe(true);
    expect(gateOn(["leads", "estimates"], off("leads", "estimates"))).toBe(false);
    // No switches stored: everything on, as before the switches.
    expect(gateOn("leads", undefined)).toBe(true);
  });

  it("Leads off: no run-lead, no run-walk and no trust step (welded to the walk-through)", () => {
    const k = keys(stepsOn(run, off("leads")));
    for (const gone of ["run-lead", "run-walk", "trust"]) expect(k).not.toContain(gone);
    expect(k).toEqual(["run-estimate", "run-job", "run-money", "run-win"]);
  });

  /** Every word a company with these switches reads in How a Job Runs: blurb, titles, lines, Nort on and off. */
  const runWords = (features: FeatureMap) => {
    const lesson = lessonByKey("how-a-job-runs")!;
    const out: string[] = [];
    for (const nortOn of [true, false]) {
      out.push(lessonBlurb(lesson, nortOn));
      for (const s of stepsOn(lesson.steps, features)) {
        const w = stepWords(s, nortOn);
        for (const c of [STRANGER, KNOWN]) out.push(`${w.title} ${sayOf(w.say, { ...c, features })}`);
      }
    }
    return out.join("\n");
  };

  it("Leads and Estimates both off: the run that's left names no lead, no walk-through and no estimate", () => {
    const words = runWords(off("leads", "estimates"));
    expect(words).not.toMatch(/estimate accepted/i);
    expect(words).not.toMatch(/\blead\b/i);
    expect(words).not.toMatch(/walk-through/i);
    expect(words).not.toMatch(/estimate/i);
    // It says where their job starts instead, and where the address was first typed.
    expect(words).toContain("tap Plus, then New Job");
    expect(words).toContain("You typed that address once, on the job,");
  });

  it("Leads off alone: no lead and no walk-through in what's left; the estimate starts under Plus", () => {
    const words = runWords(off("leads"));
    expect(words).not.toMatch(/\blead\b/i);
    expect(words).not.toMatch(/walk-through/i);
    expect(words).not.toContain("Start The Estimate");
    expect(words).toContain("tap Plus, then New Estimate");
    expect(words).toContain("You mark the estimate accepted and the job builds itself — same customer, same site address, plus a work order");
    expect(words).toContain("You typed that address once, on the estimate,");
  });

  it("Estimates off alone: no estimate to accept or to be the bill; the lead and walk-through still read", () => {
    const words = runWords(off("estimates"));
    expect(words).not.toMatch(/estimate/i);
    expect(words).toContain("tap Plus, then New Job");
    expect(words).toContain("Press Finish Job and the invoice is already written — every person's hours at the right rate plus every receipt");
    expect(words).toContain("You typed that address once, on the phone call,");
  });

  it("everything on: the run's words are the ones it always had", () => {
    const words = runWords(ALL_ON);
    expect(words).toContain("the lead it came from, plus a work order and a material list off the estimate");
    expect(words).toContain("You typed that address once, on the phone call, and it was still with you at the invoice");
    expect(words).toContain("same with the numbers off the walk-through and the hours off the clock. So you're not typing it four times");
    expect(words).toContain("if there's an accepted estimate, that estimate IS the bill");
    expect(words).toContain("Back in the truck you press Start The Estimate");
  });

  it("Estimates off: no run-estimate; everything on: the whole run, as before", () => {
    expect(keys(stepsOn(run, off("estimates")))).not.toContain("run-estimate");
    expect(keys(stepsOn(run, ALL_ON))).toEqual(keys(run));
    expect(keys(stepsOn(run, undefined))).toEqual(keys(run));
  });

  it("the why-lines lesson and the playbook step belong to Leads or Estimates", () => {
    const why = lessonByKey("why-lines")!;
    expect(lessonOn(why, off("leads"))).toBe(true);
    expect(lessonOn(why, off("estimates"))).toBe(true);
    expect(lessonOn(why, off("leads", "estimates"))).toBe(false);
    expect(keys(stepsOn(why.steps, off("leads", "estimates")))).not.toContain("playbook-tab");
    // The setup tour itself carries no gate: every step runs for every company.
    expect(stepsOn(TOUR, off("leads", "estimates", "calculators"))).toHaveLength(TOUR.length);
  });

  it("the settings door names THIS company's menu: the QR only with Leads on, Tools only with Calculators on", () => {
    const door = findStep("settings-door");
    for (const nortOn of [true, false]) {
      const line = (features?: FeatureMap) => sayOf(stepWords(door, nortOn).say, { ...STRANGER, features }).toLowerCase();
      expect(line(undefined)).toContain("your estimate qr code for the truck");
      expect(line(undefined)).toContain(", office, tools");
      expect(line(off("leads"))).not.toContain("qr code");
      expect(line(off("leads"))).toContain("sign out, your language, office");
      expect(line(off("calculators"))).not.toContain("tools");
      expect(line(undefined)).toContain("settings");
    }
    // With Nort off (the plain words) Help is in that menu too.
    expect(sayOf(stepWords(door, false).say, STRANGER)).toContain(", Help —");
    expect(sayOf(stepWords(door, true).say, STRANGER)).not.toContain("Help");
  });

  it("the settings step says where your people are: Office, behind your initials", () => {
    expect(sayOf(findStep("settings").say, STRANGER)).toContain("(Your people have their own page: Office, behind your initials.)");
  });

  it("the top bar step: Plus starts new work, Search Or Ask finds and asks, the bell keeps your notices", () => {
    const bar = findStep("topbar");
    const on = sayOf(stepWords(bar, true).say, STRANGER);
    const plainWords = sayOf(stepWords(bar, false).say, STRANGER);
    // The + holds Snap Or Note first (W1-30), so the sentence names a paper to snap too (W1-32 words).
    expect(on).toContain("Plus is where new work starts — a job, an appointment, an invoice, or a paper to snap — from any screen.");
    expect(on).toContain("Search Or Ask finds your jobs, customers, estimates, invoices and appointments by name or number, and you can ask me anything there.");
    expect(on).toContain("And the bell keeps your notices, whether or not you switch on phone notifications.");
    expect(plainWords).toContain("Search finds your jobs");
    expect(plainWords).not.toMatch(/ask me|Search Or Ask/);
    // Plus names no customer and no task (those rows leave it this release), and the magnifying
    // glass and "what's waiting on you" (that's Needs You) are gone from the bell's line.
    for (const t of [on, plainWords]) expect(t).not.toMatch(/a customer|a task|magnifying glass|waiting on you/);
  });

  it("the done step points at Search Or Ask and names the rows that are really in it", () => {
    const done = findStep("done");
    expect(done.anchor).toBe("ask");
    const said = sayOf(done.say, STRANGER);
    expect(said).toContain("Tap Search Or Ask any time");
    expect(said).toContain("Take The Setup Again replays this");
    expect(said).toContain("Show Me How");
    // Show Me How holds the lessons, not the setup: the line must not claim it replays this.
    expect(said).not.toContain("Show Me How replays");
  });

  it("no line anywhere still names the graduation cap, a cap button or the magnifying glass", () => {
    for (const c of [STRANGER, KNOWN]) {
      for (const s of ALL_STEPS) {
        for (const nortOn of [true, false]) {
          const t = sayOf(stepWords(s, nortOn).say, c).toLowerCase();
          expect(t, s.key).not.toMatch(/\bcap\b|graduation|magnifying/);
        }
      }
    }
    for (const l of LESSONS) for (const nortOn of [true, false]) expect(lessonBlurb(l, nortOn)).not.toMatch(/\bcap\b/);
  });

  it("the lessons are rows under Show Me How now, so their titles are Title Case", () => {
    expect(LESSONS.map((l) => l.title)).toEqual(["Why Lines", "Getting Around", "How a Job Runs"]);
  });
});
