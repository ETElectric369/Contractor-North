import { NextRequest, NextResponse } from "next/server";
import { contentDisposition } from "@/lib/content-disposition";
import { createServiceClient } from "@/lib/supabase/server";
import { CUSTOMER_VISIBLE_STATUSES } from "@/lib/pdf-cache";

export const dynamic = "force-dynamic";

/**
 * THE CUSTOMER'S PDF DOOR (Erik: "the pdf isnt showing for the customer its still just an
 * unformatted screen").
 *
 * The real PDF engine is staff-gated, so until now a customer's only path to a file was
 * window.print() — the browser dialog, which on a phone is exactly the run-on unformatted mess
 * Erik described. This route streams the STORED copy (0198) to whoever holds the share token:
 * the same trust model as the /i and /q pages themselves, where the token IS the credential.
 *
 * NO CHROMIUM EVER RUNS HERE. A customer can only receive bytes a staff render already
 * produced (preview, or the send-time warm). No stored copy — or a copy whose stored status
 * no longer matches the doc — is a 404, and the public page simply doesn't offer the button.
 * That also makes this door abuse-proof: it is a read of one small private-storage object,
 * never a ~150MB render some stranger can spin up by guessing tokens.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(token)) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const svc = createServiceClient();

  // Token → doc. Service client, but the ONLY filter is the token itself — the same
  // credential the public pages accept — plus the same status sets as the 0187 RPCs.
  type ShareRow = { id: string; status: string; invoice_number?: string | null };
  let doc: "invoice" | "quote" | null = null;
  let row: ShareRow | null = null;
  const { data: inv } = await svc
    .from("invoices")
    .select("id, status, invoice_number")
    .eq("public_token", token)
    .maybeSingle();
  if (inv && CUSTOMER_VISIBLE_STATUSES.invoice.includes(String((inv as ShareRow).status))) {
    doc = "invoice";
    row = inv as ShareRow;
  } else {
    const { data: q } = await svc.from("quotes").select("id, status").eq("public_token", token).maybeSingle();
    if (q && CUSTOMER_VISIBLE_STATUSES.quote.includes(String((q as ShareRow).status))) {
      doc = "quote";
      row = q as ShareRow;
    }
  }
  if (!doc || !row) return NextResponse.json({ error: "Not found." }, { status: 404 });

  // Any margin will do (staff's last choice); the status must still match the copy's.
  const { data: hit } = await svc
    .from("doc_pdf_cache")
    .select("path")
    .eq("doc", doc)
    .eq("doc_id", row.id)
    .eq("doc_status", String(row.status))
    .order("margin", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!hit?.path) return NextResponse.json({ error: "No PDF available yet." }, { status: 404 });

  const { data: blob } = await svc.storage.from("doc-pdfs").download(hit.path);
  if (!blob) return NextResponse.json({ error: "No PDF available yet." }, { status: 404 });

  const filename =
    doc === "invoice" && row.invoice_number ? `Invoice ${row.invoice_number}.pdf` : `${doc}-${row.id.slice(0, 8)}.pdf`;
  return new NextResponse(Buffer.from(await blob.arrayBuffer()) as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      // ASCII fallback + RFC 5987 UTF-8 (audit: the Badger Lane em-dash killed the response).
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
