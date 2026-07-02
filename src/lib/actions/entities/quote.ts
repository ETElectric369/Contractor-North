import { z } from "zod";
import { saveQuote, addQuoteItem, updateQuoteItem, deleteQuoteItem, createJobFromQuote, updateQuoteStatus, setQuoteType, updateQuoteMeta, setQuoteCustomer, setQuoteJob, findRecentDraftQuote, duplicateQuote } from "@/app/(app)/quotes/actions";
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
  "quote.setType": {
    name: "quote.setType",
    group: "quote",
    label: "Estimate or fixed-price",
    description:
      "Switch a document between an ESTIMATE (time & materials — the default) and a fixed-price QUOTE — 'make the Miller estimate a fixed-price quote'. Pass the id (from list_quotes, which shows the current doc_type) and doc_type: 'estimate' or 'quote'.",
    input: z.object({ id: z.string(), doc_type: z.enum(["estimate", "quote"]) }),
    auth: "staff",
    effect: "write",
    handler: (i) => setQuoteType(i.id, i.doc_type),
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
      "Change an existing quote line — 'bump the panel line to $1,800'. You need BOTH the line's item_id AND its quote_id — get them from get_quote first. Pass ONLY the fields to change (description / quantity / unit / unit_price); anything you omit stays as it is.",
    // A true PATCH: an omitted field must never touch the column (the old defaults
    // silently reset quantity to 1 / price to $0 on a "just bump the price" call).
    input: z.object({
      item_id: z.string(),
      quote_id: z.string(),
      description: z.string().min(1).optional(),
      quantity: z.number().optional(),
      unit: z.string().optional(),
      unit_price: z.number().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: ({ item_id, quote_id, ...patch }) => updateQuoteItem(item_id, quote_id, patch),
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
  "quote.update": {
    name: "quote.update",
    group: "quote",
    label: "Edit quote header",
    description:
      "Edit a quote/estimate's HEADER fields — title, notes, tax rate, and valid-until — 'rename the Jones estimate and set it to expire July 31'. Resolve the quote with list_quotes or get_quote and pass its id, plus ONLY the fields to change (an omitted field is left alone). tax_rate is a FRACTION, not a percent (8.25% = 0.0825); valid_until is YYYY-MM-DD or null to clear. Reversible draft edit — line items are edited with quote.addItem/updateItem/deleteItem.",
    // A true PATCH: the old .default("")/.default(0) wiped the title, notes, tax rate
    // and expiry of any field the caller didn't repeat. Omitted = untouched.
    input: z.object({
      id: z.string(),
      title: z.string().optional(),
      notes: z.string().optional(),
      tax_rate: z.number().optional(),
      valid_until: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: ({ id, ...patch }) => updateQuoteMeta(id, patch),
  },
  "quote.setCustomer": {
    name: "quote.setCustomer",
    group: "quote",
    label: "Set quote customer",
    description:
      "Change a saved quote's CUSTOMER — 'attach the Miller estimate to the new Miller customer'. Resolve the quote with list_quotes and the customer with list_customers, then pass the quote id and customer_id (or an explicit null to detach). Reversible draft edit.",
    // customer_id is REQUIRED (nullable): the old .default(null) silently DETACHED the
    // customer whenever the field was omitted. Now omitting it asks instead of wiping.
    input: z.object({ id: z.string(), customer_id: z.string().nullable() }),
    auth: "staff",
    effect: "write",
    handler: (i) => setQuoteCustomer(i.id, i.customer_id),
  },
  "quote.duplicate": {
    name: "quote.duplicate",
    group: "quote",
    label: "Duplicate quote",
    description:
      "Clone a quote (header + all line items) into a fresh DRAFT titled '… (copy)' — 'copy the Jones estimate so I can tweak it'. Resolve the quote with list_quotes and pass its id. Returns the new quote's id; the copy stands on its own (not tied to the original's job).",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const r = await duplicateQuote(i.id);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, data: { id: r.id }, speak: "Quote duplicated as a new draft." };
    },
  },
  "quote.attachJob": {
    name: "quote.attachJob",
    group: "quote",
    label: "Attach quote to job",
    description:
      "Pin an EXISTING quote/estimate to a job (or null to unpin) — 'leave the estimate with the job'. Resolve both ids first (list_quotes, list_jobs) and pass the uuids, never names. The quote then shows on the job's Quotes tab. Use this instead of re-creating a quote that's already saved.",
    input: z.object({ id: z.string().uuid(), job_id: z.string().uuid().nullable() }),
    auth: "staff",
    effect: "write",
    handler: (i) => setQuoteJob(i.id, i.job_id),
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
    // DB trigger). No auto follow-up task — the "awaiting reply" inbox item on My Day is
    // the follow-up and self-clears. Map its {ok,id} into the ActionResult shape.
    handler: async (i) => {
      // One conversation saved the same estimate three times (E-009/E-010/E-011) because
      // "save it" late in a chat re-fired create. A same-title recent draft IS that document:
      // refuse and steer to the edit verbs so the number the user already heard stays true.
      const dup = await findRecentDraftQuote(i.customer_id ?? null, i.title ?? "");
      if (dup) {
        return {
          ok: false,
          error: `Already saved as ${dup.quote_number ?? "a draft"} ("${dup.title ?? ""}") — do NOT create it again. Update that quote instead: quote.addItem/updateItem/deleteItem for lines, quote.setType, quote.setCustomer, quote.attachJob to pin it to a job. Tell the user it's already saved as ${dup.quote_number ?? "a draft"}.`,
        };
      }
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
