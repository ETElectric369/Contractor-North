/**
 * THE GUIDED TOUR — Nort walks you round the app, out loud, pointing at real buttons.
 *
 * Erik, rejecting the version I built first:
 *
 *   "what i have in mind does incorporate a bit of tutorialing … interactive with Nort walking me
 *    through the whole site and where the button is for nort with an arrow and nort asking
 *    questions and pointing things out … then i answer verbally and we start talking through
 *    setup, not just a sheet in front of me with a fill in the holes nort button, a real
 *    conversation because people need to know how Nort works first and foremost … he explains why
 *    we need why lines, how they work and how to write them because nobody is going to figure this
 *    shit out without holding their hand through it and we both know that, i didnt even know what
 *    a why line really meant until you showed me."
 *
 * That last clause is the whole brief. The person who COMMISSIONED the why line did not know what
 * one was until he read a draft of his own. A form asking somebody to write one is not onboarding,
 * it is a quiz on material nobody taught.
 *
 * ── FOUR RULES THIS SCRIPT OBEYS ────────────────────────────────────────────────────────────
 *
 * NORT FIRST. Step one is the Talk button and step one is a QUESTION he answers out loud, because
 * every other thing in this app is easier once you know the assistant is real and listening. The
 * old version put five text boxes first, which teaches that Nort is a garnish.
 *
 * POINT AT THE REAL THING. Every step names a live element by `data-tour`, so the arrow lands on
 * the button he will actually press tomorrow — not a screenshot, not a diagram. A step whose
 * anchor is missing (wrong route, wrong role, narrow screen) degrades to a centred card rather
 * than pointing at nothing.
 *
 * ANSWERING IS OPTIONAL, ALWAYS. `ask` names a need from SETUP_PLAYBOOK; saying it fills the box.
 * Skipping it moves on. Nothing here is a gate — same law as the interview and the inspector.
 *
 * IT IS DATA, NOT A COMPONENT. Same reason the playbook is: the tour changes constantly as the app
 * does, and a wall of JSX with the copy baked into it is a wall nobody edits.
 */

/**
 * WHO NORT IS TALKING TO. A tour that introduces itself to somebody it already knows is a form
 * wearing a friendly voice.
 *
 * Erik: "i think there should be an element of nort beginning to get to know you a person and
 * recognize your name if youve already input it and proceed conversing without this wall inbetween
 * questions."
 *
 * He is right, and the reason it matters is his own: "a lot of contractors are not smart and thats
 * why we are doing what we are doing to make it simple for everyone." Somebody who is not sure they
 * belong in a piece of software reads "tell me your name" — from a thing that plainly has their
 * name on the screen behind it — as proof it is not really listening. Being recognised is what
 * makes it safe to talk to.
 */
export interface TourCtx {
  /** First name, or "" — Nort uses it the way a person would: sometimes, not every sentence. */
  first: string;
  trade: string;
  city: string;
  /** Their hourly rate, already formatted, or "" — so a line can say it back to them. */
  rate: string;
  /** They have finished the tour before; this is a revisit, not an introduction. */
  returning: boolean;
}

/** A line, or a line that knows who it is talking to. */
export type Line = string | ((c: TourCtx) => string);

export const sayOf = (l: Line, c: TourCtx): string => (typeof l === "function" ? l(c) : l);

export interface TourStep {
  key: string;
  /** `data-tour` value of the element to spotlight. Absent = a centred card with no arrow. */
  anchor?: string;
  /** Get to this route before showing the step. */
  route?: string;
  /** The heading on the card. Short. */
  title: string;
  /** WHAT NORT SAYS — spoken aloud and shown as text. Write it to be heard, not read.
   *  A function when it should change for somebody he already knows. */
  say: Line;
  /** A SETUP_PLAYBOOK key this step is trying to learn. Answering by voice or typing fills it. */
  ask?: string;
  /** Label for the advance button when "Next" is too bland. */
  next?: string;
  /**
   * NORT OPENS IT HIMSELF. A menu that has to be open before its contents can be pointed at.
   *
   * Erik: "doesnt not even show the initals drop down menu and i dont want it waiting for me to
   * click anything."
   *
   * Both halves of that were my mistakes. The first version made him tap his own initials and
   * waited — which is a tour stopping to give homework, and he was right to reject it. The second
   * was worse and it was a reasoning error: I assumed the dimmer's box-shadow hole would let the
   * opened menu show through. It does not. The menu is z-90 and the tour overlay is z-200, so the
   * panel sat under 72% black and read as "nothing happened".
   *
   * So the tour drives: it opens the menu on entering the step, points at the WHOLE PANEL (which
   * is what puts it inside the hole and therefore visible at all), and closes it on the way out.
   * Nothing waits for a hand.
   */
  opens?: "account";
}

/**
 * ── THE SPLIT (cn-v726). Erik: "the onboarding is one thing but maybe it should just be
 * onboarding and something else better for training can come after."
 *
 * The 24-step tour was two things wearing one coat: six steps that SET UP (they ask and write)
 * and eighteen that TEACH. Interleaved, a contractor who just wanted to start had to sit through
 * the why-line lecture to reach the tone dial at step 23 — and the teaching drifted, because a
 * step that describes a screen from three steps away goes stale silently.
 *
 * So: TOUR is now ONLY the setup — every step either asks something saveSetup writes, or closes
 * the loop (recap, tone, done). The teaching became LESSONS: named, self-contained, offered ONCE
 * on the surface each explains (the why-lines lesson at the playbook editor — the one thing
 * "nobody is going to figure out without holding their hand"), and replayable forever from the
 * cap. A lesson that lives next to the button it describes goes stale LOUDLY, which is the whole
 * point of the move.
 */
export const TOUR: TourStep[] = [
  // ── 1. MEET NORT. A question, out loud, before anything else. ───────────────────────────────
  {
    key: "hello",
    anchor: "nort",
    route: "/planner",
    title: "This is Nort",
    // "Press Talk" has to say WHICH Talk — the lit-up button behind the card is the real Nort and
    // the overlay deliberately doesn't take clicks mid-step, so pointing at it without saying
    // "down here" sends people tapping a button that can't respond.
    say: (c) =>
      c.first
        ? `Hey ${c.first} — I'm Nort. That button up there is me, and I'm on every screen in here. ` +
          `I've already got you as ${c.first}${c.trade ? `, ${c.trade}` : ""}${c.city ? ` out of ${c.city}` : ""}. ` +
          `Press the Talk button down here and say hello, just so you can hear how this works. ` +
          `Say a different name and I'll take that instead.`
        : "Hi — I'm Nort. That button up there is me, and I'm on every screen in here. " +
          "Press the Talk button down here and tell me your name and what you do, the way you'd tell " +
          "a person. Type it instead if you'd rather — I'm not fussy.",
    ask: "full_name",
  },
  {
    key: "trade",
    anchor: "nort",
    title: "What you do",
    say: (c) =>
      (c.trade ? `Right — I've got you as ${c.trade}. ` : "Good to meet you. ") +
      "Now the one that matters most — what trade are you in? " +
      "Say the one word that fits best — there are four starter walk-throughs, electrical, deck, " +
      "plumbing and a general one, and the first trade word I spot picks it. " +
      "This builds the questions I'll ask you on site, and tells the estimator what trade it's " +
      "pricing. Your job codes came from the dropdown at sign-up; change those under Settings.",
    ask: "trade",
  },
  {
    key: "where",
    anchor: "nort",
    title: "Where you work",
    say: (c) =>
      (c.city ? `And you're out of ${c.city}. ` : "") +
      "Where are you working out of? " +
      "That's what customers see when they look you up.",
    ask: "city",
  },
  {
    key: "reach",
    anchor: "nort",
    title: "How far you go",
    say: (c) =>
      (c.city ? `And from ${c.city} — ` : "And ") +
      "how far out do you go? Not a radius — the places you'd actually drive to. " +
      "It's what your public page says you cover.",
    // THE QUESTION NOBODY ASKED. service_area has been a declared setup need since the interview
    // was written — saveSetup writes it, the public page reads it — and no tour step ever carried
    // it, so for anyone who set up by tour it has been null forever. Erik: "service area is a good
    // catch, do what you need to do to fold that in."
    ask: "service_area",
  },
  {
    key: "rate",
    anchor: "nort",
    title: "What you charge",
    say:
      "Last one about the business — what do you charge an hour? " +
      "It's a starting point an estimate uses so you're not doing the maths; " +
      "you change it per job and per customer whenever you like.",
    ask: "labor_rate",
  },
  // ── 1b. THE HANDSHAKE. Both directions, out loud. ──────────────────────────────────────────
  //
  // Erik: "Nort gets to know me and i get to know Nort, what he can and where everything i need to
  // use is located and how … Nort needs me to know he exists and for me to know that he knows that
  // i know he knows, know what i mean?"
  //
  // Yes. Every question so far has been NORT learning HIM. Nothing yet has closed the loop the
  // other way, and a loop that only runs one way is a form. So he stops, says back everything he
  // now holds — in the person's own terms, so a wrong one is obvious and fixable — and then says
  // what he is FOR. That is the moment the two of them are working off the same picture, and
  // everything after it lands differently because of it.
  {
    key: "recap",
    anchor: "nort",
    title: "So — here's you, and here's me",
    say: (c) => {
      const bits = [c.first, c.trade, c.city ? `out of ${c.city}` : "", c.rate ? `at ${c.rate} an hour` : ""]
        .filter(Boolean)
        .join(", ");
      return (
        (bits ? `Right. I've got you as ${bits}. If any of that's wrong, go back a step and say it again — ` : "Right. ") +
        "everything I know about you is something you told me, and you can change all of it later.\n\n" +
        "Now my half. I'm on every screen, and I'm most useful on a job: press Talk, say the whole " +
        "job the way you'd say it to a person, and I'll fill in the questions from what you said. " +
        "I write your estimates, I look things up, and I'll tell you when I'm not sure. " +
        "What I won't do is make a number up — if you didn't say it, I ask."
      );
    },
  },
  // THE ONLY SETTING WHOSE WHOLE POINT IS THAT SOMEBODY KNOWS IT'S THERE, and it's three levels
  // down. Erik asked for it with a wink. Stating the two limits out loud is what makes the dial
  // safe to turn up — and it agrees with what the settings screen already says rather than
  // contradicting it. Per person, because `register` lives on profiles (0183), not the org.
  {
    key: "tone",
    route: "/settings?tab=you",
    anchor: "settings-you",
    title: "One more, under You",
    say:
      "Last one, and it's per person, so you and whoever's in the office don't have to agree. " +
      "There's a dial in here for how funny I am and a switch for language, so when you're swearing " +
      "at a seized breaker I'm not answering you like a call centre. I match you and I never go " +
      "first — if you don't swear, you'll never hear it out of me. And none of it ever reaches a " +
      "customer: estimates, invoices, anything a homeowner reads stays clean wherever that dial sits.",
  },
  {
    key: "done",
    route: "/planner",
    anchor: "setup",
    title: "That's it",
    say:
      "That's the whole thing. This cap button is where I live — take this again any time, " +
      "or come back to change what you told me. Let's get you a job in here.",
    next: "Done",
  },
];

export interface Lesson {
  key: string;
  /** The menu label on the cap, and the offer strip's name for itself. */
  title: string;
  /** One sentence: what you'll know after. Shown on the cap menu and the offer strip. */
  blurb: string;
  steps: TourStep[];
}

export const LESSONS: Lesson[] = [
  {
    key: "why-lines",
    title: "Why lines",
    blurb: "What a why line is, two real ones, how to write yours — the part nobody guesses.",
    steps: [
  // ── 2. THE WHY LINE. The part nobody figures out unaided. ──────────────────────────────────
  {
    key: "why-what",
    title: "Now the part nobody guesses",
    say:
      "Here's the thing that makes this different from every other app you've tried. " +
      "When you walk a job, I ask you questions — and every question has a WHY LINE attached. " +
      "One line, in your words, saying WHERE THAT ANSWER ENDS UP IN YOUR PRICE. " +
      "Not why it matters. Where it lands.",
  },
  {
    key: "why-example",
    title: "Two real ones",
    say:
      "A deck builder asks length and width. His why line: 'Length times width is the square " +
      "footage, and that drives the board count and the joists.' That's it. That's the whole line. " +
      "You can follow it from the answer to the number.\n\n" +
      "An electrician asks about the panel. His: 'Decides subpanel or home runs — which sets every " +
      "run length after it.' Same shape. The answer goes somewhere specific.",
  },
  {
    key: "why-how",
    title: "How to write yours",
    say:
      "So don't explain the question. Finish this sentence: this answer gets... multiplied by " +
      "something, or it decides something, or it turns something on. One of those three, every time.\n\n" +
      "If you can't say where it lands, that's worth knowing too — it might be a question you don't " +
      "actually need. And you're not starting from a blank box: I'll draft every one from what you " +
      "just told me, and you tell me where I've got it wrong. Arguing beats writing.",
  },
  {
    key: "why-uses",
    title: "And why I need them",
    say:
      "Two reasons. If you already told me something, I don't ask you twice — that one I really do. " +
      "And when I write the estimate, your why line is what tells me where that answer lands in the " +
      "price. It's for reading, mine and yours. I don't run the sum in it, and I never work out a " +
      "number you didn't give me.",
  },
  {
    key: "playbook-tab",
    route: "/settings?tab=playbook",
    anchor: "settings-playbook",
    title: "And this is your Playbook",
    say:
      "That's the one to remember in here. Every question I'll ask you on a job is in this tab, " +
      "with its why line, and you can rewrite, reorder or delete any of them whenever your mind " +
      "changes. This is yours, not mine — I just do what it says.",
  },
    ],
  },
  {
    key: "getting-around",
    title: "Getting around",
    blurb: "The dock, the top bar, and the one door worth remembering — Settings, behind your initials.",
    steps: [
  // ── 3. THE ROOM. Where everything is. ──────────────────────────────────────────────────────
  {
    key: "dock",
    anchor: "dock",
    title: "Getting around",
    say:
      "That's the nav. Everything lives behind one of those — your day, your jobs, your money, " +
      "your schedule. You'll never have to go more than one level deep to find a thing.",
  },
  {
    key: "topbar",
    anchor: "quickadd",
    title: "Plus, search, bell",
    say:
      "Three in this corner. Plus makes anything new — a job, a customer, an estimate, a task — " +
      "from any screen. The magnifying glass finds your jobs, customers, estimates, invoices and " +
      "appointments by name or number. " +
      "And the bell is what's waiting on you, whether or not you switch on phone notifications.",
  },
  // THE DOOR, NOT THE ROOM. Erik: "ive been asked multiple times where settings is located and in
  // the tour it shows it open but not where the button is." The old step navigated straight to
  // /settings and talked about the page, which teaches the room and never the door.
  //
  // The whole PANEL is the anchor, not the Settings row inside it. That is not a stylistic call:
  // the hole in the dimmer is the only place anything is visible, so anchoring on the row would
  // leave the rest of the menu under 72% black — which is exactly what he saw and reported as the
  // menu not showing at all.
  {
    key: "settings-door",
    anchor: "account-menu",
    opens: "account",
    title: "There it is — Settings",
    // ABSORBED the old "account" teaser step (its whole script was "that's your corner — watch,
    // I'll open it"), when the service_area ask bought its place under the 24-step ceiling. The
    // driver opens the menu on entry (`opens`), so the reveal happens either way; the teaser was
    // paying a step for a beat of suspense.
    say: (c) =>
      `Your initials, top right${c.first ? `, ${c.first}` : ""} — that's your corner, on every ` +
      "single screen, and I've opened it. Sign out, your language, your estimate QR code for the " +
      "truck — and Settings, right there in the middle. That's the door. " +
      "That's the one thing worth remembering.",
  },
  {
    key: "settings",
    route: "/settings",
    anchor: "sections-settings",
    title: "The whole business, one page",
    say:
      "And this is it. Money and tax, your crew's scheduling and job codes, your website, the " +
      "connections to Google and the rest — all behind those sections. (Your people have their own " +
      "page, under Office.) You don't have to remember any of it. " +
      "You only have to remember your initials.",
  },
    ],
  },
  {
    key: "how-a-job-runs",
    title: "How a job runs",
    blurb: "Phone call to paid — lead, walk-through, estimate, job, money — and what Nort does at each step.",
    steps: [
  // ── 4. THE RUN. One job, phone call to money, pointing at the tile each time. ───────────────
  //
  // Erik: "the tour should point out the process starting with leads all the way through also
  // explaining how the AI works for you through all the steps and feeds all the data … heres how
  // you win (time, effort, thought conservation allowing focus, peace of mind)."
  //
  // Everything above taught him NORT. Nothing yet taught him THE SHAPE OF THE WORK, and a
  // contractor who doesn't know Leads feeds Inspections feeds Estimates will use this as six
  // unrelated apps and type the same address into all of them. Chronology is the teaching device:
  // it is the order his day already happens in, so there is nothing new to memorise.
  //
  // EVERY LINE IN HERE WAS TRUTH-CHECKED AGAINST THE CODE, and eleven claims were cut for being
  // false — including "they book themselves" (the app builds an sms: link, HE presses send),
  // "the hours land on their own" (he picks the job at clock-in), and the 70-80% figure itself,
  // which is honest at the walk-through fill and near zero at getting a lead in. What replaced it
  // is the version true at every stage: a fact typed once rides all the way through. A man who
  // thinks his estimate priced itself is a man who sends one without reading it.
  {
    key: "run-lead",
    anchor: "dock-sales",
    title: "It starts with a phone call",
    say:
      "Let's walk one job the whole way. Work runs one direction through here — Sales, then Jobs, " +
      "then Money — and it starts under Sales, on Leads, where a phone number on its own is enough " +
      "to save one. Turn that lead into a site visit and the address and what they told you ride " +
      "over with it. Offer them three times instead of playing phone tag — I write the text, you " +
      "send it, and whichever one they tap books itself onto your schedule.",
  },
  {
    key: "run-walk",
    title: "Then you're stood in the yard",
    say:
      "Day of, you're on site with your phone. Open the walk-through, press Talk, and say the whole " +
      "job in one breath the way you'd say it to a person. I put what you said into the right boxes " +
      "and only ask about what's left over.",
  },
  // The honest half of that same moment, and it stays welded to it: it carries the only concrete
  // example in the whole tour ("two outlets on each of three walls").
  {
    key: "trust",
    title: "One thing to know about me",
    say:
      "And a promise, because it's your money. I only fill in what you actually said. " +
      "I won't work out a measurement you didn't give me — if you say two outlets on each of three " +
      "walls, I won't quietly write down six. I'll ask. " +
      "Anything I can't place goes in your notes word for word, so nothing you said gets lost.",
  },
  {
    key: "run-estimate",
    title: "Writing it up",
    say:
      "Back in the truck you press Start the estimate, and the answers from that walk-through are " +
      "already in it, in your own words, taken as given rather than read back to you. Anything you " +
      "priced standing on site is already a line. Press Generate Line Items and I don't touch your " +
      "estimate — I hand you a list of PROPOSED lines. Tick the ones you want, fix any number I got " +
      "wrong, and press Add. Nothing of mine lands until you do. I work off your own price list and " +
      "I flag anything that isn't in it yet as my guess and not your price.",
  },
  {
    key: "run-job",
    anchor: "dock-jobs",
    title: "They say yes",
    say:
      "You mark the estimate accepted and the job builds itself — same customer, same site address, " +
      "the lead it came from, plus a work order and a material list off the estimate. Then it " +
      "starts collecting: clock in on that job and the hours land on it, photograph a supply house " +
      "receipt and I read it and file it on as a cost. The ones I'm not certain about I put in a " +
      "pile for you rather than guess.",
  },
  {
    key: "run-money",
    anchor: "dock-invoices",
    title: "And the money",
    say:
      "Job's done. Press Finish Job and the invoice is already written — if there's an accepted " +
      "estimate, that estimate IS the bill, and I won't stack the hours on top of a price they " +
      "already agreed to. If there isn't one, it's every person's hours at the right rate plus " +
      "every receipt with your markup on. It lands as a draft, and nothing reaches your customer " +
      "unless you tick the box that sends it.",
  },
  // HIS "everybody wins", stated as something he can CHECK rather than handed back as a slogan.
  // After the run and not before: a promise made ahead of the demonstration is a brochure; the
  // same words after it are a summary. It names what is still his, because a tour that only lists
  // what the app does leaves a man wondering what it does behind his back.
  {
    key: "run-win",
    title: "So what did that just save you",
    say:
      "You typed that address once, on the phone call, and it was still with you at the invoice — " +
      "same with the numbers off the walk-through and the hours off the clock. So you're not typing " +
      "it four times, you're not carrying the job round in your head between the yard and the desk, " +
      "and your customer gets a price off your real numbers instead of a guess made in a truck. " +
      "Which lead, what date, what price, what goes out — that's all still yours. I do the typing " +
      "and the remembering, you do the trade.",
  },
    ],
  },
];

export const lessonByKey = (key: string | null | undefined): Lesson | null =>
  LESSONS.find((l) => l.key === key) ?? null;


/** A step by key, for resuming where somebody left off. */
export const tourIndex = (key: string | null | undefined) => {
  const i = TOUR.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
};
