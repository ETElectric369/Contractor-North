import type { Answers, Fill, Need } from "@/lib/playbook/types";

/**
 * NORT TALKING BACK — the difference between a conversation and a dictation box.
 *
 * Erik, one step into the tour, having said "Hello. That works. What's next?" and been told
 * *"I couldn't turn that into an answer for this one"*:
 *
 *   "so we are looking for an interactive dialogue not a dictation based response then frozen,
 *    nort should enter the data and move on with the availability to edit it midstream to make
 *    absolute sure every bit of information is accurate, spelled correctly, understood correctly,
 *    walked through and talked through like a 5 year old kid because thats how they are going to
 *    learn"
 *
 * He said hello. A person says hello back. What he got was a parser reporting failure — which is
 * exactly right as extraction and exactly wrong as behaviour, because the thing being taught in
 * that moment is not his name, it is THAT NORT IS SOMEBODY YOU CAN TALK TO. Answering a greeting
 * with an error teaches the opposite, and it teaches it in the first ten seconds.
 *
 * ── WHAT THIS DOES THAT PURE EXTRACTION DOESN'T ────────────────────────────────────────────
 *
 * The extraction path (lib/playbook/hear) stays exactly as it is — it is the right tool for a man
 * dictating a whole job at speed, and its provenance gate is what keeps invented numbers out of a
 * price. This is the SETUP path, where there is one question on screen and a person who has never
 * used the thing before, and where the reply matters as much as the value.
 *
 * So one call does both: Nort answers what was actually said, AND fills what he can. If nothing
 * was answered he asks again in smaller words instead of reporting an error. If something was
 * answered he repeats it back — spelled out — because a name misheard here rides onto every
 * estimate this company ever sends.
 *
 * SPELLING IS A FIRST-CLASS CONCERN. "make absolute sure every bit of information is accurate,
 * spelled correctly, understood correctly." Speech-to-text mangles surnames and town names more
 * than anything else, so the reply always shows the exact string that will be stored, and the box
 * stays editable underneath it.
 */

export const CONVERSE_SYSTEM =
  "You are Nort, the assistant built into an app a contractor has just opened for the first time. " +
  "You are walking them through setting up their business, one question at a time, out loud.\n\n" +
  "WHO YOU ARE TALKING TO. Tradespeople. Some are not confident with software and are half " +
  "expecting this to be another thing that wastes their afternoon. Short sentences. Plain words. " +
  "Warm, never chirpy, never corporate. You are a capable person helping, not a wizard with a " +
  "progress bar.\n\n" +
  "WHAT YOU DO WITH WHAT THEY SAID:\n" +
  "- ALWAYS REPLY TO WHAT THEY ACTUALLY SAID FIRST. If they said hello, say hello back. If they " +
  "asked a question, answer it. If they said something off-topic, acknowledge it like a person " +
  "would and then come back to the question. NEVER report a parsing failure — 'I couldn't turn " +
  "that into an answer' is not something a person says.\n" +
  "- If they DID answer the question, say the answer back to them EXACTLY as you are storing it, " +
  "so they can hear a misspelling. Then say you've got it.\n" +
  "- If they did NOT answer it, ask again in SMALLER WORDS. Give an example of what an answer " +
  "sounds like. Assume nobody has explained any of this to them before, because nobody has.\n" +
  "- Two or three sentences. This is spoken aloud; nobody listens to a paragraph.\n" +
  "- Never mention keys, fields, JSON, parsing, or the app's internals. Never say 'the system'.\n\n" +
  "HIS NAME COMES BACK MANGLED, AND THAT IS NORMAL. Speech-to-text renders 'Nort' as Norm, Nord, " +
  "North, Nordt, Naught, Snort — and a contractor saying 'Hey Norm, add a material' is addressing " +
  "YOU. Never correct them, never remark on it, never treat it as a different name. Just answer.\n\n" +
  "FILLING. Only fill from what they actually said. Never invent, never compute. Copy `heard` " +
  "verbatim out of their words. If the question wants a number, the digits must be in `heard`. " +
  "When unsure, leave it out and ask again — an unanswered question is fine, a wrong answer " +
  "becomes a price.\n\n" +
  'Return ONLY a JSON object: { "say": "...", "fills": [ { "key": "...", "value": ..., "heard": "..." } ] }.';

/** The one question on screen, what is already known, and what they just said. */
export function conversePrompt(need: Need | undefined, known: Answers, said: string, first: string): string {
  const lines: string[] = [];
  if (first) lines.push(`THEIR NAME: ${first} — use it occasionally, the way a person would. Not every sentence.`);
  if (need) {
    lines.push(`THE QUESTION ON SCREEN: "${need.ask}"  (key: ${need.key})`);
    if (need.slot?.type === "select") lines.push(`  they pick one of: ${need.slot.options.join(" | ")}`);
    else if (need.slot?.type === "number") lines.push(`  a number${need.slot.unit ? ` in ${need.slot.unit}` : ""}`);
    if (need.why) lines.push(`  why it matters: ${need.why}`);
  } else {
    lines.push("THERE IS NO QUESTION ON SCREEN — this is a step where you are explaining something.");
  }
  const have = Object.entries(known)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  if (have.length) lines.push(`ALREADY KNOWN ABOUT THEM:\n${have.join("\n")}`);
  return `${lines.join("\n")}\n\nWHAT THEY JUST SAID:\n${said}`;
}

export interface Spoken {
  say: string;
  fills: Fill[];
}

/** Tolerant parse. A model that wraps its JSON in prose is a formatting problem, not an error. */
export function parseSpoken(text: string): Spoken {
  const empty: Spoken = { say: "", fills: [] };
  if (!text) return empty;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(a, b + 1));
  } catch {
    return empty;
  }
  const o = raw as { say?: unknown; fills?: unknown };
  const fills: Fill[] = [];
  if (Array.isArray(o.fills))
    for (const f of o.fills) {
      if (!f || typeof f !== "object") continue;
      const r = f as Record<string, unknown>;
      const key = typeof r.key === "string" ? r.key.trim() : "";
      if (!key) continue;
      const v = r.value;
      const value =
        typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
          ? v
          : Array.isArray(v)
            ? v.map(String)
            : undefined;
      if (value === undefined) continue;
      fills.push({ key, value, ...(typeof r.heard === "string" ? { heard: r.heard } : {}) });
    }
  return { say: typeof o.say === "string" ? o.say.trim().slice(0, 1200) : "", fills };
}

/**
 * WHAT NORT SAYS WHEN THE MODEL GIVES US NOTHING. Never a parse error, out loud or on screen —
 * a fallback that blames the machinery is the same failure this file exists to remove.
 */
export function fallbackSay(need: Need | undefined, filledSomething: boolean, first: string): string {
  const name = first ? `, ${first}` : "";
  if (filledSomething) return `Got that${name}.`;
  if (!need) return "Right — carry on when you're ready.";
  return `Sorry${name} — say that once more for me? ${need.ask}`;
}
