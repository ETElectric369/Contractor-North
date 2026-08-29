import type { createClient } from "@/lib/supabase/server";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";
import { customerAddressFrom } from "@/lib/inquiries/lead-address";

/**
 * THE WIN MINTS THE CUSTOMER — one implementation of the deferred-customer doctrine.
 *
 * Erik's flow: a prospect becomes a saved Contact ONLY when the deal is won, not when paperwork is
 * drafted. Two things now count as the win: an estimate being accepted (quotes/actions), and money
 * actually changing hands (settleUp — Nora paid $150 cash; there is no harder proof of a win).
 *
 * This was inline in materializeQuoteCustomer. Extracted because the settle-up path needs the
 * IDENTICAL rules, and a second hand-rolled copy of "dedup by the CRM's keys, address is where the
 * PERSON lives not the site, stamp the lead won" is how the two paths would quietly mint duplicate
 * contacts with site addresses — both bugs this codebase has already had once.
 *
 * Idempotent: an inquiry that already carries a customer hands it straight back.
 */
export async function customerForInquiry(
  supabase: Awaited<ReturnType<typeof createClient>>,
  inquiryId: string,
  userId: string,
): Promise<string | null> {
  const { data: inq } = await supabase.from("inquiries").select("*").eq("id", inquiryId).maybeSingle();
  if (!inq) return null;
  if (inq.customer_id) {
    /* THE STAMP LANDS EVEN WHEN THE CONTACT EXISTS. This early-return used to skip the won stamp
       entirely, so a lead that already carried a customer (saved as a contact earlier, or matched
       at intake) stayed "contacted" FOREVER after its money landed — open on /leads, nagging in
       the feeders, a won deal wearing a lead costume. The win is the win whether or not a card
       had to be minted for it. */
    await supabase
      .from("inquiries")
      .update({
        status: "won",
        converted_at: inq.converted_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", inquiryId)
      .is("converted_at", null); // idempotent — an earlier stamp keeps its original date
    // A lead already stamped (estimate path) but not yet 'won' still flips to won on real money.
    if (inq.converted_at && inq.status !== "won") {
      await supabase.from("inquiries").update({ status: "won", updated_at: new Date().toISOString() }).eq("id", inquiryId);
    }
    return inq.customer_id as string;
  }

  // Crosscheck the book first — same phone / email / normalized name links the existing card
  // instead of minting a twin. The exact keys the CRM's duplicate finder uses.
  const { data: book } = await supabase.from("customers").select("id, name, company_name, email, phone");
  let customerId = findMatchingCustomerId(
    { name: inq.name, email: inq.email, phone: inq.phone },
    (book ?? []) as DupCustomer[],
  );

  if (!customerId) {
    const { data: cust, error } = await supabase
      .from("customers")
      .insert({
        name: inq.name,
        company_name: inq.company_name,
        type: inq.type ?? "residential",
        status: "active",
        email: inq.email,
        phone: inq.phone,
        // WHERE THE PERSON IS, not where the work is — customerAddressFrom is the one rule
        // (shared with lead conversion and migration 0192's SQL twin).
        ...customerAddressFrom(inq),
        notes: inq.message ? `From inquiry: ${inq.message}` : inq.notes,
        created_by: userId,
      })
      .select("id")
      .single();
    if (error || !cust) return null; // best-effort: the caller proceeds customer-less
    customerId = cust.id;
  }

  // STAMP FOLLOWS DEED: the lead is won and carries its contact. Idempotent on converted_at.
  await supabase
    .from("inquiries")
    .update({
      customer_id: customerId,
      status: "won",
      converted_at: inq.converted_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", inquiryId);
  return customerId;
}
