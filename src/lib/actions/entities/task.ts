import { z } from "zod";
import { toggleTask, updateTask, deleteTask } from "@/app/(app)/tasks/actions";
import type { ActionDef } from "../types";

// Seeded so the dispatch.ts inbox switchboard can migrate onto the registry next.
export const taskActions: Record<string, ActionDef> = {
  "task.complete": {
    name: "task.complete",
    group: "task",
    label: "Mark task done",
    description: "Mark a task done (set done=false to reopen it).",
    input: z.object({ id: z.string(), done: z.boolean().default(true) }),
    auth: "any",
    effect: "write",
    handler: (i) => toggleTask(i.id, i.done),
  },
  "task.setDue": {
    name: "task.setDue",
    group: "task",
    label: "Reschedule task",
    description: "Set or clear a task's due date (YYYY-MM-DD, or null to clear).",
    input: z.object({ id: z.string(), due_date: z.string().nullable() }),
    auth: "any",
    effect: "write",
    handler: (i) => updateTask(i.id, { due_date: i.due_date }),
  },
  "task.assign": {
    name: "task.assign",
    group: "task",
    label: "Assign task",
    description: "Assign a task to a person (profile id), or null to unassign.",
    input: z.object({ id: z.string(), assigned_to: z.string().nullable() }),
    auth: "any",
    effect: "write",
    handler: (i) => updateTask(i.id, { assigned_to: i.assigned_to }),
  },
  "task.delete": {
    name: "task.delete",
    group: "task",
    label: "Delete task",
    description: "Delete a task.",
    input: z.object({ id: z.string() }),
    auth: "any",
    effect: "write",
    confirm: "destructive",
    handler: (i) => deleteTask(i.id),
  },
};
