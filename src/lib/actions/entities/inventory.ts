import { z } from "zod";
import { adjustQuantity } from "@/app/(app)/inventory/actions";
import type { ActionDef } from "../types";

export const inventoryActions: Record<string, ActionDef> = {
  "inventory.adjust": {
    name: "inventory.adjust",
    group: "inventory",
    label: "Adjust stock",
    description:
      "Adjust an inventory item's quantity on hand by a signed delta — 'used 5 breakers' (delta -5) or 'received 20' (delta +20). Find the item with list_inventory and pass its id + the delta. Reversible (adjust back).",
    input: z.object({ id: z.string(), delta: z.number() }),
    auth: "staff",
    effect: "write",
    handler: (i) => adjustQuantity(i.id, i.delta),
  },
};
