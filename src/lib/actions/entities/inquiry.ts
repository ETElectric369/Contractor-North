import { z } from "zod";
import { markInquiryContacted, convertInquiry, deleteInquiry, createInquiry } from "@/app/(app)/leads/actions";
import type { ActionDef } from "../types";

export const inquiryActions: Record<string, ActionDef> = {
  "inquiry.create": {
    name: "inquiry.create",
    group: "inquiry",
    label: "Add a lead",
    description:
      // A NEW LEAD IS A LEAD, NOT A BOOKING (audit v921): this used to promise "it auto-books a
      // next-day follow-up", which is the phantom-booking createInquiry deliberately removed —
      // the lead lands with next_follow_up_at NULL and no appointment. Nort reads this text as
      // fact, so it was telling people about a follow-up nobody had booked.
      "Capture a new LEAD / inquiry (the top of the funnel) — e.g. 'add a lead, Jane Doe, 555-1212, wants a panel upgrade'. Only name is required; phone/email/company/message/type are optional. The lead lands on the follow-up list with no date; set one with inquiry.contact. Afterward you can contact (inquiry.contact) or convert it (inquiry.convert).",
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
    description:
      "Convert a lead/inquiry. Targets: 'inspection' books a site inspection on the schedule and keeps the lead open (use for big jobs that need a site visit before a firm price); 'quote'/'estimate' both start a priced draft (no contact card until it's accepted); 'job' books the work; 'customer' just files them in the CRM. For 'inspection': when they name a time — 'today', 'right now', 'Tuesday at 10' — pass date (YYYY-MM-DD, company-local) and time (HH:MM, 24h); left out, it lands two days out at 09:00. The result's data.starts_at / date / time are WHEN it actually landed — read that back to them; never assume it's now.",
    input: z.object({
      id: z.string(),
      // DEFAULT "quote", NOT "estimate" (audit v921). The UI's Estimate button already means
      // quote (convert-menu rewrites it), but convertInquiry treats "estimate" as a commit-now
      // target: it mints a CUSTOMER and a "Job — <name>" and stamps the lead converted, with no
      // estimate anywhere. So "convert the Karen lead" with no target silently filed a contact
      // and a job and hid the lead. Here the word and the deed agree — see the handler's alias.
      target: z.enum(["inspection", "customer", "quote", "estimate", "job"]).default("quote"),
      // Inspection timing — the door the assistant lacked: with no way to say WHEN, every
      // spoken "right now" silently became the two-days-out 9 AM default.
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }),
    auth: "staff", // inquiries are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    // "estimate" is the spoken word for a quote — send it where the description says it goes
    // (a priced draft, customer deferred to the win), never to the commit-now customer+job path.
    handler: (i) =>
      convertInquiry(i.id, i.target === "estimate" ? "quote" : i.target, {
        startDate: i.date,
        startTime: i.time,
      }),
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
