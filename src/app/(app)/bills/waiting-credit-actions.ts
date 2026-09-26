"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { isMissingWaitColumn, WAIT_NEEDS_UPDATE } from "./supplier-papers";
import { CREDIT_WAIT_DAYS } from "./supplier-reconcile";
import type { SupplierActionResult } from "./supplier-balance";

/**
 * WAITING ON A CREDIT (Erik, 2026-09-26; 0346).
 *
 * CED billed 8802-1107139 ($59.17, 13683 HILLSIDE) for the replacement of a faulty switch, and a
 * CED credit memo for the same amount will take it back off. Until the credit arrives there is no
 * right answer on the card (not a job, not the shelf, not a business cost), so a person says "it's
 * waiting on a credit" and the card steps off My Day and Needs You. It is listed, folded, under its
 * supplier on /bills, and it comes back as a card by itself after CREDIT_WAIT_DAYS with no credit
 * paired (supplier-reconcile.ts, creditWait). A credit that does pair hides it the way every return
 * is hidden (reversedPurchaseIds).
 *
 * A PERSON SAYS SO; THE APP NEVER DOES. Staff only (supplier costs), every write names the org as
 * well as the paper (RLS is the second lock), and every write reads its row back: a zero-row
 * update is a 204 that reads exactly like success.
 *
 * BEFORE 0346 IS APPLIED the columns are not there, and the button says so in words rather than
 * failing: "Waiting On A Credit needs one database update."
 */

type Ctx = { supabase: any; userId: string; orgId: string };

async function staffCtx(): Promise<Ctx | { error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { error: ctx.error ?? "This is office-only." };
  if (!ctx.orgId) return { error: "Your sign-in isn't attached to a company yet. Ask an owner to check your account." };
  return { supabase: ctx.supabase, userId: ctx.userId, orgId: ctx.orgId };
}

function revalidate() {
  revalidatePath("/bills");
  revalidatePath("/planner"); // My Day's supplier cards read these same papers
}

/** "Waiting On A Credit": stamp who and when. Pressed again on a card that came back, it waits
 *  another CREDIT_WAIT_DAYS from today. */
export async function waitOnCredit(invoiceId: string): Promise<SupplierActionResult> {
  const ctx = await staffCtx();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const id = String(invoiceId ?? "").trim();
  if (!id) return { ok: false, error: "Which bill? Reload the page and try again." };

  const { data: inv, error: readErr } = await ctx.supabase
    .from("supplier_invoices")
    .select("id, invoice_number, kind, total")
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .maybeSingle();
  if (readErr) return { ok: false, error: `Couldn't read that bill just now, so nothing was changed. ${dbError(readErr)}` };
  if (!inv) return { ok: false, error: "That bill isn't here anymore. Reload the page." };
  const number = String((inv as { invoice_number?: string }).invoice_number ?? "").trim() || "That bill";
  // Only a purchase waits on a credit: a credit memo, a statement or interest never does.
  if ((inv as { kind?: string }).kind !== "invoice" || !(Number((inv as { total?: unknown }).total) > 0)) {
    return { ok: false, error: `${number} isn't a bill a credit could take back, so it can't wait on one.` };
  }

  const { data: wrote, error } = await ctx.supabase
    .from("supplier_invoices")
    .update({ waiting_credit_since: new Date().toISOString(), waiting_credit_by: ctx.userId })
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: isMissingWaitColumn(error) ? WAIT_NEEDS_UPDATE : `Nothing was changed. ${dbError(error)}` };
  if (!wrote?.length) return { ok: false, error: "Nothing was changed. That bill isn't here anymore, or this login can't change it." };
  revalidate();
  return {
    ok: true,
    message: `${number} is waiting on a credit. It's off your list and folded under its supplier on Bills; if no credit comes in ${CREDIT_WAIT_DAYS} days, it comes back here.`,
  };
}

/** Undo, and Stop Waiting: the bill is a card again, waiting on a person. */
export async function stopWaitingOnCredit(invoiceId: string): Promise<SupplierActionResult> {
  const ctx = await staffCtx();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const id = String(invoiceId ?? "").trim();
  if (!id) return { ok: false, error: "Which bill? Reload the page and try again." };
  const { data: wrote, error } = await ctx.supabase
    .from("supplier_invoices")
    .update({ waiting_credit_since: null, waiting_credit_by: null })
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .select("id, invoice_number");
  if (error) return { ok: false, error: isMissingWaitColumn(error) ? WAIT_NEEDS_UPDATE : `Nothing was changed. ${dbError(error)}` };
  if (!wrote?.length) return { ok: false, error: "Nothing was changed. That bill isn't here anymore, or this login can't change it." };
  revalidate();
  const number = String((wrote[0] as { invoice_number?: string }).invoice_number ?? "").trim() || "That bill";
  return { ok: true, message: `${number} isn't waiting any more. It's back on your list.` };
}
