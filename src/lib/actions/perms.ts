import type { ActionAuth } from "./types";

const STAFF_ROLES = ["owner", "admin", "office"];

/** The one predicate behind least privilege (agent-security framework Pillar 2):
 *  can a caller of this role run an action with this auth gate? Used BOTH to enforce
 *  at execute() time AND to filter which actions are even offered to a surface
 *  (command bar / voice / agent), so the gate and the offer can never drift apart.
 *  Pure (no server imports) so it stays unit-testable. */
export function roleCanRun(role: string | null | undefined, auth: ActionAuth): boolean {
  if (auth === "any") return true; // any authenticated user
  const isStaff = !!role && STAFF_ROLES.includes(role);
  if (auth === "staff") return isStaff;
  if (auth === "owner") return role === "owner";
  return false;
}
