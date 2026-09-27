"use server";

/**
 * ALREADY BILLED: THE DOORS' SERVER HALF (migration 0357).
 *
 *   alreadyBilledSheet      what the sheet offers for one cost (lib/already-billed-read)
 *   markAlreadyBilled       a line on a sent bill claims what it already charged for, by hand
 *   unmarkAlreadyBilled     Not Billed After All: only what a person marked comes back off
 *
 * Staff only here, and the functions run as the person (SECURITY INVOKER) so RLS refuses a tech in
 * the database too. Every write is read back from the function's own answer (the silent-write law)
 * and said in the office's words, with an Undo; a database without 0357 says it needs an update.
 * A mark changes a line's claim and nothing else: no invoice word, dollar or status moves, which
 * the function checks and refuses otherwise.
 */

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { reportError } from "@/lib/observe";
import { NEEDS_UPDATE, markedSentence } from "@/lib/already-billed";
import { isMissingAlreadyBilledRpc, loadAlreadyBilledSheet, type AlreadyBilledSheetData, type AlreadyBilledTarget } from "@/lib/already-billed-read";

export type AlreadyBilledSheetResult = { ok: true; data: AlreadyBilledSheetData } | { ok: false; error: string; needsUpdate?: boolean };

export async function alreadyBilledSheet(jobId: string, target: AlreadyBilledTarget): Promise<AlreadyBilledSheetResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const id = String(jobId ?? "");
  if (!id) return { ok: false, error: "Couldn't tell which job you meant. Nothing was changed." };
  try {
    return await loadAlreadyBilledSheet(ctx.supabase, ctx.orgId, id, target);
  } catch (e) {
    reportError("alreadyBilled.sheet", e, { jobId: id, kind: target?.kind });
    return { ok: false, error: "Couldn't open that just now. Nothing was changed - try again in a moment." };
  }
}

export type AlreadyBilledWrite = {
  ok: boolean;
  error?: string;
  needsUpdate?: boolean;
  message?: string;
  /** What Undo hands back: the same line and ids (a mark's Undo is an unmark, and the reverse). */
  undo?: { jobId: string; lineId: string; ids: string[]; what: string };
  invoiceNumber?: string | null;
};

type RpcAnswer = { line_id?: string; invoice_id?: string; invoice_number?: string | null; description?: string; line_total?: number | string; added?: string[]; removed?: string[] };

function said(what: string): string {
  return String(what ?? "").trim().slice(0, 200) || "That";
}

function revalidateAll(jobId: string, invoiceId?: string | null) {
  revalidatePath(`/jobs/${jobId}`);
  if (invoiceId) revalidatePath(`/billing/${invoiceId}`);
  revalidatePath("/bills");
  revalidatePath("/planner");
}

/**
 * MARK BILLED ON INV-x. `what` is the office's words for the thing ("CED 8802-1101475", "12.5 h of
 * Brian's time"), used in the sentence only. The function decides everything else.
 */
export async function markAlreadyBilled(input: { jobId: string; lineId: string; ids: string[]; what: string }): Promise<AlreadyBilledWrite> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const jobId = String(input?.jobId ?? "");
  const lineId = String(input?.lineId ?? "");
  const ids = [...new Set((input?.ids ?? []).map((x) => String(x ?? "")).filter(Boolean))];
  const what = said(input?.what);
  if (!jobId || !lineId) return { ok: false, error: "Pick the line that already charged for it. Nothing was changed." };
  if (!ids.length) return { ok: false, error: "Pick what that line already charged for. Nothing was changed." };
  const { data, error } = await ctx.supabase.rpc("mark_already_billed", { p_line: lineId, p_ids: ids });
  if (error) {
    if (isMissingAlreadyBilledRpc(error)) return { ok: false, error: NEEDS_UPDATE, needsUpdate: true };
    return { ok: false, error: dbError(error) };
  }
  const r = (data ?? null) as RpcAnswer | null;
  if (!r?.line_id || !(r.added ?? []).length) {
    reportError("alreadyBilled.mark", "no answer", { lineId });
    return { ok: false, error: "That didn't save. Nothing was changed - reload the page and try again." };
  }
  revalidateAll(jobId, r.invoice_id);
  return {
    ok: true,
    message: markedSentence(what, { invoice_number: r.invoice_number ?? null }, { description: String(r.description ?? ""), line_total: Number(r.line_total) || 0 }),
    undo: { jobId, lineId, ids: (r.added ?? []).map(String), what },
    invoiceNumber: r.invoice_number ?? null,
  };
}

/** NOT BILLED AFTER ALL: only what a person marked comes off (a split shift's pieces together). */
export async function unmarkAlreadyBilled(input: { jobId: string; lineId: string; ids: string[]; what: string }): Promise<AlreadyBilledWrite> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const jobId = String(input?.jobId ?? "");
  const lineId = String(input?.lineId ?? "");
  const ids = [...new Set((input?.ids ?? []).map((x) => String(x ?? "")).filter(Boolean))];
  const what = said(input?.what);
  if (!jobId || !lineId || !ids.length) return { ok: false, error: "Couldn't tell what should come off. Nothing was changed." };
  const { data, error } = await ctx.supabase.rpc("unmark_already_billed", { p_line: lineId, p_ids: ids });
  if (error) {
    if (isMissingAlreadyBilledRpc(error)) return { ok: false, error: NEEDS_UPDATE, needsUpdate: true };
    return { ok: false, error: dbError(error) };
  }
  const r = (data ?? null) as RpcAnswer | null;
  if (!r?.line_id || !(r.removed ?? []).length) {
    reportError("alreadyBilled.unmark", "no answer", { lineId });
    return { ok: false, error: "That didn't save. Nothing was changed - reload the page and try again." };
  }
  revalidateAll(jobId, r.invoice_id);
  const num = r.invoice_number ?? "that bill";
  return {
    ok: true,
    message: `${what} is off ${num} and back in Not Billed Yet. Nothing on ${num} changed.`,
    undo: { jobId, lineId, ids: (r.removed ?? []).map(String), what },
    invoiceNumber: r.invoice_number ?? null,
  };
}
