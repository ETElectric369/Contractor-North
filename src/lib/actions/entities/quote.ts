import { z } from "zod";
import { saveQuote } from "@/app/(app)/quotes/actions";
import type { ActionDef } from "../types";

export const quoteActions: Record<string, ActionDef> = {
  "quote.create": {
    name: "quote.create",
    group: "quote",
    label: "Create quote / estimate",
    description:
      "Create a DRAFT quote (estimate) for a customer, with line items. Before calling this you MUST read the whole quote back to the user — every line item with its quantity, unit, and price, plus the total — and get an explicit yes. Never create a quote they haven't confirmed out loud. Resolve the customer first with list_customers and pass its id as customer_id (or null if there's no matching customer yet — you can offer to add one). Prices you propose are STARTING estimates; tell the user to check them against real supplier/labor costs. tax_rate is a FRACTION, not a percent (8.25% = 0.0825; 0 = no tax). It saves as a draft they can review, edit, and send.",
    input: z.object({
      customer_id: z.string().nullable().default(null),
      job_id: z.string().nullable().optional(),
      title: z.string().default(""),
      notes: z.string().default(""),
      tax_rate: z.number().default(0),
      valid_until: z.string().nullable().default(null),
      items: z
        .array(
          z.object({
            description: z.string().min(1),
            quantity: z.number().default(1),
            unit: z.string().default("ea"),
            unit_price: z.number().default(0),
          }),
        )
        .default([]),
    }),
    auth: "staff", // quotes/financials are staff-only (migration 0056)
    effect: "write",
    // Reuse the canonical saveQuote (subtotal/tax/total math, per-org Q- number via the
    // DB trigger, the follow-up task). Map its {ok,id} into the ActionResult shape.
    handler: async (i) => {
      const r = await saveQuote({
        customer_id: i.customer_id ?? null,
        job_id: i.job_id ?? null,
        title: i.title ?? "",
        notes: i.notes ?? "",
        tax_rate: i.tax_rate ?? 0,
        valid_until: i.valid_until ?? null,
        items: i.items ?? [],
      });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, data: { id: r.id }, speak: "Quote saved as a draft." };
    },
  },
};
