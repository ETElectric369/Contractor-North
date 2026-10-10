import type { Answers, AnswerValue, Clause, Fill, Need, Playbook } from "./types";
import { coerceTasks, mergeHeardTasks, screenHeardTask } from "./tasks";

/**
 * THE RESOLVER — pure functions over a playbook and what is known so far.
 *
 * No I/O, no model, no React. Everything the inspector renders and everything the interview is
 * told comes from here, so the cold path and the warm path can never disagree about what still
 * needs knowing.
 */

/** A need with no typed control. The model phrases it; it renders nothing until answered. */
export const isOpen = (n: Need) => !n.slot;

/** Has this need been answered? An empty string, an empty multi-select and null are all "no". */
export function isAnswered(v: AnswerValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  // false is a DECISION, 0 is a MEASUREMENT. Silence is neither — see coerceAnswers, and the
  // permit that vanished at 13125 Mayfern Rd.
  return true;
}

function clauseHolds(c: Clause, answers: Answers): boolean {
  const v = answers[c.key];
  // ASK IT ONLY IF WE COULDN'T WORK IT OUT. The one clause that holds on ABSENCE, so a question
  // whose answer is derivable stays quiet while the inputs are there and reappears the moment
  // they aren't. Checked before the isAnswered guard, because absence is the whole point of it.
  if ("unknown" in c) return !isAnswered(v);
  if (!isAnswered(v)) return false;
  if ("known" in c) return true;
  // MULTI-SELECT MATTERS HERE. Erik's job was outlets AND lights — a router that only holds one
  // value is the shipped sheet's failure rebuilt one layer up. Any overlap counts.
  const held = Array.isArray(v) ? v.map(String) : [String(v)];
  return held.some((x) => c.in.includes(x));
}

/**
 * The needs that apply right now. ALL clauses must hold — a conjunction, not a chain.
 *
 * This is the change that makes the storage room answerable. "Fish it, or run surface?" depends on
 * BOTH the wall finish and whether it's permitted; with a single-key rule it could only ever wait
 * for one of them, so it was either asked too early (meaningless) or not at all.
 */
export function applicableNeeds(pb: Playbook, answers: Answers): Need[] {
  return pb.needs.filter((n) => !n.when?.length || n.when.every((c) => clauseHolds(c, answers)));
}

/**
 * WHAT A HELD KEY'S CLASSIFICATION WAS when the hold was taken — answered or not.
 *
 * A Set was not enough, and the audit caught why. cn-v699 made a held key count as still-MISSING,
 * which is right for a need being answered for the first time and wrong for one that was ALREADY
 * answered: tapping into Erik's scope — an open need, pinned in the spine precisely because it is
 * the working document of the whole inspection — forced it to "missing", so it left the spine
 * and re-rendered somewhere else. That is bug 48fbfd6e rebuilt by the fix for bug 48fbfd6e.
 *
 * A hold must freeze the classification at whatever it WAS, in either direction.
 */
export type Held = ReadonlyMap<string, boolean>;

const NOTHING_HELD: Held = new Map();

/**
 * Applicable and still unanswered — "what am I actually still missing", in declaration order.
 *
 * ── `held` — AND WHY IT IS NOT JUST A MASKED `answers` OBJECT (cn-v699) ─────────────────────
 *
 * The inspector holds a need's CLASSIFICATION still while somebody is working in it, so the field
 * under their thumb doesn't relocate mid-gesture (bug 48fbfd6e, and its chip-grid twin). cn-v698
 * implemented that hold by passing a COPY of the answers with the held key nulled — which also
 * hid the answer from `applicableNeeds`, because that is the same object the `when` graph reads.
 *
 * The consequence was severe and I shipped it: Vivian Builders' site inspection is a chain of
 * eight multi-selects — symptom → q_msgpd6ui, scope → size, access → permit → q_msgnw9bk — so
 * tapping "New Construction" held `symptom`, masked it, and the follow-up question written for
 * exactly that answer DISAPPEARED until something else was touched. A router that is being tapped
 * is precisely the router whose answer everything downstream is waiting for.
 *
 * So the two ideas are separated here rather than conflated: applicability ALWAYS reads the real
 * answers, and `held` only makes a need count as still-missing so it keeps its place on screen.
 */
export function missingNeeds(pb: Playbook, answers: Answers, held: Held = NOTHING_HELD): Need[] {
  return applicableNeeds(pb, answers).filter((n) =>
    held.has(n.key) ? !held.get(n.key) : !isAnswered(answers[n.key]),
  );
}

/** Answered AND not being worked in — the inverse of `held.has(k) || !isAnswered(...)` above, so
 *  a caller sorting needs into zones uses the same rule the resolver does. */
export const isSettled = (answers: Answers, key: string, held: Held = NOTHING_HELD): boolean =>
  held.has(key) ? !!held.get(key) : isAnswered(answers[key]);

/** Missing AND marked hold — "don't let me price without this". */
export const holdingNeeds = (pb: Playbook, answers: Answers) => missingNeeds(pb, answers).filter((n) => n.hold);

/**
 * WHAT GOES ON SCREEN NOW, and what is one tap away. AVAILABLE IS NOT VISIBLE.
 *
 * Erik: "it wasnt so much the measurements box in the way it was the subquestions that didnt guide
 * me… my eye left with the measurements box becuase it stuck out permanent right there."
 *
 * A need with a CONTROL is a question you answer by tapping, so it shows. A need with no control is
 * a sentence somebody has to say — Nort phrases it and hears it, and until then an empty box for it
 * is furniture standing between him and the work. Those become a named chip instead.
 *
 * ONE EXCEPTION, and it is the entire point of the flag: a HOLD always shows, control or not.
 * "Don't let me price without this" cannot be something you have to go looking for.
 *
 * `reached` is whatever has been tapped open — nothing is ever locked away, only quiet.
 */
export function splitAsk(
  pb: Playbook,
  answers: Answers,
  reached: ReadonlySet<string> = new Set(),
  /** Keys whose classification is frozen because somebody is typing/tapping in them, mapped to
   *  what that classification WAS when the hold was taken. */
  held: Held = NOTHING_HELD,
): { ask: Need[]; reach: Need[] } {
  const missing = missingNeeds(pb, answers, held);
  return {
    ask: missing.filter((n) => n.slot || n.hold || reached.has(n.key)),
    reach: missing.filter((n) => !n.slot && !n.hold && !reached.has(n.key)),
  };
}

/**
 * THE DIAL, and it is derived rather than declared.
 *
 * A playbook is CLOSED when every need that currently applies has a typed control. Chris's is
 * closed because he answered every question with a control; Erik's is open because it holds three
 * sentences no control can carry.
 *
 * Nobody ticks a box, and nobody can accidentally flip Chris into an interview — it would take
 * adding an open need to his own playbook, deliberately. On a closed branch the interview surface
 * is never mounted and no fetch is ever attempted.
 */
export const isClosed = (pb: Playbook, answers: Answers = {}) => applicableNeeds(pb, answers).every((n) => !isOpen(n));

/**
 * Answers to needs that no longer apply are stale by definition — same law as clearHiddenAnswers.
 *
 * ITERATES TO A FIXED POINT, and it must. The old sheet's rules were one key deep, so one pass
 * sufficed. `when` allows CHAINS — work → power_source → feed → run_ft — and a single pass clears
 * only the first level: with `power_source` still holding its stale value, `feed` still looks
 * applicable, so `run_ft` survives too. That is a measurement from an abandoned branch riding into
 * a price, which is the exact class of bug clearing exists to prevent.
 *
 * Bounded by the need count: each round nulls at least one more key or stops.
 */
export function clearInapplicable(pb: Playbook, answers: Answers): Answers {
  let cur: Answers = { ...answers };
  for (let round = 0; round <= pb.needs.length; round++) {
    const live = new Set(applicableNeeds(pb, cur).map((n) => n.key));
    const next: Answers = {};
    for (const n of pb.needs) next[n.key] = live.has(n.key) ? (cur[n.key] ?? null) : null;
    const settled = pb.needs.every((n) => next[n.key] === cur[n.key]);
    cur = next;
    if (settled) break;
  }
  return cur;
}

// ── THE PROVENANCE GATE ──────────────────────────────────────────────────────────────────────

const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Every number a phrase actually contains — digits and words. "sixteen by twenty four" → [16,24].
 *
 * Tens+units compose ("twenty five" → 25) but a bare unit still counts on its own, because
 * "twenty four" must yield 24 AND a lone "four" must yield 4.
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  const toks = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const a = WORDS[toks[i]];
    if (a === undefined) continue;
    const b = WORDS[toks[i + 1]];
    // 20..90 followed by 1..9 is one number: "twenty four" is 24, not 20 and 4.
    if (a >= 20 && a % 10 === 0 && b !== undefined && b > 0 && b < 10) {
      out.push(a + b);
      i++;
    } else out.push(a);
  }
  return out;
}

/**
 * RATE TALK AND FRACTIONS that look like hours and are not: "$85/hr", "200 per hour", "3/4 hour", and
 * any money figure. Scrubbed before either tracer looks, so a rate he typed never becomes a task's
 * hours or a part's count (statedLaborRate reads rates on its own).
 */
const NOT_HOURS: RegExp[] = [
  /\$\s*[\d.,]+\s*(?:\/|per)?\s*(?:hours?|hrs?|h)?\b/gi,
  /[\d.]+\s*(?:\/|per)\s*(?:hours?|hrs?|h)\b/gi,
  /\d+\/\d+\s*(?:hours?|hrs?|h)\b/gi,
];
const scrubNotHours = (text: string): string => NOT_HOURS.reduce((acc, re) => acc.replace(re, " "), text);

/**
 * THE FIGURES HE SAID AS HOURS — and only those. "3 hours", "3 hrs", "3 hours.", "an hour", "half an
 * hour", "an hour and a half", "two and a half hours", "1.5h", "30 mins" (= 0.5). A bare number is
 * not hours; "4 days" is not hours (and is not converted — that is arithmetic); "8 hours a day" is a
 * pace, not a task's time; "$85/hr" and "200 per hour" are rates; "a 2 hour rated wall" is a wall.
 * This is what lets a task's hours be traced to his words without a "4" from "4 receptacles" or
 * "4 full days" sliding in.
 */
export function hoursIn(text: string): number[] {
  const out: number[] = [];
  const toks = scrubNotHours(text)
    .toLowerCase()
    .replace(/(\d)h\b/g, "$1 h")
    .split(/[^a-z0-9.]+/)
    // "3 hours." — the sentence's full stop is not part of the word.
    .map((t) => t.replace(/\.+$/, ""))
    .filter(Boolean);
  const isHour = (t: string | undefined) => !!t && /^(hours?|hrs?|h)$/.test(t);
  const isMinute = (t: string | undefined) => !!t && /^(minutes?|mins?|min)$/.test(t);
  // "8 hours a day", "2 hours per unit", "2 hour rated": a pace or a rating, not his time on a task.
  const paced = (i: number) => {
    const a = toks[i + 1];
    const b = toks[i + 2];
    return a === "per" || a === "each" || a === "every" || a === "daily" || a === "rated" || (a === "a" && (b === "day" || b === "week" || b === "shift" || b === "unit"));
  };
  for (let i = 0; i < toks.length; i++) {
    if (isMinute(toks[i])) {
      if (paced(i)) continue;
      const nums = numbersIn(toks[i - 1] ?? "");
      if (nums.length) out.push(Math.round((nums[0] / 60) * 100) / 100);
      continue;
    }
    if (!isHour(toks[i]) || paced(i)) continue;
    // "… hour and a half" — the half rides on the number before the hour word.
    const halfAfter = toks[i + 1] === "and" && toks[i + 2] === "a" && toks[i + 3] === "half";
    let j = i - 1;
    let half = halfAfter;
    // "two and a half hours"
    if (toks[j] === "half" && toks[j - 1] === "a" && toks[j - 2] === "and") {
      half = true;
      j -= 3;
    }
    // "half an hour", "a half hour"
    if (toks[j] === "half" || (toks[j] === "an" && toks[j - 1] === "half")) {
      out.push(0.5);
      continue;
    }
    // "an hour", "a hour"
    if (toks[j] === "an" || toks[j] === "a") {
      out.push(1 + (half ? 0.5 : 0));
      continue;
    }
    const nums = numbersIn(toks.slice(Math.max(0, j - 1), j + 1).join(" "));
    if (nums.length) out.push(nums[nums.length - 1] + (half ? 0.5 : 0));
  }
  return out;
}

/**
 * THE NUMBERS HE SAID AS COUNTS: every number in the words, minus the ones said as hours or minutes
 * and minus any money. "2 fans, 2 hours" → [2] (the fans); "replace the outlet in the hall, 3 hours
 * total" → [] (the 3 was his time, not a count of outlets). The skeptic's probe: a part's count
 * must never be the task's hours figure wearing a different hat.
 */
export function countsIn(text: string): number[] {
  const cleaned = scrubNotHours(text)
    .toLowerCase()
    .replace(/(\d)h\b/g, "$1 h")
    .replace(/\b([a-z]+|\d+(?:\.\d+)?)(\s+and\s+a\s+half)?\s*(hours?|hrs?|h|minutes?|mins?|min)\b\.?/g, " ");
  return numbersIn(cleaned);
}

/**
 * May this proposed value be written?
 *
 * A number a CALCULATOR will consume must be traceable to words a human actually said. This is the
 * hole every version of this design left open, and it is the one that would corrupt Chris's
 * arithmetic: nothing else stops a heard fill dropping `length: 16` into the slot the deck
 * estimator reads.
 *
 * A rejected fill is NEVER silent. The caller puts the words verbatim into notes and re-raises the
 * need as the next question — which is exactly what should happen to "there's a roll-up door on
 * that wall": no number in it, so nothing is invented and the box comes back.
 */
export function acceptFill(need: Need, f: Fill, transcript: string): "accept" | "reject" {
  // EVERY NUMBER IS GATED, not just the ones somebody remembered to tick `measured` on.
  //
  // Keying this on the flag alone made the gate OPT-IN, and the opt-in leaks two ways.
  // measurementsFromAnswers matches number fields by key/label regex with no `measured` filter, so
  // an unflagged number named "length" still sizes a kit and still becomes a priced quantity. And
  // the /forms editor rebuilds forms.schema from {key,label,type,options,showIf} — it drops
  // `measured` off every number field it touches, so the first time anybody edits a starter sheet
  // the flag silently comes off and the gate silently opens.
  //
  // A number slot IS a calculator input. Treat it as one and the flag becomes an annotation
  // rather than a load-bearing switch.
  if (!need.measured && need.slot?.type !== "number") return "accept"; // context, not a number
  if (typeof f.value !== "number") return "reject";
  if (!f.heard || !transcript.includes(f.heard)) return "reject";
  return numbersIn(f.heard).includes(f.value) ? "accept" : "reject";
}

/** Apply fills that pass the gate; hand back what was refused so the caller can re-ask, not drop. */
export function applyFills(
  pb: Playbook,
  answers: Answers,
  fills: Fill[],
  transcript: string,
): { answers: Answers; rejected: Fill[]; unplaced: string[] } {
  const byKey = new Map(pb.needs.map((n) => [n.key, n]));
  const next = { ...answers };
  const rejected: Fill[] = [];
  // HIS WORDS THAT DID NOT LAND, verbatim, for the note — a task fill can half-land (the task is
  // kept, a number or a part is not), and the half that was refused is never silent.
  const unplaced: string[] = [];
  const isObj = (x: unknown) => !!x && typeof x === "object";
  for (const f of fills) {
    const need = byKey.get(f.key);
    // A key the playbook never declared is not a fill, it is an invention.
    if (!need) {
      rejected.push(f);
      continue;
    }
    // A TASK LIST FILLS BY MERGING, not by replacing (lib/playbook/tasks.ts). He may have named
    // three tasks by hand and then said two more: the new ones are added, a hand-set hour is never
    // touched, and every task, part and number in the fill is screened against the fragment it
    // came from (screenHeardTask) — what he did not say is dropped and SAID, never stored.
    if (need.slot?.type === "tasks") {
      const heard = coerceTasks(Array.isArray(f.value) ? f.value : [f.value]);
      if (!heard || !f.heard || !transcript.includes(f.heard)) {
        rejected.push(f);
        // Said where every other refused fill is said (applyHeard's note), never dropped.
        if (f.heard) unplaced.push(f.heard);
        continue;
      }
      const said = { hours: hoursIn(f.heard), counts: countsIn(f.heard) };
      const screened = heard.map((t) => screenHeardTask(t, f.heard!, said));
      const dropped = screened.some((s) => s.dropped.length);
      const kept = screened.map((s) => s.task).filter((t): t is NonNullable<typeof t> => !!t);
      const existing = coerceTasks(next[f.key]) ?? [];
      const merged = mergeHeardTasks(existing, kept);
      // Anything refused — a number not said as hours, a part or a task he did not name, hours
      // that disagree with the ones he typed — puts his fragment in the note, verbatim.
      if (dropped || merged.skipped.length || !kept.length) unplaced.push(f.heard);
      if (!merged.added.length) {
        // Nothing new in it: his answer stands.
        rejected.push(f);
        continue;
      }
      next[f.key] = merged.tasks;
      continue;
    }
    // AN OBJECT IS ONLY EVER A TASK. For every other need a fill is a scalar or a list of words; an
    // object here is a model writing a scopes pick (with a price nobody said) or "[object Object]"
    // into a text box. Refused whole.
    if (isObj(f.value) && (!Array.isArray(f.value) || f.value.some(isObj))) {
      rejected.push(f);
      continue;
    }
    // FILL HOLES, NEVER OVERWRITE A HAND. The law the whole single-source-of-truth idea rests on.
    if (isAnswered(next[f.key])) {
      rejected.push(f);
      continue;
    }
    if (acceptFill(need, f, transcript) === "accept") next[f.key] = f.value;
    else rejected.push(f);
  }
  return { answers: next, rejected, unplaced };
}
