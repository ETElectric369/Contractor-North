import { z } from "zod";
import { createResource } from "@/app/(app)/resources/actions";
import type { ActionDef } from "../types";

export const resourceActions: Record<string, ActionDef> = {
  "resource.create": {
    name: "resource.create",
    group: "resource",
    label: "Save a resource",
    description:
      "Save a contact / reference to the Resources list — a building department or permit office, an inspector, a permit portal, a utility, the fire marshal or AHJ, an engineer. Use this when the user says 'save this number', 'add this to resources', or reads out one of those worth keeping. Name is required; include whatever else was given (category: Building Department, Inspector, Permit Portal, Utility, Fire / AHJ, Engineer or Other; contact_name, phone, email, website, address, notes). Suppliers and subcontractors are NOT resources: they live in Price List › Vendors (the Vendors tab), and a supplier category is refused. Confirm a spoken phone or a tricky name if it's unclear.",
    input: z.object({
      name: z.string().min(1),
      category: z.string().optional(),
      contact_name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      website: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    // Reuse the canonical createResource (trims, formats the phone, defaults category "Other", and
    // refuses a supplier's or subcontractor's category in the form's own words: nothing silent).
    handler: (i) => createResource(i),
  },
};
