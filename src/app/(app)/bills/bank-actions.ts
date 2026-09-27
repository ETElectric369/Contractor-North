"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { proposalOf } from "@/lib/paperwork";
import { applyingNow } from "@/lib/bank-download";
import { applyBankCore, proposalAfterUndo, undoBankCore } from "./bank-core";

/**
 * A BANK DOWNLOAD'S BUTTONS (2026-09-27). There is no import button: the download arrives through
 * Drop Paperwork, Organize or Money's "Drop Your Bank Download" line (addOpenList recognises it)
 * and waits in Sort These as one card. These are that card's Apply and Undo. Staff only: a tech
 * never sees a bank line (0363 RLS), and requireStaff says no before anything is read.
 */

type Result = { ok: boolean; error?: string; message?: string; stale?: boolean };

function revalidateBank() {
  revalidatePath("/bills");
  revalidatePath("/organize");
  revalidatePath("/planner");
  revalidatePath("/analytics");
  revalidatePath("/billing");
  revalidatePath("/payroll");
  revalidatePath("/petty-cash");
}

/** APPLY, once, as the card showed it: `picks` is row id → answer id for the rows a person answered. */
export async function applyBankDownload(id: string, opts: { fingerprint: string; picks?: Record<string, string> | null }): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const picks = opts?.picks && typeof opts.picks === "object" ? opts.picks : {};
  const res = await applyBankCore(ctx.supabase, { orgId: ctx.orgId, userId: ctx.userId }, String(id ?? ""), {
    fingerprint: String(opts?.fingerprint ?? ""),
    picks,
  });
  revalidateBank();
  return res;
}

/**
 * UNDO A WHOLE DOWNLOAD: everything it wrote that nobody has touched since comes off, its marks
 * come off what it matched, the answers it taught are forgotten, and the card waits again with
 * every line. Whatever stays is named.
 */
export async function undoBankDownload(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const { data: item } = await ctx.supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!item) return { ok: false, error: "That bank download isn't here any more." };
  const p = proposalOf(item);
  if (!p.bankImport) return { ok: false, error: "This paper isn't a bank download." };
  if (applyingNow(p.bankImport)) return { ok: false, error: "This download is being applied right now. Wait a moment, then Undo." };
  const down = await undoBankCore(ctx.supabase, ctx.orgId, ctx.userId, String(item.id));
  if (!down.ok) return { ok: false, error: down.error };
  const { data: back, error } = await ctx.supabase
    .from("organized_items")
    .update({ status: "needs_review", proposal: proposalAfterUndo(p) })
    .eq("id", item.id)
    .eq("org_id", ctx.orgId)
    .select("id");
  revalidateBank();
  if (error || !back?.length) {
    return {
      ok: true,
      message: `Undone: ${down.undone} ${down.undone === 1 ? "line" : "lines"} came off. The card didn't go back to Sort These${error ? ` (${dbError(error)})` : ""}; refresh the page.`,
    };
  }
  return {
    ok: true,
    message:
      `Undone: ${down.undone} ${down.undone === 1 ? "line" : "lines"} came off, and the download waits again.` +
      (down.left.length ? ` Left as they are now: ${down.left.join("; ")}.` : ""),
  };
}
