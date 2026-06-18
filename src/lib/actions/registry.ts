import type { ActionDef } from "./types";
import { billActions } from "./entities/bill";
import { taskActions } from "./entities/task";
import { inquiryActions } from "./entities/inquiry";
import { appointmentActions } from "./entities/appointment";
import { jobActions } from "./entities/job";
import { organizeActions } from "./entities/organize";

// THE registry. Every capability is one named entry. New entity files get spread
// in here; UI buttons, voice, and (later) Claude chat tools all resolve through it,
// so adding an action makes it available to every surface at once.
export const REGISTRY: Record<string, ActionDef> = {
  ...billActions,
  ...taskActions,
  ...inquiryActions,
  ...appointmentActions,
  ...jobActions,
  ...organizeActions,
};

export function listActions(filter?: { effect?: "read" | "write"; group?: string }): ActionDef[] {
  return Object.values(REGISTRY).filter(
    (a) => (!filter?.effect || a.effect === filter.effect) && (!filter?.group || a.group === filter.group),
  );
}
