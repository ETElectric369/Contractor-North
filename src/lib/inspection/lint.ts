import { parseInspectionSchema, visibleFields, type InspectionField } from "./schema";

/**
 * TELL A PERSON THEIR SHEET IS BROKEN, WHILE THEY ARE LOOKING AT IT.
 *
 * TAHOE DECK authored a 16-question deck sheet by hand. Its router offers "Full replacement" and
 * "Resurface (existing frame)"; six of its rules point at "Deck replacement" and "Resurface".
 * Those strings never match, so on six of eight job types the railing footage, the stair counts,
 * the door counts and the shape silently disappeared — no error, no warning, nothing to notice.
 * One of twenty inspections there has any answers on it at all.
 *
 * That is not a person who lacks patience. That is a form that quietly refuses to ask.
 *
 * Nothing validated it, because a `showIf` is just two strings in a jsonb column and a typo in one
 * is indistinguishable from a deliberate rule. So: a linter, run where a sheet is authored and
 * where it is used. Every rule here encodes a failure that has actually happened in this database.
 *
 * DELIBERATELY ADVISORY. It never blocks saving a sheet — a half-built sheet mid-edit is normal,
 * and a validator that refuses to save is a validator people route around.
 */

export type SheetProblemKind =
  | "orphan_rule" // showIf points at a key that doesn't exist
  | "forward_rule" // showIf points at a field defined LATER (can never be satisfied)
  | "unmatchable_value" // showIf value isn't one of the router's options — THE Tahoe Deck bug
  | "dead_branch" // a router option that reveals nothing
  | "wall" // too many questions before the person has said what the job is
  | "no_router"; // nothing conditional at all — every question, every job

export interface SheetProblem {
  kind: SheetProblemKind;
  /** The field the problem is about, when it is about one. */
  key?: string;
  /** Plain English, addressed to the contractor who wrote the sheet — not to a developer. */
  message: string;
  /** true = this silently loses data or hides questions. false = shape advice. */
  severe: boolean;
}

/** How many questions may greet someone before they've said what kind of job it is. */
const OPENING_LIMIT = 3;

export function lintInspectionSheet(raw: unknown): SheetProblem[] {
  const fields: InspectionField[] = parseInspectionSchema(raw);
  const out: SheetProblem[] = [];
  if (fields.length === 0) return out;

  const byKey = new Map(fields.map((f) => [f.key, f]));
  const indexOf = new Map(fields.map((f, i) => [f.key, i]));

  fields.forEach((f, i) => {
    const rule = f.showIf;
    if (!rule) return;

    const target = byKey.get(rule.key);
    if (!target) {
      out.push({
        kind: "orphan_rule",
        key: f.key,
        severe: true,
        message: `“${f.label}” only shows when “${rule.key}” is answered, but there's no question with that name. It will never appear.`,
      });
      return;
    }

    if ((indexOf.get(rule.key) ?? 0) >= i) {
      out.push({
        kind: "forward_rule",
        key: f.key,
        severe: true,
        message: `“${f.label}” depends on “${target.label}”, which comes after it. Move it below.`,
      });
      return;
    }

    // THE TAHOE DECK BUG. Only checkable when the target actually has a fixed option list.
    if (target.type === "select" && target.options?.length) {
      const unknown = rule.in.filter((v) => !target.options!.includes(v));
      if (unknown.length) {
        out.push({
          kind: "unmatchable_value",
          key: f.key,
          severe: true,
          message:
            `“${f.label}” is set to show when “${target.label}” is ${unknown.map((u) => `“${u}”`).join(" or ")} — ` +
            `but that isn't one of the choices. It reads ${target.options!.map((o) => `“${o}”`).join(", ")}. ` +
            `Right now this question never appears for those jobs.`,
        });
      }
    }
  });

  // The opening screen. This is the whole progressive-disclosure argument, checked.
  const opening = visibleFields(fields, {});
  if (opening.length > OPENING_LIMIT) {
    out.push({
      kind: "wall",
      severe: false,
      message:
        `This sheet opens with ${opening.length} questions before anyone has said what kind of job it is. ` +
        `Ask one first, then let the rest appear only when they apply — that's the difference between a form and a wall.`,
    });
  }

  // A router with a dead option: the person picks the thing that describes their job, and the
  // sheet has nothing to ask about it.
  const routerKeys = new Set(fields.filter((f) => f.showIf).map((f) => f.showIf!.key));
  if (routerKeys.size === 0 && fields.length > OPENING_LIMIT) {
    out.push({
      kind: "no_router",
      severe: false,
      message: `Every question on this sheet is asked on every job. Pick one that decides the rest — usually “what kind of work is this?”.`,
    });
  }
  for (const rk of routerKeys) {
    const router = byKey.get(rk);
    if (!router || router.type !== "select" || !router.options?.length) continue;
    for (const opt of router.options) {
      const shown = visibleFields(fields, { [rk]: opt });
      if (shown.length <= opening.length) {
        out.push({
          kind: "dead_branch",
          key: rk,
          severe: false,
          message: `Choosing “${opt}” doesn't bring up any extra questions. Either add some or drop the choice.`,
        });
      }
    }
  }

  return out;
}

/** Just the ones that silently lose questions or answers. */
export function severeSheetProblems(raw: unknown): SheetProblem[] {
  return lintInspectionSheet(raw).filter((p) => p.severe);
}
