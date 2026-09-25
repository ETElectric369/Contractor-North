"use server";

import { revalidatePath } from "next/cache";
import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { isSha256 } from "@/lib/content-hash";
import { parseCedDocuments } from "@/lib/ced-invoice-parse";
import { formatDate } from "@/lib/utils";
import { linesPointWithTotal, paperTypeOf, proposalOf, readinessOf, type PaperProposal } from "@/lib/paperwork";
import { importCedInvoices } from "@/app/(app)/bills/supplier-import-actions";
import { cleanDocNumber, insertPaperRow, updateItemTolerant } from "./paperwork-core";

/**
 * DROP PAPERWORK: THE DOORS AROUND FILE IT (dropbox plan, Phase 1; 0295).
 *
 * A file lands in storage, becomes a needs_review row here, is read (actions.ts readPaperworkItem),
 * and waits. File It, Undo and Tie are in actions.ts beside the teardown they share. This file
 * holds the rest: the "Already In" check before upload, the row, a person's own corrections, the
 * CED path (a CED PDF goes on the supplier documents list, which is what those are, never a bill),
 * and Keep It In Files for paper that is not a cost.
 */

export type PaperResult = { ok: boolean; error?: string; message?: string };

const ALREADY = (row: { status?: string | null; created_at?: string | null; jobs?: { job_number?: string | null; name?: string | null } | null; bill_id?: string | null }) => {
  const when = row.created_at ? formatDate(row.created_at) : "earlier";
  if (row.status === "needs_review") return `Already In: added ${when}, waiting in the tray to be filed.`;
  if (row.status === "archived") return `Already In: added ${when} and kept in files.`;
  const where = row.jobs?.job_number ? `on ${row.jobs.job_number}${row.jobs.name ? ` ${row.jobs.name}` : ""}` : row.bill_id ? "as a business cost" : "in files";
  return `Already In: filed ${when} ${where}.`;
};

/**
 * THE SAME FILE, BEFORE IT IS UPLOADED. Asked with the fingerprint the browser took, so a file that
 * is already in is never uploaded, stored or read a second time. The database's unique index
 * (0295) stands behind this for the two-tabs race.
 */
export async function fingerprintSeen(sha256: string): Promise<{ ok: boolean; seen: string | null; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, seen: null, error: ctx.error };
  if (!isSha256(sha256)) return { ok: true, seen: null };
  const { data, error } = await ctx.supabase
    .from("organized_items")
    .select("id, status, created_at, bill_id, jobs(job_number, name)")
    .eq("org_id", ctx.orgId)
    .eq("content_sha256", sha256)
    .limit(1);
  // Before 0295 the column is not there: nothing has a fingerprint, so nothing is "already in".
  if (error) return { ok: true, seen: null };
  const row = ((data ?? []) as unknown as Parameters<typeof ALREADY>[0][])[0];
  return { ok: true, seen: row ? ALREADY(row) : null };
}

/**
 * The row a dropped file becomes, the moment it is in storage and before anything reads it.
 *
 * `pdfText` is the text layer the browser read out of a PDF (lib/pdf-text). When it holds CED
 * documents that pass their own arithmetic, the paper is proposed as CED documents and no model
 * reads it at all: an invoice total is never a language model's to transcribe when the supplier
 * printed it as text.
 */
export async function addPaperwork(input: {
  path: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  source?: "bills_drop" | "organize";
  pdfText?: string | null;
}): Promise<PaperResult & { id?: string; already?: string; needsRead?: boolean; line?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const name = String(input.name ?? "").trim() || "Paper";
  // The file must be in THIS org's staff-only organize folder (0213), not a path from anywhere.
  if (!ctx.orgId || !String(input.path ?? "").startsWith(`${ctx.orgId}/organize/`))
    return { ok: false, error: `${name} wasn't saved where paperwork goes, so it wasn't added.` };
  const isPdf = input.mime === "application/pdf";
  const isImage = /^image\/(jpeg|png|webp|gif)$/.test(String(input.mime ?? ""));
  if (/^image\/hei[cf]$/i.test(String(input.mime ?? "")))
    return { ok: false, error: `${name} is a HEIC photo this device couldn't convert. Save it as JPEG and drop it again.` };
  if (!isPdf && !isImage) return { ok: false, error: `${name} isn't a PDF, JPEG or PNG, so it wasn't added.` };
  if (!isSha256(input.sha256)) return { ok: false, error: `${name} couldn't be fingerprinted, so it wasn't added. Try again.` };

  const seen = await fingerprintSeen(input.sha256);
  if (seen.seen) return { ok: false, already: seen.seen, error: `${name}: ${seen.seen}` };

  // A CED PDF, read from its own text. Only documents that reconciled are proposed; every one in
  // the same PDF that did not add up is carried on the proposal (and in the drop line) as a
  // sentence rather than dropped, so "CED documents found in it" never hides the one that wasn't.
  let proposal: PaperProposal | null = null;
  let doc_type: "supplier_documents" | null = null;
  let vendor: string | null = null;
  let amount: number | null = null;
  let item_date: string | null = null;
  let doc_number: string | null = null;
  const text = isPdf ? String(input.pdfText ?? "") : "";
  if (text.trim()) {
    const read = parseCedDocuments(text);
    const good = read.flatMap((r) => (r.ok ? [r.invoice] : []));
    const refused = read.flatMap((r) => (r.ok ? [] : [{ number: r.invoiceNumber, error: r.error }]));
    if (good.length) {
      const total = Math.round(good.reduce((s, d) => s + d.total, 0) * 100) / 100;
      proposal = {
        ced: {
          numbers: good.map((d) => d.invoiceNumber),
          total,
          kinds: good.map((d) => d.kind),
          text: text.slice(0, 200_000),
          name,
          ...(refused.length ? { refused } : {}),
        },
      };
      doc_type = "supplier_documents";
      vendor = "CED";
      amount = total;
      item_date = good[0].invoiceDate;
      doc_number = good.length === 1 ? good[0].invoiceNumber : null;
    }
  }

  const placed = await insertPaperRow(ctx.supabase, {
    title: doc_type ? `CED ${proposal?.ced?.numbers.join(", ")}`.slice(0, 200) : name,
    file_url: input.path,
    created_by: ctx.userId,
    content_sha256: input.sha256,
    source: input.source ?? "bills_drop",
    doc_type,
    doc_number,
    vendor,
    amount,
    item_date,
    kind: doc_type ? "job_document" : undefined,
    proposal,
    confidence: doc_type ? "high" : "low",
  });
  if ("duplicate" in placed) {
    const again = await fingerprintSeen(input.sha256);
    const said = again.seen ?? "Already In.";
    return { ok: false, already: said, error: `${name}: ${said}` };
  }
  if ("error" in placed) return { ok: false, error: `${name} wasn't added. ${dbError(placed.error)}` };

  revalidatePath("/bills");
  revalidatePath("/organize");
  return { ok: true, id: placed.id, needsRead: !doc_type, line: doc_type ? cedDropLine(proposal) : undefined };
}

/** What the drop line says for a CED PDF: how many were read, and every one that didn't add up. */
function cedDropLine(p: PaperProposal | null): string {
  const n = p?.ced?.numbers.length ?? 0;
  const refused = p?.ced?.refused ?? [];
  const found = `${n} CED ${n === 1 ? "document" : "documents"} found in it`;
  const bad = refused.length
    ? `; ${refused.length} didn't add up and won't be added: ${refused.map((r) => r.error).join("; ")}`
    : "";
  return `${found}${bad}. Waiting below: press Add To CED Documents.`;
}

/**
 * FIX DETAILS: a person's own corrections, which beat the reader. Only while the paper is still in
 * the tray; a filed paper is un-filed first (Undo), so the bill it made and the row never
 * disagree.
 */
export async function updatePaperwork(
  id: string,
  fields: {
    doc_type?: string | null;
    vendor?: string | null;
    amount?: number | null;
    item_date?: string | null;
    doc_number?: string | null;
    payment?: string | null;
  },
  /** A person looked at a paper read as a credit memo and says it really is a charge (see below). */
  opts: { creditIsACharge?: boolean } = {},
): Promise<PaperResult & { askCharge?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  // `*` so a database without 0295's doc_type still answers (the column is simply not there).
  const { data: item } = await ctx.supabase
    .from("organized_items")
    .select("*")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!item) return { ok: false, error: "That paper isn't here any more." };
  if (item.status !== "needs_review") return { ok: false, error: "This is already filed. Undo it first, then fix it." };

  const type = paperTypeOf(fields.doc_type);
  if (fields.doc_type !== undefined && !type) return { ok: false, error: "Pick what kind of paper it is." };
  if (type === "supplier_documents") return { ok: false, error: "CED documents are recognised from the PDF itself; pick Bill instead." };
  const amount = fields.amount === null || fields.amount === undefined || (fields.amount as unknown) === "" ? null : Number(fields.amount);
  if (amount !== null && !Number.isFinite(amount)) return { ok: false, error: "The total has to be a number." };
  const itemDate = /^\d{4}-\d{2}-\d{2}$/.test(String(fields.item_date ?? "")) ? String(fields.item_date) : null;
  const payment = ["paid_at_purchase", "on_account", "unknown"].includes(String(fields.payment ?? "")) ? String(fields.payment) : null;

  /**
   * A CREDIT MEMO SWITCHED TO A BILL KEEPS ITS SIGN (audit v994, DB4). Credit memos wait in the tray
   * ("a later update"), so Fix Details → Bill is how a return reaches a job, and it is the right
   * move: a return is a negative bill. But a credit memo turned into a bill with a POSITIVE total is
   * a charge for the goods that went back - the customer billed for parts they returned. A misread
   * paper (a real bill the reader called a credit) is possible too, so this asks rather than
   * blocks: the person says which it is, and the button that says "it is a charge" passes.
   */
  const wasCredit = paperTypeOf((item as { doc_type?: unknown }).doc_type) === "credit_memo";
  if (wasCredit && (type === "bill" || type === "receipt") && amount !== null && Math.round(amount * 100) > 0 && !opts.creditIsACharge) {
    return {
      ok: false,
      askCharge: true,
      error: `This was read as a credit memo: money coming back to you. A return goes on a job as a negative total, -${Math.abs(amount).toFixed(2)}, so it comes off the customer's bill. If it really is a ${type} you paid or owe, press It Is A Charge.`,
    };
  }

  const patch: Record<string, unknown> = {
    vendor: fields.vendor ? String(fields.vendor).trim().slice(0, 200) || null : null,
    amount,
    item_date: itemDate,
    doc_number: cleanDocNumber(fields.doc_number),
  };
  // THE LINES TURN WITH THE TOTAL A PERSON TYPED (audit v994 review). The reader lined them up with
  // the total IT read; a person who types the other sign here (a return's -51.58 on a paper read
  // as a bill, or It Is A Charge on one read as a credit memo) would otherwise leave the row, and
  // the bill File It makes from it, pointing both ways at once. insertItemizedBill holds the same
  // rule where the bill is written; this keeps the tray row itself telling the truth.
  if (amount !== null && Array.isArray(item.line_items) && item.line_items.length) {
    const turned = linesPointWithTotal(amount, item.line_items as { amount?: unknown; unit_price?: unknown }[]);
    if (turned !== item.line_items) patch.line_items = turned;
  }
  if (type) {
    patch.doc_type = type;
    // The kind follows the type, so a paper a person called a bill gets the cost controls.
    patch.kind = type === "receipt" || type === "bill" ? "receipt" : item.kind === "receipt" ? "job_document" : item.kind;
    if (type === "receipt" || type === "bill") patch.category = type === "bill" ? "Bill" : "Receipt";
    patch.payment = type === "receipt" || type === "bill" ? (payment ?? "unknown") : null;
  } else if (payment) {
    patch.payment = payment;
  }
  const { data: back, error } = await updateItemTolerant(ctx.supabase, id, ctx.orgId, patch);
  if (error) return { ok: false, error: dbError(error) };
  if (!back?.length) return { ok: false, error: "Nothing was saved. That paper isn't here any more, or this login can't change it." };
  revalidatePath("/bills");
  revalidatePath("/organize");
  return { ok: true, message: "Saved." };
}

/**
 * KEEP IT IN FILES: paper that is not a cost (or a kind this update does not file) goes to the
 * archive, found again from Organize. Not a delete, and Undo brings it back.
 */
export async function keepPaperwork(id: string): Promise<PaperResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: item } = await ctx.supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!item) return { ok: false, error: "That paper isn't here any more." };
  if (item.status !== "needs_review") return { ok: false, error: "This is already filed or kept." };
  const r = readinessOf(item);
  if (r.state === "ready" || r.state === "needs_total")
    return { ok: false, error: "This is a cost. File it on a job or as a business cost, or change its type in Fix Details." };
  const patch: Record<string, unknown> = { status: "archived" };
  if ("proposal" in item) patch.proposal = { ...proposalOf(item), filed: { how: "kept" } };
  const { data: back, error } = await ctx.supabase
    .from("organized_items")
    .update(patch)
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .eq("status", "needs_review")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!back?.length) return { ok: false, error: "Nothing was kept. That paper isn't here any more, or this login can't change it." };
  revalidatePath("/bills");
  revalidatePath("/organize");
  return { ok: true, message: "Kept in files. Find it in Organize, under Archive." };
}

/**
 * ADD TO CED DOCUMENTS: a CED PDF's documents go through the same importer the paste box uses,
 * with every one of its rules (a re-import changes nothing, a job a person set is never touched,
 * the paid stamp only ever closes). The paper is then filed, and Undo takes off exactly the
 * documents THIS paper added.
 */
export async function addSupplierDocuments(id: string): Promise<PaperResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: item } = await ctx.supabase.from("organized_items").select("*").eq("id", id).eq("org_id", ctx.orgId).maybeSingle();
  if (!item) return { ok: false, error: "That paper isn't here any more." };
  if (item.status !== "needs_review") return { ok: false, error: "This is already filed. Undo it first." };
  const p = proposalOf(item);
  if (!p.ced?.text) return { ok: false, error: "No CED documents were found in this paper's text, so there is nothing to add." };

  const result = await importCedInvoices({ files: [{ name: p.ced.name || String(item.title ?? "CED PDF"), text: p.ced.text }] });
  if (!result.ok) return { ok: false, error: result.error ?? "Nothing was added." };
  // MERGED, never replaced: a second Add lands nothing (the importer only reports fresh inserts),
  // and overwriting the list with [] left Undo unable to remove what this paper first added.
  const landed = [...new Set([...(p.filed?.landed ?? []), ...result.landed.map((d) => d.invoiceNumber)])];
  const { data: back, error } = await ctx.supabase
    .from("organized_items")
    .update({ status: "filed", proposal: { ...p, filed: { how: "supplier_documents", landed } } })
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .eq("status", "needs_review")
    .select("id");
  if (error || !back?.length) {
    // The documents ARE in (the importer said so); only the paper's own row did not move.
    return {
      ok: true,
      message: `${result.message ?? "Added."} This paper is still showing in the tray; pressing Add again changes nothing, because the documents are already here.`,
    };
  }
  revalidatePath("/bills");
  revalidatePath("/organize");
  return { ok: true, message: result.message ?? "Added to the CED documents." };
}
