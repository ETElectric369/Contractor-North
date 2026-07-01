import { z } from "zod";
import { createCustomer, patchCustomer } from "@/app/(app)/crm/actions";
import type { ActionDef } from "../types";

export const customerActions: Record<string, ActionDef> = {
  "customer.create": {
    name: "customer.create",
    group: "customer",
    label: "Add customer",
    description:
      "Create a contact record. Speech mangles names, so CONFIRM the spelling with the user before calling this (read it back, or have them spell a tricky one). Name + whatever else was given — phone, email, company, address/city/state/zip, notes. Set type to 'subcontractor' for a sub / supplier / inspector (vs a residential/commercial/industrial client) so they can be linked to jobs.",
    // Fragment-first: the columns are all nullable and createCustomer already reads every
    // one of these — the old 3-field schema silently DROPPED a spoken address/email.
    input: z.object({
      name: z.string().min(1),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      company_name: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      zip: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      type: z.enum(["residential", "commercial", "industrial", "subcontractor"]).optional(),
    }),
    auth: "staff",
    effect: "write",
    // Reuse the canonical createCustomer (phone/state/zip formatting, defaults) via a FormData.
    handler: (i) => {
      const fd = new FormData();
      fd.set("name", i.name);
      if (i.phone) fd.set("phone", i.phone);
      if (i.email) fd.set("email", i.email);
      if (i.company_name) fd.set("company_name", i.company_name);
      if (i.address) fd.set("address", i.address);
      if (i.city) fd.set("city", i.city);
      if (i.state) fd.set("state", i.state);
      if (i.zip) fd.set("zip", i.zip);
      if (i.notes) fd.set("notes", i.notes);
      if (i.type) fd.set("type", i.type);
      return createCustomer(fd);
    },
  },
  "customer.update": {
    name: "customer.update",
    group: "customer",
    label: "Edit customer",
    description:
      "Fix or update a customer you can see — correct a MISSPELLED name, add a phone/email/address, change the type (e.g. to 'subcontractor'), etc. Pass the customer's id (from list_customers) and ONLY the fields to change. Use this when a name came out wrong; never tell the user you can't fix it.",
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
      type: z.enum(["residential", "commercial", "industrial", "subcontractor"]).optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: ({ id, ...patch }) => patchCustomer(id, patch),
  },
};
