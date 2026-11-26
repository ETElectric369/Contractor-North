// THE ONE PARSE of an action's input (cn-v1196). execute() and computeReadiness() both read a
// fragment through here, so "ready" and "will actually run" can never disagree about which
// fields are absent.
//
// Why it exists: zod 3 reported a required field that was not sent as an invalid_type issue
// carrying received "undefined" and the message "Required", and missingFieldPaths found it by
// that. zod 4 says "Invalid input: expected string, received undefined", carries no `received`
// and keeps the input off the finished issue — so the assistant lost "still need the hours".
// The parse passes ONE per-parse error map that answers "Required" for an absent field and
// nothing else (every other message is zod's own); a schema's own message still wins, as zod 4
// orders them, so a field that carries its own message words only its own check (memory.ts).
// No global z.config: nothing else in the app is touched.
//
// "Absent", exactly as zod 3 counted it (measured over every registry action, cn-v1196): an
// invalid_type issue whose input is undefined, AND an enum whose input is undefined — zod 3
// reported a missing enum as invalid_type, zod 4 reports it as invalid_value. A missing literal
// or union was never "Required" on zod 3 (invalid_literal / invalid_union) and is not here.

import type { z } from "zod";

/** The word an absent field is reported with. superRefine's own "Required" issues (time.ts)
 *  use the same word to mean the same thing. */
export const REQUIRED = "Required";

/** zod 4's per-parse error map: an ABSENT field reads "Required"; anything else falls through
 *  to zod's own words. */
function requiredForAbsent(iss: { code?: string; input?: unknown; inst?: unknown }): string | undefined {
  if (iss.input !== undefined) return undefined;
  if (iss.code === "invalid_type") return REQUIRED;
  const raisedBy = (iss.inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;
  if (iss.code === "invalid_value" && raisedBy === "enum") return REQUIRED;
  return undefined;
}

/** Parse an action's input the one way the registry does. */
export function parseActionInput<T>(schema: z.ZodType<T>, input: unknown): z.ZodSafeParseResult<T> {
  return schema.safeParse(input, { error: requiredForAbsent });
}

/** Dot-joined paths of the fields a failed parseActionInput says are ABSENT (required but not
 *  provided) — not merely invalid. True on zod 4 because the parse above words every absent
 *  field "Required"; a superRefine "Required" issue means the same and is found the same way. */
export function missingFieldPaths(error: z.ZodError): string[] {
  const paths = error.issues
    .filter((i) => i.message === REQUIRED)
    .map((i) => i.path.join("."))
    .filter(Boolean);
  return [...new Set(paths)];
}
