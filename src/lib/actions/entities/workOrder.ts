import { z } from "zod";
import { createWorkOrder, updateWorkOrder, setWorkOrderStatus } from "@/app/(app)/work-orders/actions";
import type { ActionDef } from "../types";

// A work order is the field crew's instruction sheet — no money, nothing sent. Create/edit
// and status moves are all tier-1 reversible writes (auth:"staff", no confirm). Each entry
// just WRAPS the existing server action; the create/update actions take FormData, so we
// build it the same way job.create does (no new business logic here).
export const workOrderActions: Record<string, ActionDef> = {
  "workorder.create": {
    name: "workorder.create",
    group: "workorder",
    label: "Create work order",
    description:
      "Open a WORK ORDER — the field crew's instruction sheet — e.g. 'create a work order to swap the panel on the Miller job'. Pass a title (required) and optional description, job_id (resolve with list_jobs — the customer is inherited from it), assigned_to (a user id), status (default draft), and scheduled_for (an ISO datetime). Returns the new work order's id.",
    input: z.object({
      title: z.string().min(1),
      description: z.string().nullable().optional(),
      job_id: z.string().nullable().optional(),
      assigned_to: z.string().nullable().optional(),
      status: z.string().optional(),
      scheduled_for: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) => {
      const fd = new FormData();
      fd.set("title", i.title);
      if (i.description) fd.set("description", i.description);
      if (i.job_id) fd.set("job_id", i.job_id);
      if (i.assigned_to) fd.set("assigned_to", i.assigned_to);
      if (i.status) fd.set("status", i.status);
      if (i.scheduled_for) fd.set("scheduled_for", i.scheduled_for);
      return createWorkOrder(fd);
    },
  },
  "workorder.update": {
    name: "workorder.update",
    group: "workorder",
    label: "Edit work order",
    description:
      "Edit a WORK ORDER's core fields — title, description, job_id (customer follows the job), assigned_to, scheduled_for (ISO datetime). Resolve the work order's id first and pass ONLY the fields to change (an omitted field is left alone; an explicit null clears one). Reversible field edit.",
    // A true PATCH: title used to be required and the handler dropped every omitted
    // field from the FormData, which the old updateWorkOrder then WROTE as null —
    // wiping the description/assignee/schedule on any partial edit.
    input: z.object({
      id: z.string(),
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      job_id: z.string().nullable().optional(),
      assigned_to: z.string().nullable().optional(),
      scheduled_for: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) => {
      // Only append the keys actually present — updateWorkOrder patches by fd.has();
      // an explicit null becomes "" which the action stores as null (a clear).
      const fd = new FormData();
      if (i.title !== undefined) fd.set("title", i.title);
      if (i.description !== undefined) fd.set("description", i.description ?? "");
      if (i.job_id !== undefined) fd.set("job_id", i.job_id ?? "");
      if (i.assigned_to !== undefined) fd.set("assigned_to", i.assigned_to ?? "");
      if (i.scheduled_for !== undefined) fd.set("scheduled_for", i.scheduled_for ?? "");
      return updateWorkOrder(i.id, fd);
    },
  },
  "workorder.setStatus": {
    name: "workorder.setStatus",
    group: "workorder",
    label: "Set work order status",
    description:
      "Change a WORK ORDER's status — e.g. draft, scheduled, in progress, complete. Resolve the work order's id first. Operational status (no money), so it's a reversible tier-1 edit.",
    input: z.object({ id: z.string(), status: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => setWorkOrderStatus(i.id, i.status),
  },
};
