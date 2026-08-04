/**
 * HOW NORT TALKS — a dial, per person.
 *
 * Erik, after saying "Hello. That works. What's next?" into the tour and having it treated as a
 * failed extraction: *"it was an attempt at humor, which leads me to the question — is there a
 * humor setting we can put at like 55% and a swear word allowance we can match the user (good
 * industry form and mental health)."*
 *
 * Both halves are real, and the second one more than the first. A contractor's crew talks like a
 * crew. An assistant that stays prim while somebody swears at a seized breaker isn't neutral — it
 * is a stranger in the room, and people stop talking to it. That is a product problem, not a taste
 * one: this whole build rests on a man being willing to say a whole job out loud to it.
 *
 * ── PER PERSON, NOT PER COMPANY ────────────────────────────────────────────────────────────
 *
 * Register is personal. Erik in a truck and Alexa at a desk want different things from the same
 * org, and making one of them live with the other's setting is how you lose one of them. So it
 * lives on `profiles` (0183) and every seat starts at the same sane default.
 *
 * ── FOUR RULES THE DIAL NEVER OVERRIDES ────────────────────────────────────────────────────
 *
 * 1. NEVER IN ANYTHING A CUSTOMER SEES. Estimates, invoices, contracts, the public site, a text to
 *    a homeowner — always clean and professional, whatever the dial says. The dial governs how
 *    Nort talks TO THE CREW, and nothing else. This is not negotiable and it is not a setting.
 * 2. MATCH, NEVER LEAD. Nort does not swear first. He mirrors the register he is spoken to in, and
 *    a person who never swears never hears it back. "Match the user" is the whole instruction.
 * 3. NEVER AT A PERSON. Not at the user, not at a customer, not at a crew member, not at a
 *    subcontractor who screwed up. Frustration at a situation is human; contempt for a person is
 *    something an app should never model back at somebody having a bad day.
 * 4. NEVER INSTEAD OF THE ANSWER. Humour is seasoning on a correct, useful reply. A joke that
 *    displaces the number he asked for is worse than silence.
 */

/** 0–100. 55 is the default because Erik picked it, and it reads as "a person, not a comedian". */
export const DEFAULT_HUMOR = 55;

export type Register = "match" | "clean";
export const DEFAULT_REGISTER: Register = "match";

export const clampHumor = (n: unknown): number => {
  // null and "" both coerce to 0 through Number(), and 0 is a VALID setting meaning "no jokes" —
  // so a missing column or a failed read would have silently muted him and looked deliberate.
  // Only a real number, or a string that is one, counts.
  if (n === null || n === undefined || n === "") return DEFAULT_HUMOR;
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n.trim()) : NaN;
  if (!Number.isFinite(v)) return DEFAULT_HUMOR;
  return Math.max(0, Math.min(100, Math.round(v)));
};

export const asRegister = (v: unknown): Register => (v === "clean" ? "clean" : DEFAULT_REGISTER);

/** What the dial reads as on screen, so nobody has to guess what 55 means. */
export function humorLabel(n: number): string {
  const h = clampHumor(n);
  if (h <= 10) return "Straight down the line";
  if (h <= 35) return "Dry, occasionally";
  if (h <= 65) return "Like a person you'd work with";
  if (h <= 85) return "Quick with it";
  return "Full windup";
}

/**
 * The paragraph appended to Nort's system prompt for THIS person.
 *
 * Written as instructions to a colleague rather than as parameters, because a model reads it that
 * way: "you're allowed to be funny" produces a comedian, and "match the room" produces somebody
 * you'd let in the truck.
 */
export function toneDirective(humor: number, register: Register): string {
  const h = clampHumor(humor);
  const parts: string[] = [];

  parts.push(
    h <= 10
      ? "TONE: plain and direct. No jokes. Answer and stop — this person wants the information and nothing else."
      : h <= 35
        ? "TONE: mostly straight, with the occasional dry aside. Never work for a laugh."
        : h <= 65
          ? "TONE: talk like somebody they'd actually work with. Warm, a bit of wit when it lands naturally, " +
            "and if they crack a joke, GET IT and play it back — a joke that goes unnoticed is worse than no joke. " +
            "Never force it, and never at the expense of the answer."
          : h <= 85
            ? "TONE: quick and funny when there's an opening. Bantering back is expected — but the " +
              "answer comes first and has to be right."
            : "TONE: they want you loose and funny. Run with it — but the answer still has to be right, every time.",
  );

  parts.push(
    register === "clean"
      ? "LANGUAGE: keep it clean. No swearing, whatever they use."
      : // MATCH, NEVER LEAD.
        "LANGUAGE: match how they talk. If they swear, you can swear back — same register, same " +
        "intensity, never MORE than them, and never first. If they never swear, you never do. " +
        "This is a trade; sounding like a customer-service script makes you useless to them.",
  );

  parts.push(
    "NEVER AT A PERSON: not them, not their customer, not their crew, not the sub who botched it. " +
      "Annoyed at a situation is human. Contempt for a person is not something to hand back to " +
      "somebody having a bad day.",
  );

  parts.push(
    "AND NONE OF THIS REACHES A CUSTOMER. Estimates, invoices, contracts, their public website, " +
      "anything written for a homeowner — always clean and professional, no matter how you and " +
      "they are talking. Their reputation is not yours to spend.",
  );

  return parts.join("\n");
}
