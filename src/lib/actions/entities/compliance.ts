import { z } from "zod";
import { createCompliance } from "@/app/(app)/compliance/actions";
import type { ActionDef } from "../types";

export const complianceActions: Record<string, ActionDef> = {
  "compliance.create": {
    name: "compliance.create",
    group: "compliance",
    label: "Log compliance item",
    description:
      "Log an insurance policy, license, or bond — 'log our new $2M general liability policy, #ABC123, expires next March'. name is required; type defaults to Insurance; dates are YYYY-MM-DD. So a lapsing policy / license never goes unnoticed.",
    input: z.object({
      name: z.string().min(1),
      type: z.string().optional(),
      policy_number: z.string().nullable().optional(),
      amount: z.number().optional(),
      issued_date: z.string().nullable().optional(),
      expires_date: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) =>
      createCompliance({
        name: i.name,
        type: i.type,
        policy_number: i.policy_number ?? null,
        amount: i.amount,
        issued_date: i.issued_date ?? null,
        expires_date: i.expires_date ?? null,
        notes: i.notes ?? null,
      }),
  },
};
