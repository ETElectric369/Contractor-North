import { z } from "zod";
import { updateDocument, deleteDocument, markPaperNotACost } from "@/app/(app)/jobs/actions";
import type { ActionDef } from "../types";

// Job documents. Renaming / re-categorizing is a reversible tier-1 field edit. Deleting a
// document also removes the underlying storage file (not recoverable from here), so it's
// gated as destructive — registry-present but confirm-required, like bill.delete. Each entry
// WRAPS the existing server action (requireStaff + RLS + revalidate live there).
export const documentActions: Record<string, ActionDef> = {
  "document.update": {
    name: "document.update",
    group: "document",
    label: "Rename / recategorize document",
    description:
      "Rename or re-categorize an uploaded job DOCUMENT. Pass the document's id, its job_id, and a new name and/or category (omit a field to leave it unchanged). Reversible field edit.",
    input: z.object({
      id: z.string(),
      job_id: z.string(),
      name: z.string().optional(),
      category: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) => {
      const patch: { name?: string; category?: string | null } = {};
      if (i.name !== undefined) patch.name = i.name;
      if (i.category !== undefined) patch.category = i.category ?? null;
      return updateDocument(i.id, patch, i.job_id);
    },
  },
  /** Not a Cost, reached from a Needs You row's ⋯ (a Receipt or Bill paper on a job that no bill
   *  holds, and that never was a cost: a supplier's quote). It runs the job page's own rule
   *  (markPaperNotACost, which files it as Not a Cost through updateDocument, the pencil's write),
   *  never a second copy. The paper stays the office's, as the Receipt was. A reversible field edit
   *  like document.update, and a row door only: it is deliberately NOT in AGENT_WRITE_ALLOWED. */
  "document.notACost": {
    name: "document.notACost",
    group: "document",
    label: "Paper is not a cost",
    description:
      "File a job paper that was filed as a Receipt or a Bill but never was a cost (a supplier's quote, a packing slip) as Not a Cost, so it stops asking to be recorded as one. Pass the document's id. The paper stays with the job's papers for the office (the crew and the customer are not shown it) and no cost changes; the job's paper list can re-file it.",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => markPaperNotACost(i.id),
  },
  "document.delete": {
    name: "document.delete",
    group: "document",
    label: "Delete document",
    description:
      "Delete a job DOCUMENT — also removes the stored file. Pass the document's id, its storage path, and its job_id. Not recoverable from here, so the app asks the user to confirm before it runs.",
    input: z.object({ id: z.string(), path: z.string(), job_id: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "destructive",
    describe: () => "Delete this document and its file — say yes to confirm. This can't be undone.",
    handler: (i) => deleteDocument(i.id, i.path, i.job_id),
  },
};
