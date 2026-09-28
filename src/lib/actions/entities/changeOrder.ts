import { z } from "zod";
import { createChangeOrder, updateChangeOrder, setChangeOrderStatus } from "@/app/(app)/change-orders/actions";
import type { ActionDef } from "../types";

// A change order carries a dollar AMOUNT and, once approved, adjusts the job's contract
// value — so it's money-affecting. Create/edit mirror bill.create/update (confirm:"financial",
// no step-up — these RECORD a cost, they don't MOVE money). Approving one is the financial
// commit, so setStatus is gated the same way. Each entry WRAPS the existing server action
// (create/update take FormData); no new business logic here.
// A CHANGE ORDER ALWAYS HAS ITS JOB (W2-12): it lives only on its job's Change Orders tab (there is
// no list page), so create requires the job and update can't touch it. createChangeOrder refuses a
// missing job and updateChangeOrder an empty one, in words, whoever calls them.
export const changeOrderActions: Record<string, ActionDef> = {
  "changeorder.create": {
    name: "changeorder.create",
    group: "changeorder",
    label: "Create change order",
    description:
      "Record a CHANGE ORDER on a job — added/changed scope and its dollar amount, e.g. 'add a $<amount> change order for <the extra work> on the <job> job'. Pass a description (required), amount, and job_id (required: resolve it with list_jobs; a change order lives on its job's Change Orders tab). Starts as pending. The app asks the user to confirm before it runs.",
    input: z.object({
      description: z.string().min(1),
      amount: z.number().optional().default(0),
      job_id: z.string(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: (i) => `Add a $${Number(i.amount ?? 0).toFixed(2)} change order to a job — say yes to confirm. Check the details below.`,
    handler: (i) => {
      const fd = new FormData();
      fd.set("description", i.description);
      fd.set("amount", String(i.amount ?? 0));
      fd.set("job_id", i.job_id);
      return createChangeOrder(fd);
    },
  },
  "changeorder.update": {
    name: "changeorder.update",
    group: "changeorder",
    label: "Edit change order",
    description:
      "Edit a CHANGE ORDER's description or amount. Resolve its id first and pass ONLY the fields to change (an omitted field is left alone). It stays on its job. Edits a money amount, so the app asks the user to confirm before it runs.",
    // A true PATCH: the old .default(0) silently ZEROED the dollar amount whenever an
    // edit didn't repeat it. Omitted = untouched. No job_id: a change order stays on its job.
    input: z.object({
      id: z.string(),
      description: z.string().min(1).optional(),
      amount: z.number().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial", // edits the dollar amount of a money record → tier 2
    handler: (i) => {
      // Only append the keys actually present — updateChangeOrder patches by fd.has().
      const fd = new FormData();
      if (i.description !== undefined) fd.set("description", i.description);
      if (i.amount !== undefined) fd.set("amount", String(i.amount));
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
