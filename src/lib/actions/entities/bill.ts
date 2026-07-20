import { z } from "zod";
import { createBill, updateBill, deleteBill, setBillStatus } from "@/app/(app)/jobs/actions";
import { createClient } from "@/lib/supabase/server";
import { resolveJobId } from "../resolve-id";
import type { ActionDef } from "../types";

// Each entry just WRAPS the existing server action — no new business logic.
export const billActions: Record<string, ActionDef> = {
  "bill.create": {
    name: "bill.create",
    group: "bill",
    label: "Add supplier bill",
    description: "Record a supplier bill / receipt as a job cost (or company overhead when no job is given).",
    input: z.object({
      job_id: z.string().nullable().optional(),
      supplier: z.string(),
      bill_number: z.string().optional().default(""),
      amount: z.number().optional().default(0),
      status: z.string().optional().default("unpaid"),
      bill_date: z.string().nullable().optional(),
      notes: z.string().optional().default(""),
      category: z.string().nullable().optional(),
      // The PO this bill pays. Set it and the bill supersedes that PO everywhere material
      // cost is summed — the one way to stop a delivery being charged twice (0142).
      po_id: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: (i) =>
      `Add a $${Number(i.amount ?? 0).toFixed(2)} cost${i.supplier ? ` from ${i.supplier}` : ""}` +
      `${i.category ? ` as ${i.category}` : ""}${i.job_id ? " on a job" : ""}${i.notes ? " with a note" : ""}` +
      ` — say yes to confirm. Check the details below.`,
    handler: async (i) => {
      // Forgive a job NAME passed as job_id — resolve to a single match so a cost never lands
      // on the wrong (or a fabricated) job. The amount itself is still user-stated + confirmed.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.job_id ?? null);
      if ("error" in job) return { ok: false, error: job.error };
      return createBill({
        job_id: job.id,
        supplier: i.supplier,
        bill_number: i.bill_number ?? "",
        amount: i.amount ?? 0,
        status: i.status ?? "unpaid",
        bill_date: i.bill_date ?? null,
        notes: i.notes ?? "",
        category: i.category ?? null,
        po_id: i.po_id ?? null,
      });
    },
  },
  "bill.update": {
    name: "bill.update",
    group: "bill",
    label: "Edit bill",
    description: "Edit a supplier bill's supplier, amount, bill number, date, status, category or notes.",
    input: z.object({
      id: z.string(),
      supplier: z.string().optional(),
      bill_number: z.string().nullable().optional(),
      amount: z.number().optional(),
      status: z.string().optional(),
      bill_date: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
      job_id: z.string().nullable().optional(),
      // Linking/unlinking the PO this bill pays MOVES the job's material cost (a linked
      // PO stops counting — the bill supersedes it), hence the financial confirm tier.
      po_id: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial", // edits the amount/status of a money record → tier 2
    handler: ({ id, ...patch }) => updateBill(id, patch),
  },
  "bill.setStatus": {
    name: "bill.setStatus",
    group: "bill",
    label: "Mark bill paid/unpaid",
    description: "Set a supplier bill's paid/unpaid status.",
    input: z.object({ id: z.string(), status: z.string(), job_id: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "financial", // flips a bill paid/unpaid → tier 2
    handler: (i) => setBillStatus(i.id, i.status, i.job_id),
  },
  "bill.delete": {
    name: "bill.delete",
    group: "bill",
    label: "Delete bill",
    description: "Delete a supplier bill.",
    input: z.object({ id: z.string(), job_id: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "destructive",
    handler: (i) => deleteBill(i.id, i.job_id),
  },
};
