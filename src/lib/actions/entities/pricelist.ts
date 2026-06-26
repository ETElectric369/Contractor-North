import { z } from "zod";
import { createPriceItem } from "@/app/(app)/price-list/actions";
import type { ActionDef } from "../types";

export const pricelistActions: Record<string, ActionDef> = {
  "pricelist.add": {
    name: "pricelist.add",
    group: "pricelist",
    label: "Add to price list",
    description:
      "Add an item to the PRICE LIST so the next quote line auto-prices — 'add 3/4 copper elbow, buy 4.20, 35% markup'. description required; buy_price + markup_pct set the sell price; unit defaults to ea.",
    input: z.object({
      description: z.string().min(1),
      category: z.string().nullable().optional(),
      unit: z.string().optional(),
      buy_price: z.number().optional(),
      markup_pct: z.number().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) =>
      createPriceItem({
        description: i.description,
        category: i.category ?? null,
        unit: i.unit,
        buy_price: i.buy_price,
        markup_pct: i.markup_pct,
      }),
  },
};
