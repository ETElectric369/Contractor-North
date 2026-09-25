import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import type { PortalOrg } from "@/components/portal/portal-shell";
import { portalHomeOrg, type PortalHomeOrgRaw } from "./home-shape";
import { hashSecret, isSessionSecret, maskEmail } from "./code";
import { PORTAL_COOKIE, isPortalToken } from "./session-cookie";

/**
 * WHO MAY SEE THIS PORTAL PAGE (0331). Every page under /portal/<token> asks this FIRST, before it
 * reads a single customer row, and renders the sign-in screen unless the answer is "in".
 * (portal-gate.test pins that every page file does.)
 *
 *  - missing:   no such link. The page 404s, as before.
 *  - off:       the office turned it off or replaced it. "This link was turned off", as before.
 *  - gate:      a real, live link on a device that is not signed in. The sign-in screen: the
 *               business's skin and the address the code goes to, MASKED here on the server, so
 *               the full address never reaches the browser.
 *  - in:        this device holds a live session for this link's own customer (portal_session_check
 *               checks link, customer, org and expiry, and slides a customer session to 30 days).
 *               kind 'office' is the office's See What They See, which never needs the code.
 *  - not_ready: 0331 isn't on the database. Fail CLOSED: never the page without the code.
 *  - error:     the database or the service key failed; reported, and "couldn't load just now".
 *
 * cache(): generateMetadata and the page ask once per request.
 */
export type PortalAccess =
  | { kind: "missing" }
  | { kind: "off"; orgName: string | null }
  | { kind: "gate"; org: PortalOrg; maskedEmail: string | null }
  | { kind: "in"; session: "customer" | "office" }
  | { kind: "not_ready" }
  | { kind: "error" };

type GateRaw = { disabled?: boolean; org?: PortalHomeOrgRaw; email?: string | null } | null;

function isMissingFunction(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "PGRST202" || code === "42883" || (/portal_(gate|session_check)/i.test(msg) && /could not find|does not exist/i.test(msg));
}

export const readPortalAccess = cache(async (token: string): Promise<PortalAccess> => {
  if (!isPortalToken(token)) return { kind: "missing" };
  const svc = createServiceClient();

  const secret = (await cookies()).get(PORTAL_COOKIE)?.value;
  if (isSessionSecret(secret)) {
    const { data, error } = await svc.rpc("portal_session_check", { p_token: token, p_session_hash: hashSecret(secret) });
    if (error) {
      if (isMissingFunction(error)) return { kind: "not_ready" };
      reportError("portal.session", error);
      return { kind: "error" };
    }
    const kind = (data as { kind?: string } | null)?.kind;
    if (kind === "customer" || kind === "office") return { kind: "in", session: kind };
    // Not a live session for this link: fall through to the sign-in screen (or "turned off").
  }

  const { data, error } = await svc.rpc("portal_gate", { p_token: token });
  if (error) {
    if (isMissingFunction(error)) return { kind: "not_ready" };
    reportError("portal.gate", error);
    return { kind: "error" };
  }
  const g = data as GateRaw;
  if (!g) return { kind: "missing" };
  if (g.disabled) return { kind: "off", orgName: g.org?.name ?? null };
  return { kind: "gate", org: portalHomeOrg(g.org ?? null), maskedEmail: maskEmail(g.email) };
});
