import { z } from "zod";
import { archiveItem, saveVoiceNote, aiReviewItem, billJobReceipt } from "@/app/(app)/organize/actions";
import type { ActionDef } from "../types";

export const organizeActions: Record<string, ActionDef> = {
  "organize.review": {
    name: "organize.review",
    group: "organize",
    label: "AI-review captured item",
    description: "Run the AI triage on a captured Organize-My item — it suggests where the item belongs. Pass the item id (from the inbox).",
    input: z.object({ id: z.string() }),
    auth: "any",
    effect: "write",
    handler: (i) => aiReviewItem(i.id),
  },
  "organize.billReceipt": {
    name: "organize.billReceipt",
    group: "organize",
    label: "Bill a captured receipt",
    description: "Turn a captured RECEIPT document into a billable job cost — 'bill that Home Depot receipt to the job'. Pass the document id of the receipt.",
    input: z.object({ document_id: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "financial",
    describe: () => "Turn this captured receipt into a billable job cost (at the amount read off the receipt) — say yes to confirm.",
    // The pen sentence rides on its own field now (not `warning`), and the model is handed only what
    // agent-tool-result projects: it goes on as `speak`, so Nort still says what ink was read.
    handler: async (i) => {
      const r = await billJobReceipt(i.document_id);
      return r.ok && r.pen ? { ...r, speak: r.pen } : r;
    },
  },
  "organize.saveNote": {
    name: "organize.saveNote",
    group: "organize",
    label: "Capture a voice note",
    description:
      "Capture a quick NOTE / reminder into Organize My — 'make a note: call the inspector Tuesday', 'remind me to order more <item>'. Hands-busy field capture so nothing slips. Pass the note text.",
    input: z.object({ text: z.string().min(1) }),
    auth: "any",
    effect: "write",
    handler: (i) => saveVoiceNote(i.text),
  },
  "organize.archive": {
    name: "organize.archive",
    group: "organize",
    label: "Archive captured item",
    description: "Archive (dismiss) a captured item in Organize My.",
    input: z.object({ id: z.string() }),
    auth: "any",
    effect: "write",
    handler: (i) => archiveItem(i.id),
  },
};
