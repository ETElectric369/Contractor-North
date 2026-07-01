// The fragment kernel's "what am I missing" engine. A spoken/typed fragment is a valid
// record; the ACTION-level zod schemas in the registry are the single source of truth for
// what a given action still needs. Pure functions, no I/O — every surface (voice form-fill,
// the assistant, the Needs-action inbox) computes readiness from the SAME schemas the
// execute() gate enforces, so "ready" can never drift from "will actually run".

import type { z } from "zod";
import { REGISTRY } from "./registry";

/** Dot-joined paths of the fields a zod failure says are ABSENT (required but not
 *  provided) — not merely invalid. Zod 3 reports an absent required field as an
 *  invalid_type issue with received "undefined" (message "Required"); custom
 *  superRefine issues use the same "Required" message to mean the same thing. */
export function missingFieldPaths(error: z.ZodError): string[] {
  const paths = error.issues
    .filter(
      (i) =>
        (i.code === "invalid_type" && (i as { received?: string }).received === "undefined") ||
        i.message === "Required",
    )
    .map((i) => i.path.join("."))
    .filter(Boolean);
  return [...new Set(paths)];
}

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
  const parsed = def.input.safeParse(fragment ?? {});
  if (parsed.success) return { ready: true, missing: [] };
  return { ready: false, missing: missingFieldPaths(parsed.error) };
}
