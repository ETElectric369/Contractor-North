import { z } from "zod";
import { createBill, updateBill, deleteBill, setBillStatus } from "@/app/(app)/jobs/actions";
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
    }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    handler: (i) =>
      createBill({
        job_id: i.job_id ?? null,
        supplier: i.supplier,
        bill_number: i.bill_number ?? "",
        amount: i.amount ?? 0,
        status: i.status ?? "unpaid",
        bill_date: i.bill_date ?? null,
        notes: i.notes ?? "",
        category: i.category ?? null,
      }),
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
    }),
    auth: "staff",
    effect: "write",
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
