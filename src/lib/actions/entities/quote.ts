import { z } from "zod";
import { saveQuote, addQuoteItem, updateQuoteItem, deleteQuoteItem, createJobFromQuote, updateQuoteStatus } from "@/app/(app)/quotes/actions";
import type { ActionDef } from "../types";

export const quoteActions: Record<string, ActionDef> = {
  "quote.setStatus": {
    name: "quote.setStatus",
    group: "quote",
    label: "Set quote status",
    description: "Set a quote/estimate's status — 'mark the Jones quote accepted / declined / sent'. Resolve the quote with list_quotes first.",
    input: z.object({ id: z.string(), status: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => updateQuoteStatus(i.id, i.status),
  },
  "quote.convertToJob": {
    name: "quote.convertToJob",
    group: "quote",
    label: "Convert quote to job",
    description: "Turn an accepted QUOTE into a JOB (idempotent — also spins up the work order + material list). Resolve the quote with list_quotes and pass its id. 'Turn the Jones quote into a job.'",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => createJobFromQuote(i.id),
  },
  "quote.addItem": {
    name: "quote.addItem",
    group: "quote",
    label: "Add a quote line",
    description:
      "Add ONE line to an existing quote/estimate — 'add 200ft of 12-gauge at $1.10 to the Jones quote'. Resolve the quote first with list_quotes or get_quote and pass its quote_id, plus the line's description, quantity, unit, and unit_price. Read it back with get_quote after.",
    input: z.object({
      quote_id: z.string(),
      description: z.string().min(1),
      quantity: z.number().default(1),
      unit: z.string().default("ea"),
      unit_price: z.number().default(0),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) => addQuoteItem(i.quote_id, { description: i.description, quantity: i.quantity ?? 1, unit: i.unit ?? "ea", unit_price: i.unit_price ?? 0 }),
  },
  "quote.updateItem": {
    name: "quote.updateItem",
    group: "quote",
    label: "Edit a quote line",
    description:
      "Change an existing quote line (description / quantity / price) — 'bump the panel line to $1,800'. You need BOTH the line's item_id AND its quote_id — get them from get_quote first.",
    input: z.object({
      item_id: z.string(),
      quote_id: z.string(),
      description: z.string().min(1),
      quantity: z.number().default(1),
      unit_price: z.number().default(0),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) => updateQuoteItem(i.item_id, i.quote_id, { description: i.description, quantity: i.quantity ?? 1, unit_price: i.unit_price ?? 0 }),
  },
  "quote.deleteItem": {
    name: "quote.deleteItem",
    group: "quote",
    label: "Remove a quote line",
    description: "Remove a line from a quote — 'drop the permit line'. You need the line's item_id and its quote_id (from get_quote).",
    input: z.object({ item_id: z.string(), quote_id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => deleteQuoteItem(i.item_id, i.quote_id),
  },
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
