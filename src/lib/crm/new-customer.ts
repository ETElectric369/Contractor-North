import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";
import { formatPhone } from "@/lib/utils";
import { findMatchingCustomerId, type DupCustomer } from "@/lib/crm/duplicates";

export const NEW_CUSTOMER_NEEDS_A_NAME = "Type the new customer's name, or tap Pick Existing.";

/** One page of the book; the API's own default cap, so a full page means there may be more. */
export const CUSTOMER_BOOK_PAGE = 1000;

/**
 * THE WHOLE CUSTOMER BOOK, FOR THE MATCHER (cn-v1171, skeptic #74). The doors that ask the book before
 * making a customer read it in one request with no limit, and the API answers at most 1,000 rows, so a
 * bigger book was matched only in part and a person on file past the first thousand was made again.
 * This reads it page by page, in id order, until a short page. Any failed page is the whole read's
 * error: a book read in part is never matched as if it were whole. The caller's own client (RLS).
 */
export async function readCustomerBook<T = DupCustomer>(
  supabase: SupabaseClient,
  columns = "id, name, company_name, email, phone",
): Promise<{ rows: T[]; error: unknown }> {
  const rows: T[] = [];
  for (let from = 0; ; from += CUSTOMER_BOOK_PAGE) {
    const { data, error } = await supabase
      .from("customers")
      .select(columns)
      .order("id")
      .range(from, from + CUSTOMER_BOOK_PAGE - 1);
    if (error) return { rows: [], error };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < CUSTOMER_BOOK_PAGE) return { rows, error: null };
  }
}

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
 *
 * `name` is the customer AS THE BOOK HOLDS THEM: a match on a phone or an email can be somebody typed
 * under another spelling ("Sam Tilery" typed, Sam Tillery on file), and a caller that says who was set
 * must say the name on file, never the one typed (skeptic #60).
 */
export async function matchOrCreateCustomer(
  supabase: SupabaseClient,
  userId: string | null,
  typed: { name: string; phone?: string | null; email?: string | null },
): Promise<{ ok: true; id: string; matched: boolean; name: string } | { ok: false; error: string }> {
  const name = String(typed.name ?? "").trim();
  if (!name) return { ok: false, error: NEW_CUSTOMER_NEEDS_A_NAME };
  const phone = formatPhone(String(typed.phone ?? "").trim());
  const email = String(typed.email ?? "").trim();

  const { rows, error: bookErr } = await readCustomerBook(supabase);
  if (bookErr) return { ok: false, error: "Couldn't check your customer list just now, so no customer was made. Try again." };
  const match = findMatchingCustomerId({ name, phone, email }, rows);
  if (match) {
    const onFile = String(rows.find((c) => c.id === match)?.name ?? "").trim();
    return { ok: true, id: match, matched: true, name: onFile || name };
  }

  const { data, error } = await supabase
    .from("customers")
    .insert({ name, phone: phone || null, email: email || null, status: "active", created_by: userId })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: dbError(error) };
  return { ok: true, id: (data as { id: string }).id, matched: false, name };
}
