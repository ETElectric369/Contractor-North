import { z } from "zod";
import { markInquiryContacted, convertInquiry, deleteInquiry, createInquiry } from "@/app/(app)/leads/actions";
import type { ActionDef } from "../types";

export const inquiryActions: Record<string, ActionDef> = {
  "inquiry.create": {
    name: "inquiry.create",
    group: "inquiry",
    label: "Add a lead",
    description:
      "Capture a new LEAD / inquiry (the top of the funnel) — e.g. 'add a lead, Jane Doe, 555-1212, wants a panel upgrade'. Only name is required; phone/email/company/message/type are optional. It auto-books a next-day follow-up so the lead doesn't slip. Afterward you can contact (inquiry.contact) or convert it (inquiry.convert).",
    input: z.object({
      name: z.string().min(1),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      company_name: z.string().nullable().optional(),
      message: z.string().nullable().optional(),
      type: z.enum(["residential", "commercial"]).optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) => {
      const fd = new FormData();
      fd.set("name", i.name);
      if (i.phone) fd.set("phone", i.phone);
      if (i.email) fd.set("email", i.email);
      if (i.company_name) fd.set("company_name", i.company_name);
      if (i.message) fd.set("message", i.message);
      if (i.type) fd.set("type", i.type);
      return createInquiry(fd);
    },
  },
  "inquiry.contact": {
    name: "inquiry.contact",
    group: "inquiry",
    label: "Mark inquiry contacted",
    description: "Mark a lead/inquiry as contacted, optionally with a follow-up date (YYYY-MM-DD).",
    input: z.object({ id: z.string(), follow_up_date: z.string().nullable().optional() }),
    auth: "staff",
    effect: "write",
    handler: (i) => markInquiryContacted(i.id, i.follow_up_date ?? undefined),
  },
  "inquiry.convert": {
    name: "inquiry.convert",
    group: "inquiry",
    label: "Convert inquiry",
    description: "Convert a lead/inquiry into a customer, quote, estimate, or job.",
    input: z.object({ id: z.string(), target: z.enum(["customer", "quote", "estimate", "job"]).default("estimate") }),
    auth: "staff", // inquiries are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: (i) => convertInquiry(i.id, i.target),
  },
  "inquiry.delete": {
    name: "inquiry.delete",
    group: "inquiry",
    label: "Delete inquiry",
    description: "Delete/dismiss a lead inquiry.",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    confirm: "destructive",
    handler: (i) => deleteInquiry(i.id),
  },
};
