import { z } from "zod";
import { updateDocument, deleteDocument } from "@/app/(app)/jobs/actions";
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
