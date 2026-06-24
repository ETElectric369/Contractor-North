import { z } from "zod";
import { createCustomer } from "@/app/(app)/crm/actions";
import type { ActionDef } from "../types";

export const customerActions: Record<string, ActionDef> = {
  "customer.create": {
    name: "customer.create",
    group: "customer",
    label: "Add customer",
    description: "Create a customer record with a name and optional phone.",
    input: z.object({ name: z.string().min(1), phone: z.string().nullable().optional() }),
    auth: "staff",
    effect: "write",
    // Reuse the canonical createCustomer (phone formatting, defaults) via a FormData.
    handler: (i) => {
      const fd = new FormData();
      fd.set("name", i.name);
      if (i.phone) fd.set("phone", i.phone);
      return createCustomer(fd);
    },
  },
};
