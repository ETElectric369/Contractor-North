"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { proposalOf } from "@/lib/paperwork";
import { applyingNow, swapDownloadSigns, withAccountLast4, type BankDownload, type StoredBank } from "@/lib/bank-download";
import { applyBankCore, proposalAfterUndo, sha256Hex, undoBankCore } from "./bank-core";
import { OWNER_SORTS_BANK, viewerSortsBank } from "@/lib/bank-viewer";

/**
 * A BANK DOWNLOAD'S BUTTONS (2026-09-27). There is no import button: the download arrives through
 * Snap Or Note, Organize or Money's "Drop Your Bank Download" line (addOpenList recognises it)
 * and waits under Needs You on Bills as one card. These are that card's Apply and Undo. Staff only: a tech
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
  if (!(await viewerSortsBank(ctx.supabase, ctx.userId))) return { ok: false, error: OWNER_SORTS_BANK };
  const picks = opts?.picks && typeof opts.picks === "object" ? opts.picks : {};
  const res = await applyBankCore(ctx.supabase, { orgId: ctx.orgId, userId: ctx.userId }, String(id ?? ""), {
    fingerprint: String(opts?.fingerprint ?? ""),
    picks,
  });
  revalidateBank();
  return res;
}

/**
 * MONEY IN AND OUT THE OTHER WAY ROUND: a card's download that prints its charges as positive and
 * wasn't recognised as one (or was, wrongly). Only before anything is applied from it: after that,
 * its lines are in bank_lines under the sign they were counted with, and Undo comes first.
 */
export async function swapBankDownload(id: string): Promise<Result> {
  const res = await reworkDownload(id, "swap money in and out", (dl) => swapDownloadSigns(dl, sha256Hex));
  if (!res.ok) return res;
  return { ok: true, message: res.download.swapped ? "Swapped: charges are money out now." : "Swapped back: money in and out read as the file prints them." };
}

/**
 * FORGET A RULE: an answer the company remembered for a merchant (from a tap on an earlier download)
 * comes off, and that merchant's lines are asked again from the next look. The lines it already
 * placed stay as they were counted; Undo on their download is how those come off.
 */
export async function forgetBankRule(ruleId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  if (!(await viewerSortsBank(ctx.supabase, ctx.userId))) return { ok: false, error: OWNER_SORTS_BANK };
  const { data, error } = await ctx.supabase.from("bank_rules").delete().eq("id", String(ruleId ?? "")).eq("org_id", ctx.orgId).select("merchant_key");
  if (error) return { ok: false, error: `Nothing was forgotten. ${dbError(error)}` };
  if (!data?.length) return { ok: false, error: "That answer was already forgotten." };
  revalidateBank();
  return { ok: true, message: `Forgotten: ${String(data[0].merchant_key ?? "").toUpperCase()} is asked again from now on.` };
}

/**
 * WHICH ACCOUNT IS IT: a download with no account column (and none in its name) is told its last 4,
 * so the same fee on two accounts' downloads is never taken for one line. Four digits and no more.
 */
export async function setBankAccount(id: string, last4: string): Promise<Result> {
  const four = String(last4 ?? "").trim();
  if (!/^\d{4}$/.test(four)) return { ok: false, error: "Type the last 4 digits of the account, and only those." };
  const res = await reworkDownload(id, "say which account it is", (dl) => withAccountLast4(dl, four, sha256Hex));
  if (!res.ok) return res;
  return { ok: true, message: `Saved: this download is the account ending ${four}.` };
}

/** Rework a download's lines before anything is applied from it (their keys are nowhere yet). */
async function reworkDownload(id: string, what: string, change: (dl: BankDownload) => BankDownload): Promise<{ ok: true; download: BankDownload } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error) };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  if (!(await viewerSortsBank(ctx.supabase, ctx.userId))) return { ok: false, error: OWNER_SORTS_BANK };
  const { data: item } = await ctx.supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!item) return { ok: false, error: "That bank download isn't here any more." };
  const p = proposalOf(item);
  const stored = p.bankImport as StoredBank | undefined;
  if (!stored?.download) return { ok: false, error: "This paper isn't a bank download." };
  if (item.status !== "needs_review" || (stored.applied?.length ?? 0) > 0 || applyingNow(stored))
    return { ok: false, error: `Some of this download is already counted. Undo it first, then ${what}.` };
  const download = change(stored.download);
  const { data: back, error } = await ctx.supabase
    .from("organized_items")
    .update({ proposal: { ...p, bankImport: { ...stored, download } } })
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .eq("status", "needs_review")
    .select("id");
  if (error) return { ok: false, error: `Nothing was changed. ${dbError(error)}` };
  if (!back?.length) return { ok: false, error: "Nothing was changed: the download was applied or removed from another screen." };
  revalidateBank();
  return { ok: true, download };
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
  if (!(await viewerSortsBank(ctx.supabase, ctx.userId))) return { ok: false, error: OWNER_SORTS_BANK };
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
      message: `Undone: ${down.undone} ${down.undone === 1 ? "line" : "lines"} came off. The card didn't go back under Needs You${error ? ` (${dbError(error)})` : ""}; refresh the page.`,
    };
  }
  return {
    ok: true,
    message:
      `Undone: ${down.undone} ${down.undone === 1 ? "line" : "lines"} came off, and the download waits again.` +
      (down.left.length ? ` Left as they are now: ${down.left.join("; ")}.` : ""),
  };
}
