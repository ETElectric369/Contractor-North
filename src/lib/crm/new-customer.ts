import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { formatPhone } from "@/lib/utils";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";

/**
 * ONE DOOR FOR A CUSTOMER TYPED ON A JOB FORM (W1-22): New Job's and Edit Job's "+ New Customer"
 * both come here, so neither can mint a twin. Crosscheck the book first on the CRM's own keys (a
 * phone or an email is one person; a name only when it is unique: findMatchingCustomerId), and only
 * when nobody matches, insert, with the phone in the one format every other customer door writes.
 *
 * Audit v921: New Job used to mint blind ("start a job for Mike Scrivano, 5306060045" made a second
 * Mike beside the first's (530) 606-0045), and Edit Job still did until this helper. A book that
 * can't be read is a refusal, never a blind insert: the person is told, and nothing is made.
 *
 * The caller's own client (RLS scopes the book and stamps the org on insert).
 */
export async function matchOrCreateCustomer(
  supabase: SupabaseClient,
  userId: string | null,
  typed: { name: string; phone?: string | null; email?: string | null },
): Promise<{ ok: true; id: string; matched: boolean } | { ok: false; error: string }> {
  const name = String(typed.name ?? "").trim();
  if (!name) return { ok: false, error: "Type the new customer's name." };
  const phone = formatPhone(String(typed.phone ?? "").trim());
  const email = String(typed.email ?? "").trim();

  const { data: book, error: bookErr } = await supabase.from("customers").select("id, name, company_name, email, phone");
  if (bookErr) return { ok: false, error: "Couldn't check your customer list just now, so no customer was made. Try again." };
  const match = findMatchingCustomerId({ name, phone, email }, (book ?? []) as DupCustomer[]);
  if (match) return { ok: true, id: match, matched: true };

  const { data, error } = await supabase
    .from("customers")
    .insert({ name, phone: phone || null, email: email || null, status: "active", created_by: userId })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: dbError(error) };
  return { ok: true, id: (data as { id: string }).id, matched: false };
}
