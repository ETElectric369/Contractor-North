"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { decideReceiptLine } from "@/app/(app)/bills/receipt-billing";
import { penMarkOf } from "@/lib/pen-marks";

/**
 * KEPT OR RETURNED, ON A PAPER STILL WAITING IN THE TRAY (cn-v1181, lib/pen-marks).
 *
 * The reader says what ink it saw on each line; a person confirms it here before filing, one line
 * at a time, and File It then carries the answer to the bill (cleanLines keeps an explicit
 * `returned`, see applyPenMark). One narrow write on the paper's own stored lines and nothing else:
 *
 *   · RETURNED: `returned: true`, off the customer's bill (`billable: false`, no part-used amount);
 *     a mark nobody could read becomes `struck`, the question answered.
 *   · KEPT: `returned: false`; a mark nobody could read is removed; whether the customer pays goes
 *     back to what the line's own words say with nothing stored (decideReceiptLine: a snack stays off).
 *
 * The line is named by its place on the paper AND its words: the lines can change under a person
 * (Read Again, another screen), and an answer must never land on a different line. A paper filed
 * meanwhile is answered on its bill, never here. Every write is read back.
 */
export async function setPaperLineReturned(
  itemId: string,
  index: number,
  returned: boolean,
  expectDescription: string,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (typeof returned !== "boolean" || !Number.isInteger(index) || index < 0)
    return { ok: false, error: "That answer didn't come through whole. Reload the page and answer again. Nothing changed." };

  const { data: item, error: readErr } = await supabase
    .from("organized_items")
    .select("id, status, line_items")
    .eq("id", itemId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: `${dbError(readErr)} Nothing changed.` };
  if (!item) return { ok: false, error: "That paper isn't here any more. Reload the page." };
  if (item.status !== "needs_review")
    return { ok: false, error: "This paper is already filed, so answer that line on its bill instead. Nothing changed here." };

  const lines: Record<string, unknown>[] = Array.isArray(item.line_items) ? (item.line_items as Record<string, unknown>[]) : [];
  const line = lines[index];
  const said = String(line?.description ?? "").trim();
  if (!line || typeof line !== "object" || said !== String(expectDescription ?? "").trim())
    return { ok: false, error: "The lines on this paper changed since the page opened. Reload the page and answer again. Nothing changed." };
  const pen = penMarkOf(line.pen);
  if (!pen) return { ok: false, error: "That line has no pen mark on it to answer. Nothing changed." };

  const next: Record<string, unknown> = { ...line };
  if (returned) {
    next.returned = true;
    next.billable = false;
    delete next.billed_amount;
    if (pen === "unclear") next.pen = "struck";
  } else {
    next.returned = false;
    if (pen === "unclear") delete next.pen;
    next.billable = decideReceiptLine(said, typeof line.category === "string" ? line.category : null, undefined).billable;
  }
  const after = lines.map((l, i) => (i === index ? next : l));

  const { data: wrote, error: writeErr } = await supabase
    .from("organized_items")
    .update({ line_items: after })
    .eq("id", itemId)
    .eq("org_id", ctx.orgId)
    .eq("status", "needs_review")
    .select("id");
  if (writeErr) return { ok: false, error: `${dbError(writeErr)} Nothing changed.` };
  if (!wrote?.length)
    return { ok: false, error: "This paper was filed or changed just now, so the answer didn't save. Reload the page and look again." };

  revalidatePath("/organize");
  revalidatePath("/bills");
  return { ok: true, message: returned ? `${said}: off the customer's bill.` : `${said}: kept.` };
}
