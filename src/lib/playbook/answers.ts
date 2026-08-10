import { looseNumber } from "@/lib/inspection/capture";
import { applicableNeeds, clearInapplicable } from "./resolve";
import type { Answers, AnswerValue, Need, Playbook } from "./types";
import { coerceScopes } from "./scopes";

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
      const all = raw.map(String).map((x) => x.trim()).filter(Boolean);
      const picked = all.filter((x) => opts.includes(x));

      // THE "OTHER" BOX. Without it, a value outside `options` is refused — the right default,
      // because it catches a stale template and a tampered payload both. With it, the question has
      // deliberately said the list isn't exhaustive, so the unlisted answer IS the answer.
      //
      // What's given up is only the closed-set check; what's kept is everything that matters: it
      // is still a trimmed, length-capped string, and a need that never opted in still rejects
      // anything off its list. Erik types into Other constantly, and a paragraph nulled on save
      // because it wasn't one of three chips is the failure mode this whole file exists to stop.
      //
      // THE CAP IS THE OPEN CAP, NOT A CHIP CAP (cn-v698). It was 500, sized for a value that
      // looks like a chip. But the whole reason a question carries `other` is that the listed
      // answers are not exhaustive, and the answer that isn't listed is the PARAGRAPH — Erik's
      // Sara Cain scope is ~700 characters, and the open branch above allows 8000. At 500 the
      // moment a question gained choices its stored answer would be truncated on the next
      // autosave, silently, and factsForEstimator would hand the estimator the short version as
      // fact. One cap, both branches: the shape of the control must not decide how much of what
      // he said survives.
      const free = n.slot.other ? all.filter((x) => !opts.includes(x)).map((x) => x.slice(0, 8000)) : [];

      const kept = multi ? [...picked, ...free].slice(0, 40) : [picked[0] ?? free[0]].filter(Boolean);
      if (!kept.length) return null;
      // A multi slot always stores an array (even of one), a single slot always stores a scalar —
      // so downstream never has to ask which shape it got.
      return multi ? kept : kept[0];
    }
    case "file": {
      // A LIST OF STORAGE PATHS, and nothing else. Never a URL (a signed URL in a jsonb column is
      // a bearer token that outlives its purpose) and never a path from another tenant — the
      // caller-supplied list is filtered against the org prefix at the write boundary, since a
      // hostile client can claim any string it likes here.
      const raw: unknown[] = Array.isArray(v) ? v : [v];
      const paths = raw
        .map((x) => String(x).trim())
        .filter((x) => x && !x.includes("..") && !/^https?:/i.test(x))
        .slice(0, 20);
      return paths.length ? paths : null;
    }
    case "scopes":
      // Shape only. Whether a CODE is really in this org's book is checked at the write boundary,
      // which is the only place the catalogue is known — same split as the file slot's paths.
      return coerceScopes(v);
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

/**
 * WHAT HE ANSWERED BEFORE HE CHANGED THE QUESTION.
 *
 * Erik, looking at 13125 Moraine Rd: "a bunch of info is missing and i found it in the playbook in
 * those questions i deleted."
 *
 * coerceByPlaybook rebuilds the whole map from `pb.needs`, so the moment a question leaves the
 * playbook its ANSWER leaves the appointment — on the next autosave, with no warning and no undo.
 * Editing your questions is not supposed to be a destructive operation on finished site visits. At
 * the time this was found, 725 Granlibakken was holding a real wire list under the retired key
 * `materials_known` and was one keystroke away from losing it.
 *
 * WHY THIS DOESN'T REOPEN THE HOLE THE DROP EXISTS TO CLOSE. The drop is a real defence: this row
 * is writable straight through PostgREST, so honouring unknown keys off the wire would let a
 * crafted payload stuff arbitrary jsonb onto an appointment. So the carry-forward reads the value
 * from the ROW THAT IS ALREADY STORED and ignores the incoming payload entirely. A client cannot
 * introduce a retired key, and cannot change one. It can only fail to delete it.
 *
 * Flattened to text on purpose — the need that gave the value its type is gone, so there is nothing
 * left to validate the shape against, and prose is the one form that can hold any of them.
 */
export function retiredAnswers(pb: Playbook, stored: unknown): Record<string, string> {
  const src = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const declared = new Set(pb.needs.map((n) => n.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (declared.has(k) || !/^[a-z0-9_]{1,60}$/i.test(k)) continue;
    const t = answerText(v as AnswerValue).trim();
    if (t) out[k] = t.slice(0, 8000);
    if (Object.keys(out).length >= 40) break;
  }
  return out;
}

/** "materials_known" → "Materials known". The need that carried a real label is gone. */
export const retiredLabel = (key: string): string => {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

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
  // GRAB THE RETIRED ONES FIRST — clearInapplicable rebuilds from pb.needs, so it strips them.
  const retired = retiredAnswers(pb, answers);
  answers = clearInapplicable(pb, answers);

  const lines: string[] = [];
  for (const n of applicableNeeds(pb, answers)) {
    const t = answerText(answers[n.key]);
    if (!t.trim()) continue;
    // HIS LINE BREAKS ARE HIS STRUCTURE. Erik answered Sara Cain's scope as an eight-line punch
    // list — one item per line, each carrying its own materials and its own minutes: "new white
    // decor switch for bathroom (single pole switch + 30 mins)". The bullet prefixed only the FIRST
    // line, so the other seven arrived unbulleted and unattached, and we then asked a model to
    // reconstruct the structure he had already typed. Indent the continuations so one need stays
    // one bullet and his rows stay rows.
    lines.push(`- ${n.label}: ${t.split("\n").join("\n  ")}`);
  }
  // AND WHAT HE ANSWERED UNDER A QUESTION HE HAS SINCE RETIRED. Preserving it on the row but
  // hiding it from the estimator would be the same loss wearing a better disguise — 725
  // Granlibakken's wire list is a materials line whatever the question that caught it was called.
  for (const [k, t] of Object.entries(retired))
    lines.push(`- ${retiredLabel(k)}: ${t.split("\n").join("\n  ")}`);
  return lines.join("\n");
}
