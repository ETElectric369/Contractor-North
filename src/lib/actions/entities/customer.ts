import { z } from "zod";
import { createCustomer, patchCustomer } from "@/app/(app)/crm/actions";
import { linkAppointmentTo } from "@/app/(app)/appointments/actions";
import { createClient } from "@/lib/supabase/server";
import { orgTimezone, quotedData } from "@/lib/org-local-time";
import {
  LINK_OFFER_WINDOW_MS,
  autoLinkPick,
  carriedOfferNextStep,
  linkOfferNextStep,
  linkedNextStep,
  linkedVisit,
  matchLinkOffers,
  type LinkCandidateRow,
} from "../link-offer";
import type { ActionDef, ActionResult } from "../types";

type Db = Awaited<ReturnType<typeof createClient>>;
type StoredCustomer = { name?: string | null; phone?: string | null; email?: string | null; address?: string | null };

/** ANNOUNCE THE DEED: the contact as STORED. Nort told Erik "Saved his phone: (916) 992-4711" over a
 *  row that read "1 (916) 992-4711" (2026-09-24) — it repeated what it meant, not what landed. */
async function customerRecorded(supabase: Db, id: string, verb: string): Promise<{ said: string; row: StoredCustomer } | null> {
  const { data } = await supabase.from("customers").select("name, phone, email, address").eq("id", id).maybeSingle();
  if (!data) return null;
  const c = data as StoredCustomer;
  return { said: `${verb}: ${[c.name ? quotedData(c.name) : null, c.phone, c.email].filter(Boolean).join(" · ")}.`, row: c };
}

/** The visits THIS person booked in the last few hours that still have no customer: the only ones a
 *  new or just-edited customer can be linked to or offered. */
async function recentCustomerlessVisits(supabase: Db, userId: string): Promise<LinkCandidateRow[]> {
  const { data: rows } = await supabase
    .from("appointments")
    .select("id, title, location, starts_at")
    .is("customer_id", null)
    .eq("created_by", userId)
    .in("status", ["scheduled", "proposed"])
    .gte("created_at", new Date(Date.now() - LINK_OFFER_WINDOW_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(10);
  return (rows ?? []) as LinkCandidateRow[];
}

/**
 * LINK IT, OR OFFER IT. On a create that certainly belongs to one visit (autoLinkPick), the visit is
 * linked in the same action and the read-back says so; otherwise, or if that link didn't take, the
 * visits are offered (link_offer + next_step) and Nort asks. `mayLink` is false for an update: the
 * user was editing the person, so the pending link is carried (re-offered), never made for them.
 * Best-effort: a failed lookup never fails the customer write that already landed.
 */
async function linkOrOffer(
  supabase: Db,
  userId: string | null | undefined,
  customer: { id: string; name: string; address?: string | null; type?: string | null },
  mayLink: boolean,
): Promise<{ data: Record<string, unknown>; said: string | null }> {
  if (!userId) return { data: {}, said: null };
  try {
    const rows = await recentCustomerlessVisits(supabase, userId);
    if (!rows.length) return { data: {}, said: null };
    const tz = await orgTimezone(supabase);
    const pick = mayLink ? autoLinkPick(rows, customer) : null;
    let failed: string | null = null;
    if (pick) {
      const r = await linkAppointmentTo(pick.id, "customer", customer.id);
      if (r.ok) {
        const visit = linkedVisit(pick, tz);
        return { data: { linked: visit, next_step: linkedNextStep() }, said: `Linked to the visit ${visit.title}, ${visit.when}.` };
      }
      // Nothing silent: the link that didn't take is said, and the visit is offered instead.
      failed = r.error ?? "The link didn't save.";
    }
    const offers = matchLinkOffers(rows, customer, tz);
    if (!offers.length) return { data: {}, said: null };
    return {
      data: {
        link_offer: offers,
        // A create's offer is new: ask. An update's is carried: ask only while it's unanswered.
        next_step: mayLink ? linkOfferNextStep(offers) : carriedOfferNextStep(offers),
        ...(failed ? { link_failed: failed } : {}),
      },
      said: failed ? `Couldn't link the visit ${offers[0].title} yet (${failed}).` : null,
    };
  } catch {
    return { data: {}, said: null };
  }
}

export const customerActions: Record<string, ActionDef> = {
  "customer.create": {
    name: "customer.create",
    group: "customer",
    label: "Add customer",
    description:
      "Create a contact record. Speech mangles names, so CONFIRM the spelling with the user before calling this (read it back, or have them spell a tricky one). Name + whatever else was given — phone, email, company, address/city/state/zip, notes. Set type to 'subcontractor' for a sub / supplier / inspector (vs a residential/commercial/industrial client) so they can be linked to jobs. Confirm from the result's `recorded` line (the stored name and phone). If the result carries `linked`, the one visit you booked for this person with no customer is ALREADY linked to them: say so in the same answer (follow its next_step), never ask. If it carries link_offer instead (more than one visit, or one you can't be sure of), follow its next_step in the SAME answer: offer the link, and link only on a yes.",
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
      const stored = await customerRecorded(supabase, r.id, "Saved");
      // THE LINK: a visit this person just booked for this customer, still customer-less — linked
      // now when it's certainly theirs (the yes to adding him was the yes to his booking), else offered.
      const link = await linkOrOffer(supabase, ctx.userId, { id: r.id, name: i.name, address: i.address, type: i.type }, true);
      const recorded = [stored?.said, link.said].filter(Boolean).join(" ");
      return { ...r, data: { id: r.id, ...link.data }, ...(recorded ? { recorded } : {}) };
    },
  },
  "customer.update": {
    name: "customer.update",
    group: "customer",
    label: "Edit customer",
    description:
      "Fix or update a customer you can see — correct a MISSPELLED name, add a phone/email/address, change the type (e.g. to 'subcontractor'), etc. Pass the customer's id (from list_customers) and ONLY the fields to change. Use this when a name came out wrong; never tell the user you can't fix it. Confirm from the result's `recorded` line (what was stored), never from what you sent. If the result carries link_offer (a visit you booked for this person that still has no customer), follow its next_step: ask about it again only if the user never answered it. Once the user said no to linking this person to a visit, pass declined_link: true on every later update to them, and no offer comes back.",
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
      // Not a column: the user already said no to linking this person to a visit, so the update
      // carries no link offer (a no writes nothing, so only Nort can tell the server).
      declined_link: z.boolean().optional(),
    }),
    auth: "staff",
    effect: "write",
    handler: async ({ id, declined_link, ...patch }, ctx): Promise<ActionResult> => {
      const r = await patchCustomer(id, patch);
      if (!r.ok) return r;
      const supabase = await createClient();
      const stored = await customerRecorded(supabase, id, "Saved");
      // THE PENDING LINK SURVIVES AN ANSWER THAT ISN'T A YES: Nort asked "link him to tomorrow's
      // inspection?", Erik answered with the phone number, and the offer was gone. While the visit
      // is still customer-less, the update carries the offer again (never links it for them), worded
      // to ask only while it's unanswered; after a no (declined_link) nothing rides at all.
      const link = stored?.row.name && !declined_link
        ? await linkOrOffer(supabase, ctx.userId, { id, name: stored.row.name, address: stored.row.address }, false)
        : { data: {}, said: null };
      return {
        ...r,
        ...(Object.keys(link.data).length ? { data: { id, ...link.data } } : {}),
        ...(stored ? { recorded: stored.said } : {}),
      };
    },
  },
};
