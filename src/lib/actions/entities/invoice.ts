import { z } from "zod";
import {
  createInvoiceFromQuote,
  addInvoiceItem,
  updateInvoiceItem,
  deleteInvoiceItem,
  recordPayment,
  setPaymentSchedule,
  requestNextPayment,
} from "@/app/(app)/billing/actions";
import { createInvoiceForJob } from "@/app/(app)/jobs/actions";
import type { ActionDef } from "../types";

// The "money loop by voice" (CIB audit Phase 2): the assistant readies a DRAFT invoice
// for the user — pulls the job's labor + materials, makes adjustments — and the user taps
// the big Send button themselves. Every handler wraps an EXISTING, tested server action
// (auth + RLS + recalc live there). Draft create/edit is tier-1 (reversible, nothing sent,
// no money moved) so it runs straight through; recording a received PAYMENT touches money,
// so it's confirm-gated (propose → spoken "yes" → run). Sending / refunding / deleting an
// invoice are deliberately NOT here — those stay the user's tap.
export const invoiceActions: Record<string, ActionDef> = {
  "invoice.fromJob": {
    name: "invoice.fromJob",
    group: "invoice",
    label: "Create invoice from job",
    description:
      "Create a DRAFT invoice for a job, PRE-FILLED with the job's logged labor (hours × rate) and materials (POs/bills, marked up). This is the 'get the invoice ready' action — use it when the user wants to invoice a job from the field. Resolve the job first with list_jobs and pass its id (check list_invoices first if you're not sure one already exists). Returns the new invoice's id — then read it back with get_invoice, make any adjustments with invoice.addItem/updateItem/deleteItem, and tell the user it's ready to review and SEND. You never send it.",
    input: z.object({ job_id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const r = await createInvoiceForJob(i.job_id);
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true,
        data: { invoice_id: r.id },
        // Don't claim "I pulled in the labor and materials" if an import actually FAILED — say so, so a
        // hands-free tech doesn't send an under-billed invoice thinking everything's on it.
        speak: r.importWarning
          ? `Draft invoice created — but heads up: ${r.importWarning}`
          : "Draft invoice ready — I pulled in any logged labor and materials from the job. Read it back before you send.",
      };
    },
  },
  "invoice.fromQuote": {
    name: "invoice.fromQuote",
    group: "invoice",
    label: "Create invoice from quote",
    description:
      "Turn an accepted QUOTE into a draft invoice (copies its line items). Resolve the quote first with list_quotes and pass its id. Returns the new invoice's id. The invoice is a draft for the user to review and send themselves.",
    input: z.object({ quote_id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const r = await createInvoiceFromQuote(i.quote_id);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, data: { invoice_id: (r as { id?: string }).id }, speak: "Draft invoice created from the quote." };
    },
  },
  "invoice.addItem": {
    name: "invoice.addItem",
    group: "invoice",
    label: "Add an invoice line",
    description:
      "Add ONE line item to a draft invoice. Pass the invoice_id (from get_invoice or a create action) plus the line's description, quantity, unit, and unit_price. After adjusting, read the invoice back with get_invoice so the user can confirm before they send.",
    input: z.object({
      invoice_id: z.string(),
      description: z.string().min(1),
      quantity: z.number().default(1),
      unit: z.string().default("ea"),
      unit_price: z.number().default(0),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const r = await addInvoiceItem(i.invoice_id, {
        description: i.description,
        quantity: i.quantity ?? 1,
        unit: i.unit ?? "ea",
        unit_price: i.unit_price ?? 0,
      });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, speak: `Added "${i.description}".` };
    },
  },
  "invoice.updateItem": {
    name: "invoice.updateItem",
    group: "invoice",
    label: "Edit an invoice line",
    description:
      "Change an existing invoice line (its description, quantity, or price). You need BOTH the line's item_id AND its invoice_id — get them from get_invoice first. Pass the full new description, quantity, and unit_price.",
    input: z.object({
      item_id: z.string(),
      invoice_id: z.string(),
      description: z.string().min(1),
      quantity: z.number().default(1),
      unit_price: z.number().default(0),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const r = await updateInvoiceItem(i.item_id, i.invoice_id, {
        description: i.description,
        quantity: i.quantity ?? 1,
        unit_price: i.unit_price ?? 0,
      });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, speak: "Line updated." };
    },
  },
  "invoice.deleteItem": {
    name: "invoice.deleteItem",
    group: "invoice",
    label: "Remove an invoice line",
    description:
      "Remove a line from a draft invoice. You need both the line's item_id and its invoice_id (from get_invoice). Reversible — you can add it back with invoice.addItem.",
    input: z.object({ item_id: z.string(), invoice_id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const r = await deleteInvoiceItem(i.item_id, i.invoice_id);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, speak: "Line removed." };
    },
  },
  "payment.record": {
    name: "payment.record",
    group: "payment",
    label: "Record a payment",
    description:
      "Record a payment RECEIVED against an invoice (money IN — e.g. 'the Jones job paid me $3,000 by check'). Resolve the invoice first with get_invoice or list_invoices and pass its id. method is check, cash, card, ach, or other. This only RECORDS a received payment against the books; it never moves money. The app asks the user to confirm before it runs.",
    input: z.object({
      invoice_id: z.string(),
      amount: z.number(),
      method: z.string().default("check"),
      note: z.string().default(""),
      paid_at: z.string().nullable().default(null),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: (i) => `Record a ${i.method || "check"} payment of $${i.amount} against this invoice — say yes to confirm.`,
    handler: async (i) => {
      const r = await recordPayment({
        invoice_id: i.invoice_id,
        amount: i.amount,
        method: i.method ?? "check",
        note: i.note ?? "",
        paid_at: i.paid_at ?? null,
      });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, speak: `Recorded a ${i.method ?? "check"} payment of $${i.amount}.` };
    },
  },
  "payment.setSchedule": {
    name: "payment.setSchedule",
    group: "payment",
    label: "Set a draw schedule",
    description:
      "Set a job's PROGRESS-BILLING / draw schedule — the milestones it gets billed in (e.g. '30% deposit, 40% at rough-in, 30% on final'). Resolve the job with list_jobs and pass job_id plus milestones, each with a label and EITHER a percent OR a fixed amount. Can only be set BEFORE any billing starts on the job. Nothing is sent or billed — this just defines the plan.",
    input: z.object({
      job_id: z.string(),
      milestones: z
        .array(
          z.object({
            label: z.string(),
            percent: z.number().nullable().optional(),
            amount: z.number().nullable().optional(),
          }),
        )
        .min(1),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i) => {
      const r = await setPaymentSchedule(i.job_id, i.milestones);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, speak: `Set a ${i.milestones.length}-milestone draw schedule.` };
    },
  },
  "payment.requestNext": {
    name: "payment.requestNext",
    group: "payment",
    label: "Request the next draw",
    description:
      "Draft the NEXT progress payment / draw on a job — the next scheduled milestone for a fixed-bid job with a draw schedule, or the work logged since the last bill for T&M. Resolve the job with list_jobs and pass job_id. It drafts a DRAFT invoice; it never sends. The app asks to confirm first.",
    input: z.object({ job_id: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: () => "Draft the next draw on this job from its schedule (or work-to-date) — say yes to confirm. It won't send.",
    handler: async (i) => {
      const r = await requestNextPayment(i.job_id);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, speak: "Next draw drafted — read it back before sending." };
    },
  },
};
