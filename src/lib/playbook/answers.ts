import { looseNumber } from "@/lib/inspection/capture";
import { applicableNeeds, clearInapplicable } from "./resolve";
import type { Answers, AnswerValue, Need, Playbook } from "./types";

/**
 * THE WRITE CONTRACT, expressed over a playbook instead of a sheet.
 *
 * coerceAnswers (lib/inspection/schema) is the same idea one layer down, and it has to stay for
 * everything that still reads a raw sheet. But the moment the inspector renders from a playbook,
 * coercing the result against the SHEET splits the truth in half — and it splits it exactly where
 * it hurts. A sheet checkbox becomes a two-option select (see from-sheet, and the permit that
 * vanished at 13125 Moraine Rd), so the answer on the wire is now the string "Yes" or "No". Fed
 * back through the sheet's checkbox branch, "No" is a non-empty string, so it coerces to `true` —
 * and a job with no permit gets stored as permitted. One renderer, one coercer, or the two
 * disagree about what a value means.
 *
 * So: the playbook is what renders, the playbook is what coerces, and the sheet stays the storage
 * format it always was.
 */

/** One value, against one need. Unparseable is ALWAYS null — null is visible, a wrong number isn't. */
export function coerceNeed(n: Need, v: unknown): AnswerValue {
  if (v === undefined || v === null || v === "") return null;

  // OPEN — no control, so no type to enforce. It is a sentence, and the only rule is a length cap.
  // He types it himself and Nort fills it in later; both arrive here as the same prose.
  if (!n.slot) {
    const s = String(v).trim();
    return s ? s.slice(0, 8000) : null;
  }

  switch (n.slot.type) {
    case "number":
      // ONE NUMBER PARSER, shared with the box he types into (looseNumber). Two parsers is two
      // answers: stripping every non-digit turned "16 and 20" into 1620 and "$85–95/hr" into 8595,
      // while the client's box read the same strings as 16 and 85. A number that means one thing
      // on screen and another in the row is the worst kind of wrong, because nothing looks broken.
      // looseNumber also holds the law that matters here: no digits means null, never 0.
      return looseNumber(v);
    case "select": {
      const opts = n.slot.options;
      const multi = !!n.slot.multi;
      // A boolean is what the OLD checkbox renderer wrote. Map it rather than reject it — refusing
      // it would null a real answer on the next autosave, which is a regression that erases data
      // while looking like nothing happened.
      const raw: unknown[] = typeof v === "boolean" ? [v ? "Yes" : "No"] : Array.isArray(v) ? v : [v];
      const picked = raw.map(String).filter((x) => opts.includes(x));
      if (!picked.length) return null;
      // A multi slot always stores an array (even of one), a single slot always stores a scalar —
      // so downstream never has to ask which shape it got.
      return multi ? picked : picked[0];
    }
    default:
      return String(v).slice(0, n.slot.long ? 8000 : 500);
  }
}

/**
 * Coerce a whole payload, DROPPING every key the playbook doesn't declare.
 *
 * Answers are written from a client form and the row is reachable through PostgREST, so accepting
 * unknown keys would let a crafted payload stuff arbitrary jsonb onto the appointment.
 */
export function coerceByPlaybook(pb: Playbook, input: unknown): Answers {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Answers = {};
  for (const n of pb.needs) out[n.key] = coerceNeed(n, src[n.key]);
  return out;
}

/** One answer as a person would say it. An array is a list, because "outlets AND lights" is one answer. */
export function answerText(v: AnswerValue): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/**
 * What the estimator is TOLD, as given facts rather than something to re-derive.
 *
 * Applicable needs only: an answer to a need that no longer applies is stale by definition, and a
 * stale measurement handed over as a given is the exact failure the resolver exists to prevent.
 */
export function factsForEstimator(pb: Playbook, answers: Answers): string {
  // CLEAR TO A FIXED POINT FIRST. applicableNeeds is ONE pass: with work="Troubleshoot" it
  // correctly drops power_source, but a stale power_source value keeps `feed` applicable, and a
  // stale feed keeps run_ft applicable — so a 25-ft feeder from an abandoned branch was handed to
  // the estimator labelled MEASURED ON SITE. Only clearInapplicable's fixed point walks the whole
  // chain. Every other boundary in this file already does this; this one read path didn't.
  answers = clearInapplicable(pb, answers);

  const lines: string[] = [];
  for (const n of applicableNeeds(pb, answers)) {
    const t = answerText(answers[n.key]);
    if (t.trim()) lines.push(`- ${n.label}: ${t}`);
  }
  return lines.join("\n");
}
