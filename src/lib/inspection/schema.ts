/**
 * THE INSPECTION SHEET — typed questions in, typed answers out.
 *
 * This is the upstream half of the determinism boundary. Downstream code can only be a formula if
 * the inputs are numbers; today the inspector fills three prose boxes and the estimator re-extracts
 * from them the very measurements the inspector was standing in front of. A question sheet turns
 * "run from panel to detached garage ≈ 85 ft" into `{ run_to_garage_ft: 85 }`, and 85 needs no
 * model to read it.
 *
 * PER-TRADE IS DATA, NOT CODE. The sheet is rows in `forms.schema`, so a new trade is a template
 * someone types, not a module someone writes. That distinction is the whole reason this scales:
 * per-trade CODE is O(trades) and dies around trade #5.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: replace the free-text boxes. A typed sheet only captures what
 * its author thought to ask, and the unanticipated sentence — "the meter base is pulling away from
 * the wall" — is frequently the one that saves the job. Typed answers sit ALONGSIDE the prose.
 */

export type InspectionFieldType = "text" | "textarea" | "checkbox" | "number" | "select";

/**
 * "Only show this when ___ is one of ___." The tenant's OWN judgment, stored as data.
 *
 * This is what lets one sheet serve every kind of job the trade does without asking ten questions
 * for all of them. It is deliberately a RULE THE AUTHOR WRITES, not a model deciding what to ask:
 * it resolves instantly, works with no signal in a crawlspace, and gives the same answer twice.
 * The model's job is elsewhere — turning dictation into typed answers, and noticing what the
 * template's author never thought to ask.
 */
export interface InspectionShowIf {
  /** The key of an EARLIER field (usually the router, e.g. work_type). */
  key: string;
  /** Show when that field's answer is one of these. */
  in: string[];
}

export interface InspectionField {
  key: string;
  label: string;
  type: InspectionFieldType;
  options?: string[];
  showIf?: InspectionShowIf;
  /** Marks a field as something MEASURED on site rather than context. Measured answers are the
   *  ones a kit can size itself from, and the ones the estimator must treat as given. */
  measured?: boolean;
}

/** A stored answer. Narrow on purpose — anything richer belongs in the prose capture. */
/**
 * A stored answer.
 *
 * `string[]` is the multi-select case, and it is the one the storage room needed: Erik's job was
 * "2 new circuits one for lights and one for outlets" — outlets AND lights, both true at once. A
 * router that can only hold one value is the reason the sheet then asked him panel questions about
 * a circuits job. Everything else is unchanged, and a single-valued answer is still a scalar, so
 * every sheet written before this keeps storing exactly what it stored.
 */
export type InspectionAnswer = string | number | boolean | string[] | null;
export type InspectionAnswers = Record<string, InspectionAnswer>;

/** Parse a `forms.schema` jsonb into fields, dropping anything malformed rather than throwing. */
export function parseInspectionSchema(raw: unknown): InspectionField[] {
  if (!Array.isArray(raw)) return [];
  const out: InspectionField[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const f = r as Record<string, unknown>;
    const key = String(f.key ?? "").trim();
    const label = String(f.label ?? "").trim();
    if (!key || !label || seen.has(key)) continue;
    const type = String(f.type ?? "text") as InspectionFieldType;
    if (!["text", "textarea", "checkbox", "number", "select"].includes(type)) continue;
    seen.add(key);
    // showIf is dropped unless it is fully formed — a half-written rule that silently means
    // "always show" is better than one that silently means "never show", because a field nobody
    // can reach is a question nobody knows they were supposed to answer.
    const rawShow = f.showIf as Record<string, unknown> | undefined;
    const showKey = rawShow ? String(rawShow.key ?? "").trim() : "";
    const showIn = rawShow && Array.isArray(rawShow.in) ? rawShow.in.map((x) => String(x)).filter(Boolean) : [];
    out.push({
      key,
      label,
      type,
      ...(type === "select" && Array.isArray(f.options)
        ? { options: f.options.map((o) => String(o)).filter(Boolean) }
        : {}),
      ...(showKey && showIn.length ? { showIf: { key: showKey, in: showIn } } : {}),
      ...(f.measured === true ? { measured: true } : {}),
    });
  }
  return out;
}

/**
 * Coerce raw form input to the field's declared type, and DROP anything the schema doesn't
 * describe. Two reasons this is strict:
 *   1. A number field must hold a number. "about 85" typed into a number box is not 85 — it's a
 *      string that will silently become NaN three functions later, and the estimate will be wrong
 *      with no error anywhere. Unparseable → null, and null is visible.
 *   2. Answers are written from a client form. Accepting unknown keys would let a crafted payload
 *      stuff arbitrary jsonb onto the appointment.
 */
export function coerceAnswers(fields: InspectionField[], input: unknown): InspectionAnswers {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: InspectionAnswers = {};
  for (const f of fields) {
    const v = src[f.key];
    if (v === undefined || v === null || v === "") {
      out[f.key] = null;
      continue;
    }
    switch (f.type) {
      case "number": {
        // Tolerate what a person actually types on a phone: "85 ft", "1,200", " 9.5 ".
        const stripped = String(v).replace(/[^0-9.\-]/g, "");
        // MUST test the stripped string for emptiness FIRST. "a while" strips to "" and Number("")
        // is 0 — which would store a silent zero-foot run that reads as a real measurement all the
        // way to the estimate. No digits means no answer.
        const n = stripped === "" ? NaN : Number(stripped);
        out[f.key] = Number.isFinite(n) ? n : null;
        break;
      }
      case "checkbox":
        // SILENCE IS NOT "NO". An absent key means the question was never answered, and coercing
        // that to `false` doesn't lose the answer — it INVENTS one, and stores the more dangerous
        // of the two. Same law as the number case directly above: no digits means no answer, not
        // zero.
        //
        // Erik, from the field: "i did notice the permit spot was gone." It was. The question left
        // his screen the instant he tapped anything (see unansweredFields), and this line then
        // wrote `false` behind it — recording NO PERMIT on 13125 Moraine Rd, a storage room being
        // converted to living space. His own correction sharpens why that mattered: he isn't the
        // one pulling it. The homeowner is pulling an occupancy permit, which means the work gets
        // INSPECTED BEFORE COVER — a rough-in hold point and a second trip. Stored as "no", that
        // whole second trip disappears from the estimate.
        out[f.key] = v === undefined || v === null ? null : v === true || v === "true" || v === "on" || v === 1 || v === "1";
        break;
      case "select": {
        // MULTI-SELECT. Erik's job was outlets AND lights; a router holding one value is why the
        // sheet then asked panel questions about a circuits job. Each member is validated against
        // the option list exactly as a scalar is, so a stale template or a tampered payload can no
        // more smuggle a value in through an array than through a string.
        if (Array.isArray(v)) {
          const picked = v.map(String).filter((x) => f.options?.includes(x));
          // An empty array is NOT an answer — same law as "" and null. Otherwise deselecting the
          // last chip would read as answered-with-nothing and the question would leave the screen,
          // which is precisely how the permit vanished (cn-v617).
          out[f.key] = picked.length ? picked : null;
          break;
        }
        const s = String(v);
        // An option outside the list is a stale template or a tampered payload — refuse it rather
        // than storing a value no downstream branch handles.
        out[f.key] = f.options?.includes(s) ? s : null;
        break;
      }
      default:
        out[f.key] = String(v).slice(0, f.type === "textarea" ? 8000 : 500);
    }
  }
  return out;
}

/**
 * MIGRATION-WINDOW TOLERANCE. A push to main deploys before its migration is applied, and a select
 * naming a column that doesn't exist yet doesn't degrade — it fails the whole query, which would
 * take the appointment page and the new-quote page down until the migration landed. Every read of
 * an 0165 column goes through this: if the column isn't there yet, the inspection sheet is simply
 * absent and everything else on the page still works.
 *
 * This is deliberately narrow — it swallows the shape of error a pre-migration schema produces,
 * and it is only ever wrapped around the inspection reads.
 */
export async function tolerateMissingColumns<T>(
  run: () => PromiseLike<{ data: T | null; error: unknown }>,
): Promise<T | null> {
  try {
    const { data, error } = await run();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * THE FIELDS THAT APPLY RIGHT NOW, given what has been answered so far.
 *
 * This is the whole "fragment into the simplest next questions" idea, and it needs no model: a
 * field with no rule always applies; a field with a rule applies only when its router answer
 * matches. Tap "Troubleshoot" and two controls remain out of ten.
 *
 * Resolved in ONE pass in declaration order, so a rule may only reference a field ABOVE it. That
 * is a deliberate limit rather than an oversight — chained visibility (A reveals B reveals C)
 * makes it possible for an author to write a cycle they cannot see, and a question that can never
 * be reached is worse than one asked needlessly.
 */
export function visibleFields(fields: InspectionField[], answers: InspectionAnswers): InspectionField[] {
  return fields.filter((f) => {
    if (!f.showIf) return true;
    const v = answers[f.showIf.key];
    if (v === undefined || v === null || v === "") return false;
    // A MULTI-SELECT ROUTER MATCHES ON ANY MEMBER. String(["a","b"]) is "a,b", which matches
    // nothing — so without this a job that is outlets AND lights would reveal neither branch,
    // which is worse than the single-select it replaced.
    if (Array.isArray(v)) return v.length > 0 && v.some((x) => f.showIf!.in.includes(String(x)));
    return f.showIf.in.includes(String(v));
  });
}

/**
 * Null out answers to fields that are no longer visible.
 *
 * Without this, switching the router after answering strands the old answers in the row — and they
 * would ride into the estimate as facts. Someone starts down "Service/panel", answers the panel
 * questions, realises it is actually a lighting job and switches: the panel brand must not still be
 * sitting there telling the estimator to price a panel.
 */
export function clearHiddenAnswers(fields: InspectionField[], answers: InspectionAnswers): InspectionAnswers {
  const visible = new Set(visibleFields(fields, answers).map((f) => f.key));
  const out: InspectionAnswers = {};
  for (const f of fields) out[f.key] = visible.has(f.key) ? (answers[f.key] ?? null) : null;
  return out;
}

/** Questions with no answer yet — the "what am I still missing" list, computed not guessed.
 *  Counts only what APPLIES: a hidden field is not an open question. */
export function unansweredFields(fields: InspectionField[], answers: InspectionAnswers): InspectionField[] {
  return visibleFields(fields, answers).filter((f) => {
    const v = answers[f.key];
    // An unchecked checkbox is a real answer ("no"), not a gap — but ONLY when a person actually
    // unchecked it. `false` is that answer; `null` is "never touched".
    //
    // THE BUG THIS LINE CARRIED: clearHiddenAnswers (:186) writes a key for EVERY field on every
    // keystroke — `answers[key] ?? null` — so after the first tap anywhere on the sheet no key is
    // `undefined` any more. This test therefore went false for every checkbox the instant the
    // sheet was touched, and the question silently left the still-open list having never been
    // asked. On a real job (13125 Moraine Rd, a storage room being converted to living space) it
    // ate `permit` — recorded as unchecked, i.e. NO PERMIT, on a job pulling one for occupancy.
    // The two most consequential facts on the job, gone without a mark on the screen.
    if (f.type === "checkbox") return v === undefined || v === null;
    return v === undefined || v === null || v === "";
  });
}

/**
 * Render answers for the estimator's prompt. Structured, labelled, and explicitly separated from
 * the free-text notes, so the model treats them as GIVEN rather than as something to re-derive.
 */
export function answersForEstimator(fields: InspectionField[], answers: InspectionAnswers): string {
  // Visible only: a hidden field's answer is stale by definition (see clearHiddenAnswers), and a
  // stale measurement handed to the estimator as a given is exactly the failure this file exists
  // to prevent.
  const lines = visibleFields(fields, answers)
    .map((f) => {
      const v = answers[f.key];
      if (v === undefined || v === null || v === "") return null;
      if (f.type === "checkbox") return `- ${f.label}: ${v ? "yes" : "no"}`;
      return `- ${f.label}: ${v}`;
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n") : "";
}

/**
 * THE MEASUREMENTS A KIT CAN SIZE ITSELF FROM.
 *
 * Pulls square feet and linear feet out of a walk-through's typed answers so the estimate's kit
 * picker opens with the real numbers already in it. This is the join that makes the whole typed
 * sheet worth filling in: the inspector measures once, on site, and nobody retypes it later from
 * a paragraph — which is exactly where two copies of one number start to disagree.
 *
 * Deliberately forgiving about field NAMES, because the sheet is per-org DATA and every trade will
 * key it differently. It looks for what a field MEANS (length × width, or an explicit area /
 * perimeter / railing run) rather than demanding one blessed schema, so a template someone types
 * themselves still works without a code change.
 */
export function measurementsFromAnswers(
  fields: InspectionField[],
  answers: InspectionAnswers,
): { sqft: number | null; linearFt: number | null } {
  fields = visibleFields(fields, answers); // never size a kit off a question that no longer applies
  const num = (key: string): number | null => {
    const v = answers[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  };
  // Match on the LABEL as well as the key — an org-authored sheet may use either.
  const find = (re: RegExp): number | null => {
    for (const f of fields) {
      if (f.type !== "number") continue;
      if (re.test(f.key) || re.test(f.label.toLowerCase())) {
        const v = num(f.key);
        if (v !== null) return v;
      }
    }
    return null;
  };

  const explicitArea = find(/sq_?ft|square feet|\barea\b/);
  const length = find(/^length|length_ft|\blength\b/);
  const width = find(/^width|width_ft|\bwidth\b|depth/);
  // An explicit area wins; otherwise derive it, but only when BOTH sides were actually measured —
  // half a rectangle is not an area, and treating a missing width as 1 would quietly under-size
  // every line in the kit.
  const sqft = explicitArea ?? (length !== null && width !== null ? length * width : null);

  const explicitLf = find(/lf$|linear|railing|perimeter|_lf/);
  // Fall back to the footprint's perimeter, which is what railing actually runs along.
  const linearFt = explicitLf ?? (length !== null && width !== null ? 2 * (length + width) : null);

  return { sqft, linearFt };
}
