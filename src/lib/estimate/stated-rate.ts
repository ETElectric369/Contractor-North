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

/** Rates outside this are a typo or a misread, not a decision. No trade bills under $25/hr,
 *  and "a 4 hour minimum" must never survive as a $4 rate (audit 7). */
const MIN = 25;
const MAX = 2000;

const RATE = /(?:\$\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:\/\s*|per\s+|an\s+|a\s+)?(?:hr|hrs|hour|hourly)\b/gi;
const SAYS_RATE = /(?:\$|\brate\b|\blabor\b|\blabour\b|\bhourly\b|\bbill(?:ed|ing)?\b|\bcharge\b)/i;
/** What follows "N hour(s)" when it is a POLICY, not a price: "4 hour minimum", "1 hour
 *  increments", "24 hour response/callout/notice". Rejecting these fails toward the company
 *  default — the safe direction (audit 7: "We bill a 4 hour minimum" priced a draft at $4/hr). */
const AFTER_NOT_RATE = /^[\s,.-]*(?:minimums?|min\b|increments?|windows?|response|callouts?|blocks?|notice|turnaround|on[\s-]*site)/i;

export function statedLaborRate(scope: unknown): number | null {
  const text = typeof scope === "string" ? scope : "";
  if (!text) return null;
  for (const m of text.matchAll(RATE)) {
    const start = m.index ?? 0;
    // A literal $ on the number is evidence by itself; otherwise the forty characters in FRONT
    // decide (before ONLY — letting "hourly" inside the match self-satisfy is how "a 4 hour
    // minimum" after the word "bill" read as a rate).
    const before = text.slice(Math.max(0, start - 40), start);
    if (!/^\$/.test(m[0]) && !SAYS_RATE.test(before)) continue;
    // …and the words BEHIND it can veto: "minimum/increment/response" means hours-as-policy.
    // The loop continues, so "…4 hour minimum. Rate is $185/hr" still finds the 185.
    if (AFTER_NOT_RATE.test(text.slice(start + m[0].length, start + m[0].length + 24))) continue;
    const n = Number(String(m[1]).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= MIN && n <= MAX) return Math.round(n * 100) / 100;
  }
  return null;
}
