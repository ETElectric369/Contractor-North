/**
 * Classify a SPOKEN reply to a pending confirm proposal (the by-voice confirm-gate). Pure + framework-
 * free so it's unit-testable in plain Node and reusable outside the chat component.
 *
 * The OLD parser tested the NEGATIVE regex FIRST, so "no wait, yes do the second one" matched "no" and
 * CANCELLED — a dangerous by-voice misfire. This classifies into four intents, in this order:
 *
 *   "yes"        — a pure/leading affirmative → run the action.
 *   "no"         — a STANDALONE negative (leading no/nope/cancel/… NOT walked back by a later yes) → cancel.
 *   "correction" — the user is amending the proposal (actually / make it / change / instead / a number /
 *                  an ordinal / a name-like word). The caller re-sends the whole utterance as a normal
 *                  voice turn so Nort amends in flight — NEVER a veto, never a silent confirm.
 *   "unclear"    — none of the above → re-prompt "say yes or no".
 *
 * The confirm-gate itself is untouched: a "correction" re-sends through the normal turn, which re-proposes;
 * nothing writes without an explicit yes.
 */
export type ConfirmIntent = "yes" | "no" | "correction" | "unclear";

export function classifyConfirmReply(raw: string): ConfirmIntent {
  const orig = String(raw ?? "").trim();
  const low = orig.toLowerCase();
  if (!low) return "unclear";

  const LEAD_YES = /^(?:yes|yeah|yep|yup|sure|okay|ok|confirm|do it|go ahead|save it|sounds good|correct|right|please do)\b/;
  const CORRECTION_KW = /\b(actually|instead|rather|change|make it|correction|not that|different|wait)\b/;
  const AFFIRM = /\b(yes|yeah|yep|yup|confirm|do it|go ahead|sure|okay|ok|save it|sounds good)\b/;
  const NEG_LEAD = /^(?:no|nope|nah|cancel|stop|never ?mind|don'?t|do not|negative|wrong|skip)\b/;
  const NEG_ANY = /\b(no|nope|nah|cancel|never ?mind|don'?t|do not|negative|wrong|skip)\b/;
  const HAS_NUMBER = /\b(\d+|first|second|third|fourth|fifth|one|two|three|four|five|six|seven|eight|nine|ten|last|other)\b/;
  // A name-like token: a capitalized word in the ORIGINAL that isn't the very first word (proper noun
  // mid-sentence) — a weak but conservative "the user named a thing" signal.
  const NAME_LIKE = /\S\s+[A-Z][a-z]{2,}/.test(orig);

  // FAST PATH: starts with a clear affirmative and carries NO correction keyword and NO negative → a
  // plain "yes" (even "yes, the first one" confirms rather than being treated as an edit).
  if (LEAD_YES.test(low) && !CORRECTION_KW.test(low) && !NEG_ANY.test(low)) return "yes";

  // CORRECTION: an explicit amend keyword, a number/ordinal, or a named thing → amend in flight.
  if (CORRECTION_KW.test(low) || HAS_NUMBER.test(low) || NAME_LIKE) return "correction";

  // STANDALONE NEGATIVE: a leading no/cancel/… that isn't walked back by a later affirmative.
  if (NEG_LEAD.test(low) && !AFFIRM.test(low)) return "no";

  // A plain affirmative anywhere (no leading-yes, no correction, no leading-no) still confirms.
  if (AFFIRM.test(low) && !NEG_ANY.test(low)) return "yes";

  return "unclear";
}
