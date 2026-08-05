import { applyFills, clearInapplicable, isAnswered } from "./resolve";
import { answerText } from "./answers";
import type { Answers, Fill, Playbook } from "./types";

/**
 * TURNING WHAT HE SAID INTO WHAT THE PLAYBOOK KNOWS.
 *
 * This is the one place in the whole inspector where a model is genuinely required — the
 * determinism boundary, stated exactly: the INPUT is unstructured (a paragraph a man says while
 * walking a job) and the OUTPUT is structure (typed answers against declared needs). Everything
 * downstream of here is arithmetic and must stay that way.
 *
 * THE JOB IT EXISTS FOR. 13125 Moraine Rd, unprompted, in one breath:
 *
 *   "2 new circuits one for lights and one for outlets installed new in a finished room with
 *    sheetrock and paint made originally for storage but now converting to living space … 2 outlets
 *    on each of 3 walls … connecting to a snap on breaker siemens style, 100 ft of 12.2 romex and
 *    40' of 14/2 romex"
 *
 * Nine facts. The app's answer was to ask him for the panel brand. This is the other answer.
 *
 * FILLING IS NOT EXECUTING. Nothing here sends, prices, or commits anything — it writes into the
 * same boxes he could have typed into, and every one of them stays editable. That is why it needs
 * no allowlist and no confirmation step: the save button is still his.
 *
 * TWO RULES THE MODEL DOES NOT GET TO BEND, both enforced in code, not in the prompt:
 *   1. FILL HOLES, NEVER OVERWRITE A HAND (applyFills). What he typed wins, always.
 *   2. A NUMBER A CALCULATOR WILL EAT MUST BE TRACEABLE TO WORDS HE SAID (acceptFill). The fill
 *      carries the verbatim fragment, the fragment must appear in the transcript, and the number
 *      must appear in the fragment. This is what stops a perimeter being computed in its head and
 *      handed over as though somebody had measured it.
 */

export const HEAR_SYSTEM =
  "You are listening to a contractor describe a job he is standing in front of. You are NOT " +
  "answering him and you are NOT advising him. Your only job is to take what he already said and " +
  "put it in the right boxes.\n\n" +
  "You will be given the questions that are still unanswered. For each one you can actually answer " +
  "FROM HIS OWN WORDS, return a fill.\n\n" +
  "THE RULES:\n" +
  "- Only fill what he SAID. Never infer, never average, never compute. If he said the room is 16 " +
  "by 20, you may NOT return an area of 320 or a perimeter of 72 — those are calculations and they " +
  "are somebody else's job.\n" +
  "- `heard` must be copied VERBATIM out of what he said — the exact fragment the answer came from, " +
  "character for character. Not a paraphrase, not a cleanup. A fill whose `heard` is not literally " +
  "in his words is thrown away.\n" +
  "- For a question with choices, the value must be EXACTLY one of the listed choices (or a list of " +
  "them when it says several are allowed). If what he said is not one of them, leave it out.\n" +
  "- For a number, the digits must appear in `heard`.\n" +
  "- When you are not sure, LEAVE IT OUT. A missing answer becomes a question he gets asked, which " +
  "is fine. A wrong answer becomes a price.\n" +
  "- Some of the listed questions may turn out not to apply to this job. Fill them anyway if he " +
  "answered them — the rules decide afterwards what survives, and that is not your problem.\n" +
  "- PREFER THE SPECIFIC QUESTION. If a fact answers a precise question AND a catch-all one, put " +
  "it in the precise one. A catch-all is for what nothing else covers.\n" +
  "- Put anything he said that mattered but did not fit a question into `leftover`, in his words. " +
  "Do not summarise it and do not throw it away — the sentence nobody's template anticipated is " +
  "half of what goes wrong on a job.\n\n" +
  'Return ONLY a JSON object: { "fills": [ { "key": "...", "value": ..., "heard": "..." } ], ' +
  '"leftover": "..." }. No prose around it. If you can fill nothing, return an empty fills array.';

/**
 * What is still unanswered, described so a model can answer it — and NOTHING else about the job.
 *
 * EVERY UNANSWERED NEED, not just the ones that currently APPLY. This is the difference between
 * the feature working and the feature being a demo, and a live run against his real paragraph is
 * what proved it: offered only what applied to an empty sheet, the model could fill four things
 * and dumped "a finished room with sheetrock and paint", "2 outlets on each of 3 walls" and
 * "accessible from below by cutting the outlet holes" into the leftover — because `walls`,
 * `device_count` and `access` all wait on the work being named, and the work was being named IN
 * THE SAME BREATH. He says the whole job at once; a rule that reveals questions one layer at a
 * time cannot keep up with one sentence.
 *
 * It is safe because the resolver is what arbitrates, not the model: anything filled on a branch
 * that turns out not to apply is nulled by clearInapplicable at the end of applyHeard, exactly as
 * if he had tapped it and then changed the work type. One call, and the rules still decide.
 */
export function hearRequest(pb: Playbook, answers: Answers, transcript: string): string {
  const lines = pb.needs.filter((n) => !isAnswered(answers[n.key])).map((n) => {
    const bits = [`- key: ${n.key}`, `  question: ${n.ask}`];
    if (n.slot?.type === "select")
      bits.push(`  choices: ${n.slot.options.join(" | ")}${n.slot.multi ? "  (a LIST of these is allowed)" : ""}`);
    else if (n.slot?.type === "number") bits.push(`  a number${n.slot.unit ? ` in ${n.slot.unit}` : ""}`);
    else if (n.slot) bits.push("  text");
    else bits.push("  anything he said, in his words");
    if (n.measured) bits.push("  MEASURED — the digits must appear verbatim in `heard`");
    if (n.why) bits.push(`  where the answer lands (his words): ${n.why}`);
    // The long-form reasoning too. It is where the asking rules live — "Ask me the fork, don't ask
    // me for its outputs" — and it moved out of `why` only so a HUMAN could read the line in three
    // seconds. The model has no such constraint and loses nothing.
    if (n.note) bits.push(`  more from him: ${n.note}`);
    return bits.join("\n");
  });

  // What is ALREADY known goes in too, so the model doesn't re-answer it and doesn't contradict it.
  const known = pb.needs
    .filter((n) => isAnswered(answers[n.key]))
    .map((n) => `- ${n.label}: ${answerText(answers[n.key])}`);

  return [
    known.length ? `ALREADY KNOWN (do not fill these again):\n${known.join("\n")}` : "",
    lines.length ? `STILL UNANSWERED:\n${lines.join("\n")}` : "STILL UNANSWERED: nothing.",
    `WHAT HE SAID:\n${transcript}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface Heard {
  fills: Fill[];
  leftover: string;
}

/** Tolerant parse. A model that wraps its JSON in prose or a fence is a formatting problem, not an
 *  error — but anything that isn't a well-formed fill is dropped rather than guessed at. */
export function parseHeard(text: string): Heard {
  const empty: Heard = { fills: [], leftover: "" };
  if (!text) return empty;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  const o = raw as { fills?: unknown; leftover?: unknown };
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
  return { fills, leftover: typeof o.leftover === "string" ? o.leftover.trim() : "" };
}

export interface Applied {
  answers: Answers;
  /** Labels of what got filled — what to tell him, so a fill is never invisible. */
  filled: string[];
  /** The words that did NOT become an answer, verbatim, for the notes box. Never dropped. */
  note: string;
}

/**
 * Apply what was heard, and account for every word of it.
 *
 * A REFUSED FILL IS NEVER SILENT. It goes into the note in his own words and its need stays open,
 * which is exactly what should happen to "there's a roll-up door on that wall" — no number in it,
 * so nothing is invented and the question comes back.
 */
export function applyHeard(pb: Playbook, answers: Answers, transcript: string, heard: Heard): Applied {
  const byKey = new Map(pb.needs.map((n) => [n.key, n]));
  const { answers: next, rejected } = applyFills(pb, answers, heard.fills, transcript);

  const filled = heard.fills
    .filter((f) => !rejected.includes(f))
    .map((f) => byKey.get(f.key)?.label ?? f.key);

  // A fill refused because he'd ALREADY answered it isn't a loss and isn't worth a note — his
  // answer stands, which is the rule working. Everything else is words we failed to place.
  const lost = rejected.filter((f) => !isAnswered(answers[f.key]));
  const parts = [heard.leftover, ...lost.map((f) => f.heard ?? "").filter(Boolean)]
    .map((s) => s.trim())
    .filter(Boolean);

  // CLEAR AFTER FILLING, for the same reason a tap does: naming the work can make a whole branch
  // inapplicable, and an answer from a branch nobody took must not ride into a price. It also
  // normalises the shape — every declared need gets a key — so the caller can set this straight
  // into state without a merge.
  return { answers: clearInapplicable(pb, next), filled, note: [...new Set(parts)].join(" ") };
}
