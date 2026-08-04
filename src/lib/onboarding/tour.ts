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

export interface TourStep {
  key: string;
  /** `data-tour` value of the element to spotlight. Absent = a centred card with no arrow. */
  anchor?: string;
  /** Get to this route before showing the step. */
  route?: string;
  /** The heading on the card. Short. */
  title: string;
  /** WHAT NORT SAYS — spoken aloud and shown as text. Write it to be heard, not read. */
  say: string;
  /** A SETUP_PLAYBOOK key this step is trying to learn. Answering by voice or typing fills it. */
  ask?: string;
  /** Label for the advance button when "Next" is too bland. */
  next?: string;
}

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
    say:
      "Hi — I'm Nort. That button up there is me, and I'm on every screen in here. " +
      "Press the Talk button down here and tell me your name and what you do, the way you'd tell " +
      "a person. Type it instead if you'd rather — I'm not fussy.",
    ask: "full_name",
  },
  {
    key: "trade",
    anchor: "nort",
    title: "What you do",
    say:
      "Good to meet you. Now the one that matters most — what trade are you in? " +
      "If you sub most of it out, say that. 'General contractor, I sub out electrical and plumbing' " +
      "tells me more than picking one word off a list. " +
      "This is the answer that builds your job codes, the questions I'll ask you on site, " +
      "and what an estimate thinks it's pricing.",
    ask: "trade",
  },
  {
    key: "where",
    anchor: "nort",
    title: "Where you work",
    say:
      "Where are you working out of, and how far do you go? " +
      "The town puts the weather on your day, and the area is what your public page tells customers.",
    ask: "city",
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

  // ── 2. THE WHY LINE. The part nobody figures out unaided. ──────────────────────────────────
  {
    key: "why-what",
    title: "Now the part nobody guesses",
    say:
      "Here's the thing that makes this different from every other app you've tried. " +
      "When you walk a job, I ask you questions — and behind every question there's a WHY LINE. " +
      "That's you, in your own words, saying what it costs you when that answer is wrong or missing.",
  },
  {
    key: "why-example",
    title: "What a why line sounds like",
    say:
      "Here's a real one, from an electrician. The question is 'Is anybody pulling a permit, and what for?' " +
      "And his why line says: 'Not yes or no, and usually not me. On the storage room the homeowner " +
      "is pulling one for occupancy — that reclassifies the room, and it means an inspection before " +
      "anything gets covered. That's a second trip. Price it without knowing and the second trip " +
      "isn't in the number.' " +
      "That's not documentation. That's the reason, and it's worth money.",
  },
  {
    key: "why-how",
    title: "How to write one",
    say:
      "So when you write yours, don't describe the question — say what a wrong answer costs you. " +
      "A second trip. Materials you eat. A job you shouldn't have quoted. " +
      "I'll write you a first draft of every one from what you just told me, in your trade's terms, " +
      "and then you cut what's wrong. That's the easy way in — arguing with a draft beats a blank box.",
  },
  {
    key: "why-uses",
    title: "And why I need them",
    say:
      "I read those lines to decide when a question is even worth asking you. " +
      "If you already told me something, I don't ask it again. " +
      "If a number can be worked out from what you said, I don't make you count it. " +
      "The why lines are how I know the difference.",
  },

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
    key: "add",
    anchor: "quickadd",
    title: "Making something new",
    say: "Plus is how anything gets created — a job, a customer, a quote, a task. From any screen.",
  },
  {
    key: "search",
    anchor: "search",
    title: "Finding anything",
    say:
      "Search finds records and runs commands. On a computer it's Command-K. " +
      "When you can't remember where something lives, it's faster than the nav.",
  },
  {
    key: "bell",
    anchor: "bell",
    title: "What needs you",
    say: "The bell is what's waiting on you — it works whether or not you switch on phone notifications.",
  },
  {
    key: "account",
    anchor: "account",
    title: "Your QR code lives here",
    say:
      "Under your account: signing out, language, and your estimate QR code — " +
      "the one you put on the truck or a business card so a customer can send you a job themselves.",
  },
  {
    key: "settings",
    anchor: "dock",
    title: "Settings, and your Playbook",
    say:
      "Settings holds the business — money, scheduling, your website. " +
      "And there's a Playbook section: that's where your questions and your why lines live, " +
      "and you can change any of them any time your mind changes.",
  },

  // ── 4. THE JOB. What this is all for. ──────────────────────────────────────────────────────
  {
    key: "inspector",
    title: "On a job",
    say:
      "Here's how it goes on site. You open a walk-through, press Talk, and say the whole job the " +
      "way you'd say it to a person — everything, in one breath. I put what you said in the right " +
      "boxes and only ask about what's left over.",
  },
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
    key: "done",
    anchor: "setup",
    title: "That's it",
    say:
      "That's the whole thing. This cap button is where I live — take this again any time, " +
      "or come back to change what you told me. Let's get you a job in here.",
    next: "Done",
  },
];

/** A step by key, for resuming where somebody left off. */
export const tourIndex = (key: string | null | undefined) => {
  const i = TOUR.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
};
