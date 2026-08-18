import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/** True when the Intuit app credentials are configured. */
export function qboConfigured(): boolean {
  return Boolean(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);
}

const ENV = process.env.QBO_ENVIRONMENT || "production"; // or "sandbox"
const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const API_BASE =
  ENV === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
const SCOPE = "com.intuit.quickbooks.accounting";

export function redirectUri(base?: string) {
  // Per-request base like google-calendar.ts: the connect/callback routes pass
  // oauthRedirectBase (the REQUEST's own origin on an app host) so the round-trip
  // stays on the host holding the host-only session + state cookies; the env pin is
  // the fallback. ⚠ Intuit only accepts registered redirect URIs — every base used
  // needs <base>/api/quickbooks/callback registered in the Intuit developer portal
  // (contractor-north.vercel.app AND app.contractornorth.com; see src/lib/oauth-base.ts).
  return `${base || process.env.OAUTH_REDIRECT_BASE || process.env.NEXT_PUBLIC_SITE_URL}/api/quickbooks/callback`;
}

export function authorizeUrl(state: string, redirectBase?: string) {
  const p = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID!,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: redirectUri(redirectBase),
    state,
  });
  return `${AUTH_BASE}?${p.toString()}`;
}

async function tokenRequest(body: URLSearchParams) {
  const basic = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) throw new Error(`QuickBooks token error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function exchangeCode(code: string, redirectBase?: string) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      // Must repeat the EXACT redirect_uri the authorize step sent — the callback
      // derives the same per-request base, so connect and exchange always agree.
      redirect_uri: redirectUri(redirectBase),
    }),
  );
}

async function refreshToken(refresh_token: string) {
  return tokenRequest(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
  );
}

export interface QboConnection {
  org_id: string;
  realm_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string | null;
}

/** Get a valid connection for an org, refreshing the token if near expiry. */
export async function getConnection(orgId: string): Promise<QboConnection | null> {
  const supabase = createServiceClient();
  const { data: conn } = await supabase
    .from("accounting_connections")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!conn?.access_token || !conn.realm_id) return null;

  if (conn.expires_at && new Date(conn.expires_at).getTime() < Date.now() + 60_000) {
    const t = await refreshToken(conn.refresh_token);
    const patch = {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? conn.refresh_token,
      expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    };
    await supabase.from("accounting_connections").update(patch).eq("org_id", orgId);
    return { ...conn, ...patch } as QboConnection;
  }
  return conn as QboConnection;
}

export async function qboFetch(conn: QboConnection, path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}/v3/company/${conn.realm_id}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.access_token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`QuickBooks API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Ensure a QBO customer exists; returns its QBO Id, caching on the row. */
async function ensureCustomer(conn: QboConnection, customer: any): Promise<string> {
  // A mapping is only valid inside the company file it was made in (audit 9, 0203).
  if (customer.qbo_id && customer.qbo_realm_id === conn.realm_id) return customer.qbo_id;
  const created = await qboFetch(conn, "/customer?minorversion=65", {
    method: "POST",
    body: JSON.stringify({ DisplayName: customer.name || "Customer" }),
  });
  const id = created?.Customer?.Id;
  const supabase = createServiceClient();
  await supabase.from("customers").update({ qbo_id: id, qbo_realm_id: conn.realm_id }).eq("id", customer.id);
  return id;
}

/**
 * Push a Contractor North invoice into QuickBooks Online.
 *
 * `orgId` IS THE TENANT BOUNDARY AND IT IS REQUIRED. This reads on a SERVICE client, so RLS never
 * runs — the caller's org has to be carried in and applied by hand. It wasn't: the action proved
 * the caller was staff SOMEWHERE, fetched their org id, and then threw it away. Tahoe Deck office
 * staff naming an ET Electric invoice uuid would have had ET's OAuth tokens read and refreshed, a
 * customer and an invoice CREATED INSIDE ET'S QUICKBOOKS BOOKS, qbo_id written back onto ET's
 * rows, and the raw QBO response for ET's realm handed back to them.
 *
 * Same law as every other service-client read: [[tenant-isolation-root-cause]] — a rule applied at
 * one read path is a convention, not a boundary. A service client has no boundary but this line.
 */
/** Plain dollars for an error a human reads. */
const formatUsd = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

export async function pushInvoiceToQbo(
  invoiceId: string,
  orgId: string,
): Promise<{ ok: boolean; error?: string; qbo_id?: string }> {
  const supabase = createServiceClient();
  if (!orgId) return { ok: false, error: "Missing organization." };

  const { data: inv } = await supabase
    .from("invoices")
    .select("*, customers(id, name, qbo_id, qbo_realm_id)")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle();
  // Not found and not-yours are deliberately the same answer — a distinct "not yours" confirms the
  // uuid exists in another tenant, which is itself a leak.
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (!inv.customers) return { ok: false, error: "Invoice has no customer." };

  // getConnection REFRESHES, and a revoked/expired grant makes that throw — outside the try
  // below, so it escaped as an unhandled rejection (audit 9). A dead connection is a normal
  // answer with a next step, not a crash.
  let conn: QboConnection | null = null;
  try {
    conn = await getConnection(inv.org_id);
  } catch {
    return { ok: false, error: "QuickBooks needs reconnecting — Settings → Connections." };
  }
  if (!conn) return { ok: false, error: "Connect QuickBooks first (Settings)." };

  try {
    const customerId = await ensureCustomer(conn, inv.customers);

    // Use the company's first Item as the line item ref (avoids account setup).
    const itemQuery = await qboFetch(
      conn,
      `/query?minorversion=65&query=${encodeURIComponent("select Id from Item maxresults 1")}`,
    );
    const itemId = itemQuery?.QueryResponse?.Item?.[0]?.Id;
    if (!itemId)
      return { ok: false, error: "No QuickBooks item found — create one item in QBO first." };

    const { data: items } = await supabase
      .from("invoice_items")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("sort_order");

    const Line = (items ?? []).map((it: any) => ({
      DetailType: "SalesItemLineDetail",
      Amount: Number(it.line_total),
      Description: it.description,
      SalesItemLineDetail: {
        ItemRef: { value: itemId },
        Qty: Number(it.quantity),
        UnitPrice: Number(it.unit_price),
      },
    }));

    const payload: any = {
      CustomerRef: { value: customerId },
      Line,
      DocNumber: inv.invoice_number,
    };
    // Only sparse-update a mapping made in THIS company file (audit 9, 0203) — an id from a
    // previous realm points at a stranger's invoice, and updating it would overwrite their books.
    if (inv.qbo_id && inv.qbo_realm_id === conn.realm_id) {
      // sparse update of an existing QBO invoice
      const existing = await qboFetch(conn, `/invoice/${inv.qbo_id}?minorversion=65`);
      payload.Id = inv.qbo_id;
      payload.SyncToken = existing?.Invoice?.SyncToken ?? "0";
      payload.sparse = true;
    }

    const created = await qboFetch(conn, "/invoice?minorversion=65", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const qboId = created?.Invoice?.Id;
    // Write the mapping FIRST, even on a mismatch: without it the next attempt creates a
    // DUPLICATE invoice in the live book instead of correcting this one.
    await supabase.from("invoices").update({ qbo_id: qboId, qbo_realm_id: conn.realm_id }).eq("id", invoiceId);

    /**
     * RECONCILE THE TOTAL, DON'T ASSUME IT (audit 9).
     *
     * The payload carries line items only — no tax — so an $10,825 invoice posted as $10,000 and
     * "Sent to QuickBooks" was reported as success: $825 of collected sales tax existed in CN,
     * on the customer's PDF, and nowhere in the books. Patching the payload isn't enough on its
     * own either, because a US Automated-Sales-Tax realm computes its OWN tax from the ship-to
     * address and can come back higher. Comparing what QuickBooks actually recorded to what this
     * invoice says is the check that holds in every realm mode — and a mismatch is the office's
     * to resolve, so it is told plainly instead of being congratulated.
     */
    const qboTotal = Number(created?.Invoice?.TotalAmt);
    const ourTotal = Number(inv.total ?? 0);
    if (Number.isFinite(qboTotal) && Math.abs(qboTotal - ourTotal) > 0.005) {
      return {
        ok: false,
        qbo_id: qboId,
        error: `QuickBooks recorded ${formatUsd(qboTotal)} for this invoice; Contractor North has it at ${formatUsd(ourTotal)}${Number(inv.tax ?? 0) > 0.005 ? ` (sales tax of ${formatUsd(Number(inv.tax))} isn't carried by the sync yet)` : ""}. Fix it in QuickBooks — the invoice is linked, so sending again will update that same one.`,
      };
    }
    return { ok: true, qbo_id: qboId };
  } catch (e: any) {
    return { ok: false, error: e?.message?.slice(0, 300) ?? "QuickBooks error" };
  }
}
