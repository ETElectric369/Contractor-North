import type { Playbook } from "@/lib/playbook/types";

/**
 * SETTING THE COMPANY UP IS THE SAME SHAPE AS WALKING A JOB.
 *
 * Erik: "onboarding needs to be smart like that and nort runs the show … an onboarding interview
 * with built in training rather than a tutorial."
 *
 * So it is not a wizard, and it is deliberately not its own engine. It is a PLAYBOOK — the same
 * `Need` shape the inspector renders, the same resolver deciding what is still missing, the same
 * extraction turning a spoken sentence into typed answers. A second mechanism here would be a
 * second set of bugs and a second thing to teach; there is one Nort, and a surface contributes a
 * target and a projection, never an assistant of its own.
 *
 * It also means the interview TEACHES THE APP BY BEING THE APP. By the time somebody has said
 * "I'm a deck builder out of Truckee, I charge 95 an hour" and watched three boxes fill in, they
 * already know how the inspector works, because it is the same thing.
 *
 * WHY THIS ORDER. Trade first, and it is not close: one answer seeds the job codes they clock time
 * against, the walk-through questions the inspector asks on site, AND what the estimator thinks it
 * is pricing. Andrew Cohen signed up, left it blank, and got a generic six-question sheet — three
 * dead surfaces from one unanswered question.
 *
 * NOTHING HERE IS A GATE. A half-finished setup never blocks anything; the card just keeps
 * offering the next thing to say.
 */
export const SETUP_PLAYBOOK: Playbook = {
  needs: [
    {
      key: "full_name",
      label: "Your name",
      ask: "What's your name?",
      slot: { type: "text" },
      feeds: ["who"],
      why: "It goes on your estimates and invoices, and it's how your crew sees who did what.",
    },
    {
      key: "trade",
      label: "Your trade",
      ask: "And what do you do — what trade are you in?",
      slot: { type: "text" },
      hold: true,
      feeds: ["what"],
      why:
        "The one answer that lights up three dead surfaces: the job codes seeded at signup, the " +
        "questions your walk-through asks on site, and what an estimate thinks it's pricing. " +
        "If you sub most of it out, say that — 'general contractor, I sub out electrical and plumbing' " +
        "is a better answer than picking one trade off a list.",
    },
    {
      key: "city",
      label: "Where you're based",
      ask: "What town are you working out of?",
      slot: { type: "text" },
      feeds: ["where"],
      why: "Puts the weather on your day, and it's what customers see when they look you up.",
    },
    {
      key: "service_area",
      label: "How far you go",
      ask: "And how far out do you go?",
      slot: { type: "text" },
      feeds: ["where"],
      when: [{ key: "city", known: true }],
      why: "Not a radius — the places you'd actually drive to. It's what your public page says you cover.",
    },
    {
      key: "labor_rate",
      label: "Your hourly rate",
      ask: "What do you charge an hour?",
      slot: { type: "number", unit: "$/hr" },
      measured: true,
      feeds: ["what"],
      why:
        "So an estimate can price labor without you doing the math. It's a default you change per " +
        "job and per customer — nothing here locks you to it.",
    },
  ],
};
