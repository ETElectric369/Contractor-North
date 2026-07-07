import { z } from "zod";
import { createResource } from "@/app/(app)/resources/actions";
import type { ActionDef } from "../types";

export const resourceActions: Record<string, ActionDef> = {
  "resource.create": {
    name: "resource.create",
    group: "resource",
    label: "Save a resource",
    description:
      "Save a contact / reference to the Resources list — a permit office, inspector, supplier, vendor, subcontractor, rental yard, utility, etc. Use this when the user says 'save this number', 'add this to resources', or reads out a business + phone worth keeping. Name is required; include whatever else was given (category, contact_name, phone, email, website, address, notes). Confirm a spoken phone or a tricky name if it's unclear.",
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
    // Reuse the canonical createResource (trims, formats the phone, defaults category "Other").
    handler: (i) => createResource(i),
  },
};
