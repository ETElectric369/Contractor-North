import { z } from "zod";
import { createCustomer, patchCustomer } from "@/app/(app)/crm/actions";
import type { ActionDef } from "../types";

export const customerActions: Record<string, ActionDef> = {
  "customer.create": {
    name: "customer.create",
    group: "customer",
    label: "Add customer",
    description:
      "Create a customer record. Speech mangles names, so CONFIRM the spelling with the user before calling this (read it back, or have them spell a tricky one). Name + optional phone.",
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
  "customer.update": {
    name: "customer.update",
    group: "customer",
    label: "Edit customer",
    description:
      "Fix or update a customer you can see — correct a MISSPELLED name, add a phone/email/address, etc. Pass the customer's id (from list_customers) and ONLY the fields to change. Use this when a name came out wrong; never tell the user you can't fix it.",
    input: z.object({
      id: z.string(),
      name: z.string().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      company_name: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      zip: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: ({ id, ...patch }) => patchCustomer(id, patch),
  },
};
