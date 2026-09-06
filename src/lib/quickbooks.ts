import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";

/** True when the Intuit app credentials are configured. */
export function qboConfigured(): boolean {
  return Boolean(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);
}

const ENV = process.env.QBO_ENVIRONMENT || "production"; // or "sandbox"
const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

/**
 * REVOKE THE GRANT AT INTUIT, not just our copy of it (audit 9).
 *
 * Disconnect deleted our row and showed the disconnected state, while Intuit still held a valid
 * grant: the refresh token stayed usable, so anyone with the stored token — the exact thing an
 * owner offboarding a bookkeeper or reacting to a suspected compromise is trying to kill — kept
 * access to the books. Best-effort by design: if Intuit is unreachable we still remove our row
 * (leaving the app connected to something the user asked to disconnect is worse), but the caller
 * is told, so "revoked" is never claimed when it wasn't.
 */
export async function revokeQboToken(refreshToken: string): Promise<boolean> {
  if (!qboConfigured() || !refreshToken) return false;
  try {
    const basic = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString("base64");
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token: refreshToken }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
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
    // INTUIT ROTATES THE REFRESH TOKEN AND RETIRES THE OLD ONE (audit v921). This push would
    // still go through on the in-memory copy, but if the new token never landed the stored one is
    // already dead: the next push refreshes with it, gets a 400, and the office is told to
    // reconnect an hour later with nothing anywhere saying why. A zero-row update is a 204, so
    // the rows are checked — and the reconnect is asked for NOW, at the moment we can explain it.
    const { data: saved, error: saveErr } = await supabase
      .from("accounting_connections")
      .update(patch)
      .eq("org_id", orgId)
      .select("org_id");
    if (saveErr || !saved?.length) {
      reportError("quickbooks:refresh:persist", saveErr ?? new Error("no accounting_connections row updated"), { orgId });
      throw new Error("The refreshed QuickBooks sign-in didn't save — reconnect QuickBooks in Settings.");
    }
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
  /**
   * ADOPT THE CUSTOMER THE BOOKS ALREADY HAVE (audit v921).
   *
   * QuickBooks enforces a unique DisplayName per company file, so creating "Jane Smith" outright
   * — the normal case for a contractor who used QuickBooks before Contractor North — came back as
   * Intuit fault 6240 "Duplicate Name Exists", the mapping was never written, and every retry
   * failed identically with no way to link the two. Look first; create only a name the books
   * don't have. (Single quotes are doubled: that's the escape in Intuit's query language.)
   */
  const name = String(customer.name || "Customer").trim() || "Customer";
  const found = await qboFetch(
    conn,
    `/query?minorversion=65&query=${encodeURIComponent(
      `select Id from Customer where DisplayName = '${name.replace(/'/g, "''")}'`,
    )}`,
  );
  let id: string | undefined = found?.QueryResponse?.Customer?.[0]?.Id;
  if (!id) {
    const created = await qboFetch(conn, "/customer?minorversion=65", {
      method: "POST",
      body: JSON.stringify({ DisplayName: name }),
    });
    id = created?.Customer?.Id;
  }
  if (!id) throw new Error("QuickBooks didn't return a customer id.");
  const supabase = createServiceClient();
  const { data: mapped, error: mapErr } = await supabase
    .from("customers")
    .update({ qbo_id: id, qbo_realm_id: conn.realm_id })
    .eq("id", customer.id)
    .select("id");
  // A lost mapping no longer duplicates the customer (the lookup above catches it next time),
  // but a 204 that reads as a save still belongs in the ops log.
  if (mapErr || !mapped?.length) {
    reportError("quickbooks:customer:map", mapErr ?? new Error("no customers row updated"), {
      customerId: customer.id,
      qboId: id,
    });
  }
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

    /**
     * NO MAPPING DOESN'T MEAN NO INVOICE (audit v921).
     *
     * The mapping write below is the only thing stopping a second "Send to QuickBooks" from
     * creating a DUPLICATE bill — and it never runs when the POST times out after Intuit already
     * committed, or when the write itself fails. Intuit takes no idempotency key on create, so
     * the invoice number is the key: if it's already in the books, update THAT one instead of
     * minting a second copy of the same bill in the customer's books.
     */
    if (!payload.Id && inv.invoice_number) {
      const dup = await qboFetch(
        conn,
        `/query?minorversion=65&query=${encodeURIComponent(
          `select * from Invoice where DocNumber = '${String(inv.invoice_number).replace(/'/g, "''")}'`,
        )}`,
      );
      const already = dup?.QueryResponse?.Invoice?.[0];
      // ONLY ADOPT AN INVOICE THAT IS ACTUALLY OURS (audit v921 review blocker). Invoice numbers
      // are NOT namespaced in QuickBooks: 0190 lets an org set its own prefix (or none), so a bare
      // "1042" collides with QuickBooks' own auto-assigned DocNumbers and with imported bills. The
      // POST below carries CustomerRef + the whole Line array with sparse:true, so adopting a
      // stranger's row would REWRITE that invoice's customer and line items in the contractor's
      // live books. Same customer is the minimum proof it's the one we created.
      const sameCustomer =
        String((already as { CustomerRef?: { value?: string } } | undefined)?.CustomerRef?.value ?? "") ===
        String(customerId);
      if (already?.Id && sameCustomer) {
        payload.Id = already.Id;
        payload.SyncToken = already.SyncToken ?? "0";
        payload.sparse = true;
      }
    }

    const created = await qboFetch(conn, "/invoice?minorversion=65", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const qboId = created?.Invoice?.Id;
    // Write the mapping FIRST, even on a mismatch: without it the next attempt creates a
    // DUPLICATE invoice in the live book instead of correcting this one. AND IT HAS TO LAND
    // (audit v921) — the result was discarded, so a zero-row update was a 204 that read as
    // success while the link the next send depends on was never saved.
    const { data: linked, error: linkErr } = await supabase
      .from("invoices")
      .update({ qbo_id: qboId, qbo_realm_id: conn.realm_id })
      .eq("id", invoiceId)
      .eq("org_id", orgId)
      .select("id");
    if (linkErr || !linked?.length) {
      reportError("quickbooks:invoice:map", linkErr ?? new Error("no invoices row updated"), {
        invoiceId,
        orgId,
        qboId,
      });
      return {
        ok: false,
        qbo_id: qboId,
        error: `QuickBooks has this invoice as #${qboId ?? "?"}, but the link back to it didn't save. Send again — it will update that same invoice, not make a second one.`,
      };
    }

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
