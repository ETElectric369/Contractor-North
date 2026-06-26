import type { ActionDef } from "./types";
import { roleCanRun } from "./perms";
import { billActions } from "./entities/bill";
import { taskActions } from "./entities/task";
import { inquiryActions } from "./entities/inquiry";
import { appointmentActions } from "./entities/appointment";
import { customerActions } from "./entities/customer";
import { quoteActions } from "./entities/quote";
import { invoiceActions } from "./entities/invoice";
import { jobActions } from "./entities/job";
import { organizeActions } from "./entities/organize";
import { timeActions } from "./entities/time";
import { permitActions } from "./entities/permit";

// THE registry. Every capability is one named entry. New entity files get spread
// in here; UI buttons, voice, and (later) Claude chat tools all resolve through it,
// so adding an action makes it available to every surface at once.
export const REGISTRY: Record<string, ActionDef> = {
  ...billActions,
  ...taskActions,
  ...inquiryActions,
  ...appointmentActions,
  ...customerActions,
  ...quoteActions,
  ...invoiceActions,
  ...jobActions,
  ...organizeActions,
  ...timeActions,
  ...permitActions,
};

export function listActions(filter?: { effect?: "read" | "write"; group?: string }): ActionDef[] {
  return Object.values(REGISTRY).filter(
    (a) => (!filter?.effect || a.effect === filter.effect) && (!filter?.group || a.group === filter.group),
  );
}

export { actionRisk } from "./risk";
export { roleCanRun };

/** Least privilege (Pillar 2): the actions a given role may run — the set a surface
 *  (command bar / voice / the agent tool-loop) is allowed to even OFFER. Optionally
 *  narrow to writes/reads or a group. The role gate uses the SAME roleCanRun()
 *  predicate that execute() enforces, so the offer and the gate stay in lockstep. */
export function actionsForRole(
  role: string | null | undefined,
  filter?: { effect?: "read" | "write"; group?: string },
): ActionDef[] {
  return listActions(filter).filter((a) => roleCanRun(role, a.auth));
}
