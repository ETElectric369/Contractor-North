"use server";

import { dbError } from "@/lib/db-error";
import { requireStaff } from "@/lib/staff-guard";
import { signDocumentUrls } from "@/lib/signed-docs";
import { paperContents, type PaperContents } from "@/lib/supplier-paper-contents";

export type SupplierPaperContentsResult = { ok: true; contents: PaperContents } | { ok: false; error: string };

/**
 * WHAT'S ON IT: the Supplier Bills card's read of one paper's lines (Erik, 2026-09-26: "i need to
 * open the bill to see whats on it to be able to approve or deny").
 *
 * STAFF ONLY: these are supplier costs, and a tech never sees a price. Every read names the org
 * as well as the id (RLS is the second lock, not the only one), and the lines come back in the
 * order CED printed them. Read-only: nothing here writes a row.
 *
 * THE PDF. The CED import keeps the file's NAME in supplier_invoices.source_file, not the file. A
 * PDF is stored only when the paper came in through Drop Paperwork: its organized_items row holds
 * the file (file_url, the documents bucket, signed exactly as the Bills tray signs it) and lists
 * EVERY invoice number read off it (proposal.ced.numbers). Not proposal.filed.landed: that holds
 * only the numbers the paper added for the first time, so a PDF dropped for an invoice already
 * pasted in would go unfound. landed is always inside ced.numbers (same parser, same text). A
 * documents row whose file_url IS the source_file (0326's reading) counts too. Neither found:
 * the card says there is no PDF here.
 */
export async function supplierPaperContents(invoiceId: string): Promise<SupplierPaperContentsResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is office-only." };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet. Ask an owner to check your account." };
  const orgId = ctx.orgId;
  const id = String(invoiceId ?? "").trim();
  if (!id) return { ok: false, error: "Which paper? Reload the page and try again." };

  const { data: inv, error: invErr } = await ctx.supabase
    .from("supplier_invoices")
    .select("id, invoice_number, tax, shipping, total, source_file")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (invErr) return { ok: false, error: dbError(invErr) };
  if (!inv) return { ok: false, error: "That paper isn't here anymore. Reload the page." };
  const row = inv as { invoice_number?: string | null; tax?: unknown; shipping?: unknown; total?: unknown; source_file?: string | null };
  const number = String(row.invoice_number ?? "").trim();
  const sourceFile = String(row.source_file ?? "").trim();

  const [linesRes, docRes, dropRes] = await Promise.all([
    ctx.supabase
      .from("supplier_invoice_lines")
      .select("description, part_number, quantity, unit_price, extension, sort_order")
      .eq("org_id", orgId)
      .eq("supplier_invoice_id", id)
      .order("sort_order", { ascending: true }),
    sourceFile
      ? ctx.supabase.from("documents").select("file_url").eq("org_id", orgId).eq("file_url", sourceFile).limit(1)
      : Promise.resolve({ data: [], error: null }),
    number
      ? ctx.supabase
          .from("organized_items")
          .select("file_url")
          .eq("org_id", orgId)
          .contains("proposal", { ced: { numbers: [number] } })
          .not("file_url", "is", null)
          .limit(1)
      : Promise.resolve({ data: [], error: null }),
  ]);
  // The lines ARE the answer: without them the card says the read failed, with Try Again.
  if (linesRes.error) return { ok: false, error: dbError(linesRes.error) };

  const stored =
    ((docRes.data as { file_url?: string | null }[] | null)?.[0]?.file_url ?? null) ||
    ((dropRes.data as { file_url?: string | null }[] | null)?.[0]?.file_url ?? null);
  const pdfUrl = stored ? ((await signDocumentUrls(ctx.supabase, [stored])).get(stored) ?? null) : null;

  return {
    ok: true,
    contents: paperContents({
      invoice: row,
      lines: (linesRes.data ?? []) as any[],
      pdfUrl,
      pdfUnsignable: !!stored && !pdfUrl,
      // A failed PDF check is said on the card; the lines still show.
      pdfCheckFailed: !stored && !!(docRes.error || dropRes.error),
    }),
  };
}
