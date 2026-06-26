import { z } from "zod";
import { archiveItem, saveVoiceNote } from "@/app/(app)/organize/actions";
import type { ActionDef } from "../types";

export const organizeActions: Record<string, ActionDef> = {
  "organize.saveNote": {
    name: "organize.saveNote",
    group: "organize",
    label: "Capture a voice note",
    description:
      "Capture a quick NOTE / reminder into Organize My — 'make a note: call the inspector Tuesday', 'remind me to order more 12-gauge'. Hands-busy field capture so nothing slips. Pass the note text.",
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
