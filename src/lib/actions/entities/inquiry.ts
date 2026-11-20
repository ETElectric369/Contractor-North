import { z } from "zod";
import { markInquiryContacted, convertInquiry, deleteInquiry, createInquiry, setInquiryStatus } from "@/app/(app)/leads/actions";
import type { ActionDef } from "../types";

export const inquiryActions: Record<string, ActionDef> = {
  "inquiry.create": {
    name: "inquiry.create",
    group: "inquiry",
    label: "Add a lead",
    description:
      // A NEW LEAD IS A LEAD, NOT A BOOKING (audit v921). cn-v1170: the input is the form's fields
      // (the Scope is `message`); no kind, no how long, no follow-up day.
      "Capture a new LEAD / inquiry (the top of the funnel), e.g. 'add a lead, <name>, <phone>, wants <the work>'. Only name is required. Optional: company_name (their business), phone, email, the address (address = street line, city, state, zip), message (the SCOPE: what they need and the kind of work), notes, source (how they found you, a label like Web, Signage, Word of Mouth or Referral; leave it out when they did not say), and type (residential or commercial; when it isn't given it is inferred from the business: a business is commercial, none is residential). The lead lands on the Leads list, which is the reminder: it stays there until it is scheduled or marked Not Sold. Nothing is booked. Afterward you can book its inspection (inquiry.convert with target 'inspection') or record they were reached (inquiry.contact).",
    input: z.object({
      name: z.string().min(1),
      company_name: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      zip: z.string().nullable().optional(),
      message: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
      // Kept from before cn-v1170 (nobody decided to drop it): createInquiry honours a sent type.
      type: z.enum(["residential", "commercial"]).optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: (i) => {
      const fd = new FormData();
      fd.set("name", i.name);
      // No `unit`: the lead form posts none, so inquiryFields never reads one (cn-v1170 fixer).
      for (const k of ["company_name", "phone", "email", "address", "city", "state", "zip", "message", "notes", "source"] as const) {
        const v = (i[k] ?? "").trim();
        if (v) fd.set(k, v);
      }
      if (i.type) fd.set("type", i.type);
      return createInquiry(fd);
    },
  },
  "inquiry.contact": {
    name: "inquiry.contact",
    group: "inquiry",
    label: "Mark inquiry contacted",
    description:
      "Record that a lead was reached (status contacted, the time of contact stamped). Pass its id (from list_inquiries). It stays on the Leads list until it is scheduled or marked Not Sold; there is no follow-up day (for a dated nudge, the person sets a reminder).",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => markInquiryContacted(i.id),
  },
  "inquiry.markLost": {
    name: "inquiry.markLost",
    group: "inquiry",
    label: "Mark a lead Not Sold",
    description:
      "Record that a lead went nowhere, e.g. 'the Dana lead is not sold, she went with someone else'. Pass its id (from list_inquiries). The lead is kept (not deleted) and marked Not Sold, so it leaves the Leads list and the record stays with everything on it; Reopen under Not Sold at the bottom of the Leads page brings it back. Refused while an inspection booked from it still stands: then the visit is marked Not Sold or dismissed on its own page.",
    input: z.object({ id: z.string() }),
    auth: "staff",
    effect: "write",
    handler: (i) => setInquiryStatus(i.id, "lost"),
  },
  "inquiry.convert": {
    name: "inquiry.convert",
    group: "inquiry",
    label: "Convert inquiry",
    description:
      "Convert a lead/inquiry. Targets: 'inspection' books an inspection (the site visit before a firm price) on the schedule and keeps the lead open (use for big jobs that need one); 'quote'/'estimate' both start a priced draft (no contact card until it's accepted); 'job' books the work; 'customer' just files them in the CRM. For 'inspection': when they name a time — 'today', 'right now', 'Tuesday at 10' — pass date (YYYY-MM-DD, company-local) and time (HH:MM, 24h); left out, it lands two days out at 09:00. The result's data.starts_at / date / time are WHEN it actually landed — read that back to them; never assume it's now. The target key stays 'inspection'; say inspection to the person (a city inspection goes on the job's permit, not here).",
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
