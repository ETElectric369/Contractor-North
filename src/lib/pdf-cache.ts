import { createClient, createServiceClient } from "@/lib/supabase/server";

/**
 * THE STORED-PDF CACHE, SHARED HALF (0198).
 *
 * The staff door (/api/pdf) is self-correcting: it re-fingerprints the print HTML on every
 * request, so it can never serve a stale copy no matter what changed. The CUSTOMER door
 * (/api/share-pdf) cannot fingerprint — the print pages are staff-authed — so its freshness
 * rests on three explicit rules instead:
 *
 *   1. A copy stored while the doc was a DRAFT is never customer-served (doc_status gate —
 *      drafts aren't customer-visible anyway, and a draft copy is by definition mid-edit).
 *   2. The copy's stored status must equal the doc's CURRENT status — an overdue flip or a
 *      quote acceptance refuses the old copy rather than serving a wrong badge.
 *   3. The writes that change what a customer-visible doc RENDERS bust the cache here:
 *      payments (invoice balance) and quote line/meta edits (sent quotes stay editable).
 *
 * Everything is best-effort: a cache failure must never cost the action that triggered it.
 */

/** The same visibility sets as public_invoice / public_quote (0187). If 0187's WHERE clauses
 *  ever change, change these WITH them — the RPCs return no ids, so the share door has to
 *  mirror the law rather than reuse it. */
export const CUSTOMER_VISIBLE_STATUSES: Record<"invoice" | "quote", readonly string[]> = {
  invoice: ["sent", "partial", "paid", "overdue"],
  quote: ["sent", "accepted", "declined", "expired"],
};

/**
 * The signed-in caller's org, or null when there is no caller at all (Stripe webhooks, crons,
 * post-response jobs). A bust runs on the SERVICE role and is keyed by an id that came from a
 * client form, so without this it reaches ANY tenant's stored copies: audit v921 found org A
 * staff able to delete org B's customer-facing PDF by calling setInvoiceTitle with B's invoice
 * uuid — RLS made the update itself land zero rows, but the bust fired regardless and B's
 * customer got "No PDF available yet." on their own download. Pin the delete to the caller's
 * org (0173: a service-role write must carry an explicit org scope); a callerless service
 * context has no client-supplied id to distrust, so it busts as it always did.
 */
async function callerOrgId(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
    return (data as { org_id?: string } | null)?.org_id ?? null;
  } catch {
    return null; // no request scope (cron) — nothing to pin to
  }
}

/** Drop every stored copy of one document (all margins). Call from any write that changes
 *  what a customer-visible doc renders. Pass orgId when the caller already knows the doc's org. */
export async function bustDocPdf(doc: "invoice" | "quote", docId: string, orgId?: string | null): Promise<void> {
  try {
    const svc = createServiceClient();
    const org = orgId ?? (await callerOrgId());
    let sel = svc.from("doc_pdf_cache").select("path").eq("doc", doc).eq("doc_id", docId);
    if (org) sel = sel.eq("org_id", org); // audit v921 — never past the caller's tenant
    const { data: rows } = await sel;
    const paths = (rows ?? []).map((r: { path: string }) => r.path).filter(Boolean);
    if (paths.length) await svc.storage.from("doc-pdfs").remove(paths);
    let del = svc.from("doc_pdf_cache").delete().eq("doc", doc).eq("doc_id", docId);
    if (org) del = del.eq("org_id", org);
    await del;
  } catch {
    /* the cache is a shortcut; the write it rides on is the job */
  }
}

/** Is there a stored copy the share door would actually serve? Used by the public pages to
 *  decide whether to show a Download PDF button at all. */
export async function sharePdfAvailable(doc: "invoice" | "quote", docId: string, currentStatus: string): Promise<boolean> {
  try {
    const svc = createServiceClient();
    const { data } = await svc
      .from("doc_pdf_cache")
      .select("doc_status")
      .eq("doc", doc)
      .eq("doc_id", docId)
      .eq("doc_status", currentStatus)
      .limit(1)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

/** Drop EVERY stored copy for an org — for letterhead-level changes (name, logo, address,
 *  phone, doc template, brand color) that render on every document (audit 7: a logo swap kept
 *  serving the old letterhead on every already-sent customer PDF until some content edit). */
export async function bustOrgPdfs(orgId: string): Promise<void> {
  try {
    if (!orgId) return;
    const svc = createServiceClient();
    const { data: rows } = await svc.from("doc_pdf_cache").select("path").eq("org_id", orgId);
    const paths = (rows ?? []).map((r: { path: string }) => r.path).filter(Boolean);
    if (paths.length) await svc.storage.from("doc-pdfs").remove(paths);
    await svc.from("doc_pdf_cache").delete().eq("org_id", orgId);
  } catch {
    /* best-effort */
  }
}

/** Drop stored copies for every invoice and quote belonging to one CUSTOMER — the bill-to
 *  block renders their name/address on every document (audit 7). */
export async function bustCustomerPdfs(customerId: string): Promise<void> {
  try {
    if (!customerId) return;
    const svc = createServiceClient();
    // audit v921: the customer id comes off a client form and this fan-out runs on the service
    // role — scope it to the caller's org so a foreign customer id can't enumerate and wipe
    // another tenant's stored invoice/quote PDFs.
    const org = await callerOrgId();
    let invQ = svc.from("invoices").select("id").eq("customer_id", customerId);
    let quoQ = svc.from("quotes").select("id").eq("customer_id", customerId);
    if (org) {
      invQ = invQ.eq("org_id", org);
      quoQ = quoQ.eq("org_id", org);
    }
    const [{ data: invs }, { data: qs }] = await Promise.all([invQ, quoQ]);
    const ids = [
      ...((invs ?? []) as { id: string }[]).map((r) => ({ doc: "invoice", id: r.id })),
      ...((qs ?? []) as { id: string }[]).map((r) => ({ doc: "quote", id: r.id })),
    ];
    for (const d of ids) await bustDocPdf(d.doc as "invoice" | "quote", d.id, org);
  } catch {
    /* best-effort */
  }
}

/** Same check, keyed the way the PUBLIC pages hold the doc — by token. The 0187 RPCs return
 *  no ids on purpose, so the page can't ask by id; the service client translates. */
export async function sharePdfReady(doc: "invoice" | "quote", token: string, currentStatus: string): Promise<boolean> {
  try {
    const svc = createServiceClient();
    const { data: row } = await svc
      .from(doc === "invoice" ? "invoices" : "quotes")
      .select("id")
      .eq("public_token", token)
      .maybeSingle();
    if (!row?.id) return false;
    return sharePdfAvailable(doc, String((row as { id: string }).id), currentStatus);
  } catch {
    return false;
  }
}

/** Render-and-store, fired post-response from a send action (next/server `after`). Just hits
 *  the staff PDF door with the sender's own cookies — the route does the storing. Harmlessly
 *  401s from cookie-less contexts (crons); the first staff preview stores the copy instead. */
export async function warmDocPdf(doc: "invoice" | "quote", docId: string, origin: string, cookie: string | null): Promise<void> {
  try {
    await fetch(`${origin}/api/pdf/${doc}/${docId}`, {
      headers: cookie ? { cookie } : undefined,
      cache: "no-store",
    });
  } catch {
    /* warm is a courtesy */
  }
}
