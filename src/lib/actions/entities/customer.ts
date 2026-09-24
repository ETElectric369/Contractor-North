import { z } from "zod";
import { createCustomer, patchCustomer } from "@/app/(app)/crm/actions";
import { createClient } from "@/lib/supabase/server";
import { orgTimezone } from "@/lib/org-local-time";
import { LINK_OFFER_WINDOW_MS, linkOfferNextStep, matchLinkOffers, type LinkCandidateRow } from "../link-offer";
import type { ActionDef, ActionResult } from "../types";

type Db = Awaited<ReturnType<typeof createClient>>;

/** ANNOUNCE THE DEED: the contact as STORED. Nort told Erik "Saved his phone: (916) 992-4711" over a
 *  row that read "1 (916) 992-4711" (2026-09-24) — it repeated what it meant, not what landed. */
async function customerRecorded(supabase: Db, id: string, verb: string): Promise<string | null> {
  const { data } = await supabase.from("customers").select("name, phone, email").eq("id", id).maybeSingle();
  if (!data) return null;
  const c = data as { name?: string | null; phone?: string | null; email?: string | null };
  return `${verb}: ${[c.name, c.phone, c.email].filter(Boolean).join(" · ")}.`;
}

export const customerActions: Record<string, ActionDef> = {
  "customer.create": {
    name: "customer.create",
    group: "customer",
    label: "Add customer",
    description:
      "Create a contact record. Speech mangles names, so CONFIRM the spelling with the user before calling this (read it back, or have them spell a tricky one). Name + whatever else was given — phone, email, company, address/city/state/zip, notes. Set type to 'subcontractor' for a sub / supplier / inspector (vs a residential/commercial/industrial client) so they can be linked to jobs. Confirm from the result's `recorded` line (the stored name and phone). If the result carries link_offer (a visit you booked for this person with no customer), follow its next_step in the SAME answer: offer the link, and link only on a yes.",
    // Fragment-first: the columns are all nullable and createCustomer already reads every
    // one of these — the old 3-field schema silently DROPPED a spoken address/email.
    input: z.object({
      name: z.string().min(1),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      company_name: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      zip: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      type: z.enum(["residential", "commercial", "industrial", "subcontractor"]).optional(),
    }),
    auth: "staff",
    effect: "write",
    // Reuse the canonical createCustomer (phone/state/zip formatting, defaults) via a FormData.
    handler: async (i, ctx): Promise<ActionResult> => {
      const fd = new FormData();
      fd.set("name", i.name);
      if (i.phone) fd.set("phone", i.phone);
      if (i.email) fd.set("email", i.email);
      if (i.company_name) fd.set("company_name", i.company_name);
      if (i.address) fd.set("address", i.address);
      if (i.city) fd.set("city", i.city);
      if (i.state) fd.set("state", i.state);
      if (i.zip) fd.set("zip", i.zip);
      if (i.notes) fd.set("notes", i.notes);
      if (i.type) fd.set("type", i.type);
      const r = await createCustomer(fd);
      if (!r.ok || !r.id) return r;
      const supabase = await createClient();
      const recorded = await customerRecorded(supabase, r.id, "Saved");
      // THE LINK OFFER: a visit this person just booked for this customer, still customer-less.
      // Best-effort — a failed lookup never fails the create that already landed.
      let data: Record<string, unknown> = { id: r.id };
      if (ctx.userId) {
        try {
          const { data: rows } = await supabase
            .from("appointments")
            .select("id, title, location, starts_at")
            .is("customer_id", null)
            .eq("created_by", ctx.userId)
            .in("status", ["scheduled", "proposed"])
            .gte("created_at", new Date(Date.now() - LINK_OFFER_WINDOW_MS).toISOString())
            .order("created_at", { ascending: false })
            .limit(10);
          const offers = matchLinkOffers((rows ?? []) as LinkCandidateRow[], { name: i.name, address: i.address }, await orgTimezone(supabase));
          if (offers.length) data = { ...data, link_offer: offers, next_step: linkOfferNextStep(i.name, offers) };
        } catch {
          /* the offer is a courtesy; the customer is saved either way */
        }
      }
      return { ...r, data, ...(recorded ? { recorded } : {}) };
    },
  },
  "customer.update": {
    name: "customer.update",
    group: "customer",
    label: "Edit customer",
    description:
      "Fix or update a customer you can see — correct a MISSPELLED name, add a phone/email/address, change the type (e.g. to 'subcontractor'), etc. Pass the customer's id (from list_customers) and ONLY the fields to change. Use this when a name came out wrong; never tell the user you can't fix it. Confirm from the result's `recorded` line (what was stored), never from what you sent.",
    input: z.object({
      id: z.string(),
      name: z.string().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      company_name: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      zip: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      type: z.enum(["residential", "commercial", "industrial", "subcontractor"]).optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: async ({ id, ...patch }): Promise<ActionResult> => {
      const r = await patchCustomer(id, patch);
      if (!r.ok) return r;
      const recorded = await customerRecorded(await createClient(), id, "Saved");
      return { ...r, ...(recorded ? { recorded } : {}) };
    },
  },
};
