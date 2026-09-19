"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";

export type Result = { ok: boolean; error?: string };

/**
 * SWITCH ONE RECEIPT LINE OFF THE CUSTOMER'S BILL (migration 0268).
 *
 * This is the manual half of the Smartwater fix. The reader defaults food and drink to "not
 * billed" and everything else to billed; this is how Erik overrides either way, on the receipt,
 * before the importer ever turns it into an invoice line. A pair of gloves bought for one
 * homeowner's job is his to bill; a pair bought for the truck on the same receipt is not, and no
 * model will ever know which is which.
 *
 * NOTHING SILENT. `bill_line_items` is staff-only behind RLS, so a non-staff or cross-org caller
 * gets a zero-row UPDATE, and a zero-row UPDATE is a 204 that looks exactly like success. The
 * `.select("id")` is what turns that back into a refusal the screen can say out loud — the
 * silent-write law, the reason a screen must never be allowed to disagree with the database.
 */
export async function setReceiptLineBillable(lineId: string, billable: boolean): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  if (!lineId) return { ok: false, error: "Couldn't tell which receipt line you meant." };

  // The bill this line sits on, read through RLS: it gives the job page to revalidate, and it is a
  // second, independent statement that this row is visible to this org before anything is written.
  const { data: line } = await supabase
    .from("bill_line_items")
    .select("id, bill_id, bills(job_id)")
    .eq("id", lineId)
    .maybeSingle();
  if (!line) return { ok: false, error: "Couldn't find that receipt line. Reload the page and try again." };

  // org_id rides on the WRITE as well as the read. RLS already scopes this table, but a rule at
  // one read path is a convention, not a boundary (0173) — money columns get the explicit filter.
  let write = supabase.from("bill_line_items").update({ billable: !!billable }).eq("id", lineId);
  if (ctx.orgId) write = write.eq("org_id", ctx.orgId);
  const { data, error } = await write.select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data || data.length === 0) {
    return { ok: false, error: "That line wasn't changed. Reload the page and try again." };
  }

  const jobId = (line as { bills?: { job_id?: string | null } | null }).bills?.job_id ?? null;
  revalidatePath("/bills");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}
