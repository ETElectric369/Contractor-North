import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { formatPhone } from "@/lib/utils";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";

export const NEW_CUSTOMER_NEEDS_A_NAME = "Type the new customer's name, or tap Pick Existing.";

/**
 * WHAT A JOB FORM TYPED FOR A NEW CUSTOMER, or null when it typed none. A form in "+ New Customer"
 * mode sends new_customer=1 (CustomerPicker's hidden marker); a caller without the marker counts as
 * typing one when it sent a name, a phone or an email and picked nobody. Either way the name may be
 * blank, and then matchOrCreateCustomer REFUSES in words: a phone typed with no name is never dropped
 * while the job is made with no customer (New Job) or quietly keeps the old one (Edit Job).
 * A picked customer_id always wins.
 */
export function typedNewCustomer(formData: FormData): { name: string; phone: string; email: string } | null {
  const picked = String(formData.get("customer_id") ?? "").trim();
  if (picked) return null;
  const name = String(formData.get("new_customer_name") ?? "").trim();
  const phone = String(formData.get("new_customer_phone") ?? "").trim();
  const email = String(formData.get("new_customer_email") ?? "").trim();
  const marked = String(formData.get("new_customer") ?? "") === "1";
  if (!marked && !name && !phone && !email) return null;
  return { name, phone, email };
}

/**
 * ONE DOOR FOR A CUSTOMER TYPED ON A JOB FORM (W1-22): New Job's and Edit Job's "+ New Customer"
 * both come here, so neither can mint a twin. Crosscheck the book first on the CRM's own keys (a
 * phone or an email is one person; a name only when it is unique: findMatchingCustomerId), and only
 * when nobody matches, insert, with the phone in the one format every other customer door writes.
 *
 * Audit v921: New Job used to mint blind ("start a job for Mike Sparrow, 5305550145" made a second
 * Mike beside the first's (530) 555-0145), and Edit Job still did until this helper. A book that
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
  if (!name) return { ok: false, error: NEW_CUSTOMER_NEEDS_A_NAME };
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
