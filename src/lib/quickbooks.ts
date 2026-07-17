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

export function redirectUri() {
  // Pinned like google-calendar.ts: Intuit only accepts registered redirect URIs,
  // so the callback stays on OAUTH_REDIRECT_BASE while SITE_URL moves domains.
  return `${process.env.OAUTH_REDIRECT_BASE || process.env.NEXT_PUBLIC_SITE_URL}/api/quickbooks/callback`;
}

export function authorizeUrl(state: string) {
  const p = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID!,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: redirectUri(),
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

export async function exchangeCode(code: string) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
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
  if (customer.qbo_id) return customer.qbo_id;
  const created = await qboFetch(conn, "/customer?minorversion=65", {
    method: "POST",
    body: JSON.stringify({ DisplayName: customer.name || "Customer" }),
  });
  const id = created?.Customer?.Id;
  const supabase = createServiceClient();
  await supabase.from("customers").update({ qbo_id: id }).eq("id", customer.id);
  return id;
}

/** Push a Contractor North invoice into QuickBooks Online. */
export async function pushInvoiceToQbo(
  invoiceId: string,
): Promise<{ ok: boolean; error?: string; qbo_id?: string }> {
  const supabase = createServiceClient();

  const { data: inv } = await supabase
    .from("invoices")
    .select("*, customers(id, name, qbo_id)")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (!inv.customers) return { ok: false, error: "Invoice has no customer." };

  const conn = await getConnection(inv.org_id);
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
    if (inv.qbo_id) {
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
    await supabase.from("invoices").update({ qbo_id: qboId }).eq("id", invoiceId);
    return { ok: true, qbo_id: qboId };
  } catch (e: any) {
    return { ok: false, error: e?.message?.slice(0, 300) ?? "QuickBooks error" };
  }
}
