import { z } from "zod";
import { markInquiryContacted, convertInquiry, deleteInquiry } from "@/app/(app)/leads/actions";
import type { ActionDef } from "../types";

export const inquiryActions: Record<string, ActionDef> = {
  "inquiry.contact": {
    name: "inquiry.contact",
    group: "inquiry",
    label: "Mark inquiry contacted",
    description: "Mark a lead/inquiry as contacted, optionally with a follow-up date (YYYY-MM-DD).",
    input: z.object({ id: z.string(), follow_up_date: z.string().nullable().optional() }),
    auth: "any",
    effect: "write",
    handler: (i) => markInquiryContacted(i.id, i.follow_up_date ?? undefined),
  },
  "inquiry.convert": {
    name: "inquiry.convert",
    group: "inquiry",
    label: "Convert inquiry",
    description: "Convert a lead/inquiry into a customer, quote, estimate, or job.",
    input: z.object({ id: z.string(), target: z.enum(["customer", "quote", "estimate", "job"]).default("estimate") }),
    auth: "any", // matches the pre-registry inbox (RLS enforces server-side)
    effect: "write",
    handler: (i) => convertInquiry(i.id, i.target),
  },
  "inquiry.delete": {
    name: "inquiry.delete",
    group: "inquiry",
    label: "Delete inquiry",
    description: "Delete/dismiss a lead inquiry.",
    input: z.object({ id: z.string() }),
    auth: "any",
    effect: "write",
    confirm: "destructive",
    handler: (i) => deleteInquiry(i.id),
  },
};
