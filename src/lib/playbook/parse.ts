import { playbookFromSheet } from "./from-sheet";
import { askFromLabel } from "./from-sheet";
import type { Clause, Dimension, Need, NeedSlot, Playbook } from "./types";

/**
 * A stored `forms.playbook` jsonb → a Playbook. TOLERANT, exactly like parseInspectionSchema.
 *
 * This is a document written by an interview, by a starter, or by hand, and it is round-tripped
 * through jsonb where nothing enforces a type. So the parser is the boundary: anything it cannot
 * read is DROPPED, never guessed at and never thrown over. A playbook that fails to parse would
 * take the inspector down at a job site, which is the one place there is no fixing it.
 *
 * WHICH WAY EACH THING DEGRADES IS A DECISION, not an accident — same law as sheetFromPlaybook:
 *
 *   a rule that names an unknown or LATER need   the CLAUSE is dropped, the need survives and
 *                                                becomes unconditional. Showing a question too
 *                                                often is a nuisance; hiding it behind a rule
 *                                                nothing can evaluate is a question nobody knows
 *                                                they were meant to answer, which is how six of
 *                                                Chris's rules came to never match.
 *   a select with no options                     the SLOT is dropped and the need goes OPEN — a
 *                                                box you can type into. An option-less select is
 *                                                unanswerable; a text box is at least answerable.
 *   no key, or a duplicate key                   the NEED is dropped. Two needs on one key means
 *                                                one silently overwrites the other's answer.
 */

const DIMENSIONS: Dimension[] = ["who", "what", "where", "when", "why"];

const str = (v: unknown, cap: number): string => (typeof v === "string" ? v.trim().slice(0, cap) : "");

function parseSlot(raw: unknown): NeedSlot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  switch (s.type) {
    case "number":
      return { type: "number", ...(str(s.unit, 16) ? { unit: str(s.unit, 16) } : {}) };
    case "select": {
      const options = Array.isArray(s.options) ? s.options.map((o) => str(o, 120)).filter(Boolean) : [];
      // No options = nothing to pick. Open is answerable; a select of nothing is not.
      if (!options.length) return undefined;
      return { type: "select", options, ...(s.multi === true ? { multi: true } : {}) };
    }
    case "text":
      return { type: "text", ...(s.long === true ? { long: true } : {}) };
    default:
      return undefined;
  }
}

/** A clause is kept only if it names a need declared ABOVE this one — no cycles, no forward rules. */
function parseClause(raw: unknown, earlier: Set<string>): Clause | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const key = str(c.key, 80);
  if (!key || !earlier.has(key)) return null;
  if (c.unknown === true) return { key, unknown: true };
  if (c.known === true) return { key, known: true };
  const inList = Array.isArray(c.in) ? c.in.map((x) => str(x, 120)).filter(Boolean) : [];
  return inList.length ? { key, in: inList } : null;
}

export function parsePlaybook(raw: unknown): Playbook {
  const needs: Need[] = [];
  const src = Array.isArray(raw) ? raw : (raw as { needs?: unknown } | null)?.needs;
  if (!Array.isArray(src)) return { needs };

  const seen = new Set<string>();
  for (const r of src) {
    if (!r || typeof r !== "object") continue;
    const n = r as Record<string, unknown>;
    const key = str(n.key, 80);
    if (!key || seen.has(key)) continue;

    const label = str(n.label, 120) || key;
    // `ask` is what a person actually encounters, so it can never be blank. If the document
    // didn't carry one, make the same mechanical sentence the sheet conversion would have made.
    const ask = str(n.ask, 300) || askFromLabel(label);
    const when = Array.isArray(n.when)
      ? n.when.map((c) => parseClause(c, seen)).filter((c): c is Clause => c !== null)
      : [];
    const feeds = Array.isArray(n.feeds)
      ? n.feeds.map((f) => str(f, 8)).filter((f): f is Dimension => (DIMENSIONS as string[]).includes(f))
      : [];

    seen.add(key);
    needs.push({
      key,
      label,
      ask,
      ...(parseSlot(n.slot) ? { slot: parseSlot(n.slot) } : {}),
      ...(when.length ? { when } : {}),
      ...(str(n.why, 2000) ? { why: str(n.why, 2000) } : {}),
      ...(n.hold === true ? { hold: true } : {}),
      ...(n.measured === true ? { measured: true } : {}),
      ...(n.photo === true ? { photo: true } : {}),
      ...(feeds.length ? { feeds } : {}),
      ...(str(n.resolvedFrom, 120) ? { resolvedFrom: str(n.resolvedFrom, 120) } : {}),
    });
  }
  return { needs };
}

/**
 * THE ONE READ. Every surface that needs to know what to ask calls this and nothing else.
 *
 * A form with a playbook uses it. A form without one is converted from its sheet, which is what
 * every form in production does today — so this is a no-op until somebody writes a playbook, and
 * the day they do, nothing else has to change.
 */
export function playbookForForm(form: { schema?: unknown; playbook?: unknown } | null | undefined): Playbook {
  const written = parsePlaybook(form?.playbook);
  return written.needs.length ? written : playbookFromSheet(form?.schema);
}
