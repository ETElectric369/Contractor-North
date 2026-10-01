import type { ActionAuth } from "./types";
import type { UserRole } from "@/lib/types";

/**
 * WHO COUNTS AS OFFICE. One answer, and a new seat cannot be added without giving one (W2).
 *
 * The list was consolidated once and five hand-written copies grew back: saveSetup, the playbook
 * writer, the voice-invite notice, the dock's staff gate and the new-lead email each spelled
 * ["owner", "admin", "office"] again. They all agreed, which is why nobody noticed — until the one
 * time they did not, and a staff member saved a labour rate and markups, got a green "Saved", and
 * nothing was written, because the app let her through a door the database then refused.
 *
 * This Record is exhaustive over UserRole, so adding a seat STOPS COMPILING until somebody says
 * whether that seat is office. A new role can no longer be half-admitted: in the dock but not in
 * saveSetup, or told about leads but unable to answer them.
 *
 * The DATABASE keeps its own answer (is_org_staff / is_staff) and must: RLS is the write boundary,
 * and a crafted PostgREST call never passes through this file. The two are not merged — they are
 * pinned to each other by src/lib/office-roles.test.ts, which fails the moment either moves alone.
 */
const OFFICE_BY_ROLE: Record<UserRole, boolean> = {
  owner: true,
  admin: true,
  office: true,
  /** A tech is on the job, not in the office: no prices, no settings, no money. */
  tech: false,
};

/** THE staff role set — owner/admin/office — derived from the one Record above, so the ~28
 *  authorization sites (page guards, the topbar/nav gate, the agent-tool filter, the push and
 *  notification `.in("role", …)` filters) read one list. Pure (only type imports) so it's safe to
 *  import from server actions, server components, AND client components alike. */
export const STAFF_ROLES: string[] = (Object.keys(OFFICE_BY_ROLE) as UserRole[]).filter((r) => OFFICE_BY_ROLE[r]);

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
