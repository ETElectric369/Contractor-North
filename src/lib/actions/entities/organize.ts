import { z } from "zod";
import { archiveItem } from "@/app/(app)/organize/actions";
import type { ActionDef } from "../types";

export const organizeActions: Record<string, ActionDef> = {
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
