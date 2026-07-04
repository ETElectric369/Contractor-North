import type { ActionAuth } from "./types";

/** THE staff role set — owner/admin/office. One definition so the ~28 authorization
 *  sites (page guards, the topbar/nav gate, the agent-tool filter, the push .in() DB
 *  filter) can't drift when a role is added or renamed. Pure (only a type import) so it's
 *  safe to import from server actions, server components, AND client components alike. */
export const STAFF_ROLES = ["owner", "admin", "office"];

/** Is this role staff (owner/admin/office)? The predicate behind every page-level
 *  `viewerIsStaff` / `isStaff` check — null/undefined safe. Pair with STAFF_ROLES (the
 *  raw array) when a query needs `.in("role", …)`. */
export const isStaffRole = (role: string | null | undefined): boolean =>
  !!role && STAFF_ROLES.includes(role);

/** The one predicate behind least privilege (agent-security framework Pillar 2):
 *  can a caller of this role run an action with this auth gate? Used BOTH to enforce
 *  at execute() time AND to filter which actions are even offered to a surface
 *  (command bar / voice / agent), so the gate and the offer can never drift apart.
 *  Pure (no server imports) so it stays unit-testable. */
export function roleCanRun(role: string | null | undefined, auth: ActionAuth): boolean {
  if (auth === "any") return true; // any authenticated user
  const isStaff = isStaffRole(role);
  if (auth === "staff") return isStaff;
  if (auth === "owner") return role === "owner";
  return false;
}
