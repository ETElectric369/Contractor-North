import type { ActionKind, Affordance } from "./types";

/** Where the dispatch came from — flows to the audit log, the confirm gate, and this guard. */
export type DispatchSource = "ui" | "voice" | "agent";

/**
 * THE CREW-WIPE GUARD.
 *
 * `job.assign` documents "empty/null assignee = clear the whole crew" — a deliberate branch
 * written for the AGENT, which passes an intentional null after saying so. From a human surface
 * an empty assignee is never intent: it is the unpicked "— Pick a person —" default sitting under
 * an enabled primary button. Translating it wiped every name off the job and returned ok, and
 * risk.ts exempts source:"ui" from the confirm gate, so nothing asked first.
 *
 * Returns true when the dispatcher must REFUSE rather than translate. Pure so the contract is
 * pinned by tests instead of by a comment; the agent's explicit-clear semantics stay reachable.
 */
export function blocksCrewWipe(
  kind: ActionKind,
  verb: Affordance,
  assignee: string | null | undefined,
  source: DispatchSource,
): boolean {
  return verb === "assign" && kind === "job_to_schedule" && !assignee?.trim() && source !== "agent";
}
