// The fragment kernel's "what am I missing" engine. A spoken/typed fragment is a valid
// record; the ACTION-level zod schemas in the registry are the single source of truth for
// what a given action still needs. Pure functions, no I/O — every surface (voice form-fill,
// the assistant, the Needs-action inbox) computes readiness from the SAME schemas the
// execute() gate enforces, so "ready" can never drift from "will actually run".

import { REGISTRY } from "./registry";
import { parseActionInput, missingFieldPaths } from "./parse-input";

/** What counts as ABSENT is decided once, in parse-input.ts, beside the one parse that makes it
 *  true (zod 4 words a missing field only through that parse's error map). Re-exported here for
 *  the callers that already read it from readiness. */
export { missingFieldPaths };

/**
 * Run a fragment against an action's input schema: is it ready to execute, and if not,
 * which fields are still missing? `missing` lists only ABSENT required fields — an
 * invalid-but-present value (bad enum, wrong type) makes the fragment not-ready without
 * appearing in `missing`, so a surface can distinguish "ask for it" from "fix it".
 */
export function computeReadiness(
  actionName: string,
  fragment: unknown,
): { ready: boolean; missing: string[] } {
  const def = REGISTRY[actionName];
  if (!def) return { ready: false, missing: [] }; // unknown action can never be ready
  const parsed = parseActionInput(def.input, fragment ?? {});
  if (parsed.success) return { ready: true, missing: [] };
  return { ready: false, missing: missingFieldPaths(parsed.error) };
}
