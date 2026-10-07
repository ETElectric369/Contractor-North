import { z } from "zod";
import { createBill, updateBill, deleteBill, setBillStatus, correctBill } from "@/app/(app)/jobs/actions";
import { createClient } from "@/lib/supabase/server";
import { resolveJobId } from "../resolve-id";
import type { ActionDef } from "../types";
import { BUSINESS_COST_BUCKETS, bucketOf } from "@/lib/business-cost-buckets";
import type { BillScopeAnswer } from "@/lib/bill-scope";

// Each entry just WRAPS the existing server action — no new business logic.
export const billActions: Record<string, ActionDef> = {
  "bill.create": {
    name: "bill.create",
    group: "bill",
    label: "Add supplier bill",
    description: `Record a supplier bill / receipt as a job cost, or as a business cost when no job is given. A business cost's category is one of: ${BUSINESS_COST_BUCKETS.join(", ")}.`,
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
      // WHICH PART OF THE JOB this cost is (item C1) — one of the job estimate's own scope words
      // ("Framing", "Decking"). Left out, the cost lands under no part of the job and the Costs tab
      // says so; a word this job's estimate hasn't got is refused and names the ones it has.
      scope_category: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    // With no job, the confirmation names the bucket createBill will actually save (bucketOf), not
    // the word Nort happened to pass, so what he says yes to is what lands.
    describe: (i) =>
      `Add a $${Number(i.amount ?? 0).toFixed(2)} cost${i.supplier ? ` from ${i.supplier}` : ""}` +
      `${i.job_id ? `${i.category ? ` as ${i.category}` : ""} on a job` : ` as a Business Cost: ${bucketOf(i.category)}`}${i.notes ? " with a note" : ""}` +
      `. Say yes to confirm. Check the details below.`,
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
        // The same scope question every other door answers. No job means no part of a job; nothing
        // said means nobody was asked, never a guess.
        scope: !job.id ? { kind: "noJob" } : i.scope_category ? { kind: "scope", scope: String(i.scope_category) } : { kind: "notAsked" },
      });
    },
  },
  "bill.update": {
    name: "bill.update",
    group: "bill",
    label: "Edit bill",
    description: `Edit a supplier bill's supplier, amount, bill number, date, status, category or notes. A business cost's (a bill with no job) category is one of: ${BUSINESS_COST_BUCKETS.join(", ")}.`,
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
      // WHICH PART OF THE JOB (item C1): this is how Nort sets or changes it on a cost that already
      // exists. "" or null takes it back off; left out, the stored part is untouched.
      scope_category: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial", // edits the amount/status of a money record → tier 2
    handler: ({ id, scope_category, ...patch }) =>
      updateBill(id, {
        ...patch,
        ...(scope_category !== undefined
          ? { scope: (scope_category ? { kind: "scope", scope: String(scope_category) } : { kind: "none" }) as BillScopeAnswer }
          : {}),
      }),
  },
  // CORRECT THIS BILL (0381): the supplier's later paper for the same purchase, attached UNDER the
  // bill as its own bill with its own lines. The Bills list and the job's Costs tab open it from the
  // bill row. Not offered to Nort (AGENT_WRITE_ALLOWED): a new money write clears the agent-write
  // freeze first. Financial: it adds cost to a job, and the next invoice carries it.
  "bill.correct": {
    name: "bill.correct",
    group: "bill",
    label: "Correct this bill",
    description:
      "Attach the supplier's later paper for the same purchase under an existing bill: its own bill for the difference between what the paper says the purchase comes to and what the bill says, with its own lines. A credit's lines each name a line the bill already has.",
    input: z.object({
      bill_id: z.string(),
      paper_number: z.string(),
      paper_total: z.number(),
      bill_date: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      lines: z.array(z.object({ description: z.string(), amount: z.number().nullable().optional() })).min(1),
      // The supplier's own document the paper IS (task 2): the server checks the document is offered
      // this bill and that the number and total are its own, then ties the correction to it.
      supplier_invoice_id: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial", // adds a cost to a job that the next invoice bills → tier 2
    handler: async (i) => {
      const res = await correctBill({
        billId: i.bill_id,
        paperNumber: i.paper_number,
        paperTotal: i.paper_total,
        billDate: i.bill_date ?? null,
        notes: i.notes ?? null,
        supplierInvoiceId: i.supplier_invoice_id ?? null,
        lines: (i.lines as { description: string; amount?: number | null }[]).map((l) => ({ description: l.description, amount: l.amount ?? null })),
      });
      // ANNOUNCE THE DEED: the sentence is what the database now holds, said back by the surface.
      return res.ok ? { ok: true, data: { id: res.id }, recorded: res.sentence } : { ok: false, error: res.error };
    },
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
