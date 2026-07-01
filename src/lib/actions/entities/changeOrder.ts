import { z } from "zod";
import { createChangeOrder, updateChangeOrder, setChangeOrderStatus } from "@/app/(app)/change-orders/actions";
import type { ActionDef } from "../types";

// A change order carries a dollar AMOUNT and, once approved, adjusts the job's contract
// value — so it's money-affecting. Create/edit mirror bill.create/update (confirm:"financial",
// no step-up — these RECORD a cost, they don't MOVE money). Approving one is the financial
// commit, so setStatus is gated the same way. Each entry WRAPS the existing server action
// (create/update take FormData); no new business logic here.
export const changeOrderActions: Record<string, ActionDef> = {
  "changeorder.create": {
    name: "changeorder.create",
    group: "changeorder",
    label: "Create change order",
    description:
      "Record a CHANGE ORDER on a job — added/changed scope and its dollar amount, e.g. 'add a $1,200 change order for the extra circuit on the Miller job'. Pass a description (required), amount, and job_id (resolve with list_jobs). Starts as pending. The app asks the user to confirm before it runs.",
    input: z.object({
      description: z.string().min(1),
      amount: z.number().optional().default(0),
      job_id: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: (i) =>
      `Add a $${Number(i.amount ?? 0).toFixed(2)} change order${i.job_id ? " to a job" : ""} — say yes to confirm. Check the details below.`,
    handler: (i) => {
      const fd = new FormData();
      fd.set("description", i.description);
      fd.set("amount", String(i.amount ?? 0));
      if (i.job_id) fd.set("job_id", i.job_id);
      return createChangeOrder(fd);
    },
  },
  "changeorder.update": {
    name: "changeorder.update",
    group: "changeorder",
    label: "Edit change order",
    description:
      "Edit a CHANGE ORDER's description, amount, or job_id. Resolve its id first and pass ONLY the fields to change (an omitted field is left alone; job_id null unlinks the job). Edits a money amount, so the app asks the user to confirm before it runs.",
    // A true PATCH: the old .default(0) silently ZEROED the dollar amount whenever an
    // edit didn't repeat it (and an omitted job_id unlinked the job). Omitted = untouched.
    input: z.object({
      id: z.string(),
      description: z.string().min(1).optional(),
      amount: z.number().optional(),
      job_id: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial", // edits the dollar amount of a money record → tier 2
    handler: (i) => {
      // Only append the keys actually present — updateChangeOrder patches by fd.has().
      const fd = new FormData();
      if (i.description !== undefined) fd.set("description", i.description);
      if (i.amount !== undefined) fd.set("amount", String(i.amount));
      if (i.job_id !== undefined) fd.set("job_id", i.job_id ?? ""); // "" → null (explicit unlink)
      return updateChangeOrder(i.id, fd);
    },
  },
  "changeorder.setStatus": {
    name: "changeorder.setStatus",
    group: "changeorder",
    label: "Set change order status",
    description:
      "Set a CHANGE ORDER's status — pending, approved, or rejected. Resolve its id first. APPROVING commits its amount to the job's value, so the app asks the user to confirm before it runs.",
    input: z.object({ id: z.string(), status: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "financial", // status→approved commits the amount to the job value → tier 2
    describe: (i) => `Set this change order to "${i.status}" — say yes to confirm.`,
    handler: (i) => setChangeOrderStatus(i.id, i.status),
  },
};
