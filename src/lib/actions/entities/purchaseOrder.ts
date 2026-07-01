import { z } from "zod";
import { updatePurchaseOrder, receiveItem } from "@/app/(app)/purchasing/actions";
import type { ActionDef } from "../types";

// Purchase orders. The header edit (vendor / job link) is a reversible tier-1 write.
// Receiving a line is also tier-1: it mirrors inventory.adjust (a reversible stock move) —
// receiveItem() recomputes the receiving line, flows the delta into inventory_items by part
// number, and recomputes the PO status (received/partial/sent). Each entry WRAPS the existing
// server action; no new business logic here (the inventory + status recompute live in the action).
export const purchaseOrderActions: Record<string, ActionDef> = {
  "purchaseorder.update": {
    name: "purchaseorder.update",
    group: "purchaseorder",
    label: "Edit purchase order",
    description:
      "Edit a PURCHASE ORDER's header — its vendor and/or the job it's charged to. Resolve the PO's id first and pass ONLY the fields to change: vendor (blank falls back to CED) and/or job_id (resolve with list_jobs; an explicit null clears it, omitting it leaves it alone). Reversible header edit.",
    // A true PATCH: the old defaults reset the vendor to CED and UNLINKED the job on
    // any edit that didn't repeat them. Omitted = untouched.
    input: z.object({
      id: z.string(),
      vendor: z.string().optional(),
      job_id: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: ({ id, ...patch }) => updatePurchaseOrder(id, patch),
  },
  "purchaseorder.receive": {
    name: "purchaseorder.receive",
    group: "purchaseorder",
    label: "Receive PO line",
    description:
      "Mark a PURCHASE-ORDER LINE received — 'received 20 of the 50 breakers'. Pass the line's item_id, its po_id, and received_qty. This flows the received delta into inventory stock (matched by part number) and recomputes the PO status. Reversible — re-receive with a corrected quantity.",
    input: z.object({ item_id: z.string(), po_id: z.string(), received_qty: z.number() }),
    auth: "staff",
    effect: "write",
    handler: (i) => receiveItem(i.item_id, i.po_id, i.received_qty),
  },
};
