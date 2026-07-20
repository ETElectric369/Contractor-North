/**
 * Classify a SPOKEN reply to a pending confirm proposal (the by-voice confirm-gate). Pure + framework-
 * free so it's unit-testable in plain Node and reusable outside the chat component.
 *
 * The OLD parser tested the NEGATIVE regex FIRST, so "no wait, yes do the second one" matched "no" and
 * CANCELLED — a dangerous by-voice misfire. This classifies into four intents, in this order:
 *
 *   "yes"        — an affirmative-DOMINANT utterance → run the action.
 *   "no"         — a STANDALONE negative (leading no/nope/cancel/… NOT walked back by a later yes) → cancel.
 *   "correction" — the user is amending OR questioning the proposal (actually / make it / change /
 *                  instead / a number / an ordinal / a name-like word / a question or hedge). The
 *                  caller re-sends the whole utterance as a normal voice turn so Nort answers or
 *                  amends in flight — NEVER a veto, never a silent confirm.
 *   "unclear"    — none of the above → re-prompt "say yes or no".
 *
 * WHY "dominant", not "containing": the mic is armed the instant Nort finishes speaking a money
 * proposal, so the driver's very next words land here — and those words are often a QUESTION, not
 * consent ("sure, but which invoice is that?"). The old parser accepted an affirmative ANYWHERE in
 * the utterance and counted "ok"/"okay"/"sure" as affirmatives, so an incidental filler in front of
 * a question ("ok what's the total") committed a confirm-gated financial write. Two defenses now:
 *   1. A question or hedge (a trailing "?" or an interrogative word / "but" / "hold on") is NEVER a
 *      yes — it routes to "correction" so Nort answers and re-proposes.
 *   2. The weak tokens ok/okay/sure confirm ONLY as the LEADING word of the bounded fast path;
 *      they are NOT in the anywhere-match set, so they can't confirm from mid-utterance.
 *
 * The confirm-gate itself is untouched: a "correction" re-sends through the normal turn, which
 * re-proposes; nothing writes without a fresh explicit yes.
 */
export type ConfirmIntent = "yes" | "no" | "correction" | "unclear";

export function classifyConfirmReply(raw: string): ConfirmIntent {
  const orig = String(raw ?? "").trim();
  const low = orig.toLowerCase();
  if (!low) return "unclear";

  const LEAD_YES = /^(?:yes|yeah|yep|yup|sure|okay|ok|confirm|do it|go ahead|save it|sounds good|correct|right|please do)\b/;
  const CORRECTION_KW = /\b(actually|instead|rather|change|make it|correction|not that|different|wait)\b/;
  // Weak tokens (ok / okay / sure) are DELIBERATELY absent here — as an anywhere-match they fire on
  // incidental filler ("ok what's the total", "the number looks ok right"). They confirm only via
  // the bounded fast path below, where they must LEAD the utterance.
  const AFFIRM = /\b(yes|yeah|yep|yup|confirm|do it|go ahead|save it|sounds good)\b/;
  const NEG_LEAD = /^(?:no|nope|nah|cancel|stop|never ?mind|don'?t|do not|negative|wrong|skip)\b/;
  const NEG_ANY = /\b(no|nope|nah|cancel|never ?mind|don'?t|do not|negative|wrong|skip)\b/;
  const HAS_NUMBER = /\b(\d+|first|second|third|fourth|fifth|one|two|three|four|five|six|seven|eight|nine|ten|last|other)\b/;
  // A name-like token: a capitalized word in the ORIGINAL that isn't the very first word (proper noun
  // mid-sentence) — a weak but conservative "the user named a thing" signal.
  const NAME_LIKE = /\S\s+[A-Z][a-z]{2,}/.test(orig);
  // A QUESTION or a HEDGE: the driver is asking or stalling, not consenting — even if an affirmative
  // filler leads ("sure, but…", "ok what's…", "okay hold on"). A trailing "?" or any of these words.
  const INTERROG_HEDGE =
    /\?\s*$/.test(orig) ||
    /\b(which|what|what'?s|whats|who|whose|when|where|why|how|is that|are those|hold on|one sec|hang on|but)\b/.test(low);

  // HEDGE/QUESTION FIRST: never let a leading "sure"/"ok" in front of a question read as consent.
  // Re-send it as a normal turn (correction) so Nort answers and re-proposes — unless it's a leading
  // NEGATIVE, which the standalone-no branch below still handles (a "no" walked back stays a correction).
  if (INTERROG_HEDGE && !NEG_LEAD.test(low)) return "correction";

  // FAST PATH: starts with a clear affirmative and carries NO correction keyword, NO negative, and NO
  // hedge → a plain "yes" (even "yes, the first one" confirms rather than being treated as an edit).
  if (LEAD_YES.test(low) && !CORRECTION_KW.test(low) && !NEG_ANY.test(low)) return "yes";

  // CORRECTION: an explicit amend keyword, a number/ordinal, or a named thing → amend in flight.
  if (CORRECTION_KW.test(low) || HAS_NUMBER.test(low) || NAME_LIKE) return "correction";

  // STANDALONE NEGATIVE: a leading no/cancel/… that isn't walked back by a later affirmative.
  if (NEG_LEAD.test(low) && !AFFIRM.test(low)) return "no";

  // A strong affirmative anywhere (no leading-yes, no correction, no leading-no, no hedge) still
  // confirms — but the WEAK fillers ok/okay/sure are no longer in AFFIRM, so only an unambiguous
  // yes/yeah/confirm/"do it" reaches here.
  if (AFFIRM.test(low) && !NEG_ANY.test(low)) return "yes";

  return "unclear";
}
