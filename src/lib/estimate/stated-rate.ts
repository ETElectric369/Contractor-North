/**
 * THE LABOR RATE HE ACTUALLY SAID, taken out of his own scope text.
 *
 * Erik wrote: "2 guys will take us two full days at a 2 man labor rate of 200 per hour". The
 * estimate came back at 145 — his company default — and he corrected it by hand. line-map's labor
 * branch overwrites whatever the model returns with `ctx.rate`, and the comment above it explains
 * why: the bill rate is a business fact the app has already resolved, and letting a model invent
 * an hourly is how a guessed number reaches a customer looking authoritative.
 *
 * That guard is right about INVENTION and wrong about DICTATION. Same rule as the outlet count:
 * add whatever is stated. He is the one who sets his rates; when he types one into the scope, it
 * is not the model's guess, it is an instruction.
 *
 * So the rate is read HERE, from his text, by code — never taken from the model's word for it.
 * The model cannot lie about a number this function can see for itself, which is the same shape as
 * the playbook's rule that a spoken fill must appear verbatim in the transcript.
 *
 * ── WHY THE CONTEXT GUARD ───────────────────────────────────────────────────────────────────
 *
 * A bare "number then hour" is far too loose in this trade. His own paragraph contains "200 amps
 * each", "twelve 20 amp single pole breakers" and "two full days" — and a 24-hour callout, a
 * 4-hour minimum or a 3 hour trip charge would all match a naive pattern. So a candidate only
 * counts when the words around it say it is a RATE: a dollar sign, or "rate"/"labor"/"hourly"/
 * "bill" close in front of it. Anything else is left alone and the company rate stands, which is
 * the safe direction to fail.
 */

/** Rates outside this are a typo or a misread, not a decision. */
const MIN = 1;
const MAX = 2000;

const RATE = /(?:\$\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:\/\s*|per\s+|an\s+|a\s+)?(?:hr|hrs|hour|hourly)\b/gi;
const SAYS_RATE = /(?:\$|\brate\b|\blabor\b|\blabour\b|\bhourly\b|\bbill(?:ed|ing)?\b|\bcharge\b)/i;

export function statedLaborRate(scope: unknown): number | null {
  const text = typeof scope === "string" ? scope : "";
  if (!text) return null;
  for (const m of text.matchAll(RATE)) {
    // The forty characters in front of the number decide whether it is money or a measurement.
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    if (!SAYS_RATE.test(before + m[0])) continue;
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= MIN && n <= MAX) return Math.round(n * 100) / 100;
  }
  return null;
}
