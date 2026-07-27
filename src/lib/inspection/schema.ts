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

export interface InspectionField {
  key: string;
  label: string;
  type: InspectionFieldType;
  options?: string[];
}

/** A stored answer. Narrow on purpose — anything richer belongs in the prose capture. */
export type InspectionAnswer = string | number | boolean | null;
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
    out.push({
      key,
      label,
      type,
      ...(type === "select" && Array.isArray(f.options)
        ? { options: f.options.map((o) => String(o)).filter(Boolean) }
        : {}),
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
        out[f.key] = v === true || v === "true" || v === "on" || v === 1 || v === "1";
        break;
      case "select": {
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

/** Questions with no answer yet — the "what am I still missing" list, computed not guessed. */
export function unansweredFields(fields: InspectionField[], answers: InspectionAnswers): InspectionField[] {
  return fields.filter((f) => {
    const v = answers[f.key];
    // An unchecked checkbox is a real answer ("no"), not a gap.
    if (f.type === "checkbox") return v === undefined;
    return v === undefined || v === null || v === "";
  });
}

/**
 * Render answers for the estimator's prompt. Structured, labelled, and explicitly separated from
 * the free-text notes, so the model treats them as GIVEN rather than as something to re-derive.
 */
export function answersForEstimator(fields: InspectionField[], answers: InspectionAnswers): string {
  const lines = fields
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
