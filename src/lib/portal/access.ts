import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import type { PortalOrg } from "@/components/portal/portal-shell";
import { portalHomeOrg, type PortalHomeOrgRaw } from "./home-shape";
import { hashSecret, isSessionSecret, maskEmail } from "./code";
import { PORTAL_COOKIE, PORTAL_OFFICE_COOKIE, isPortalToken } from "./session-cookie";

/**
 * WHO MAY SEE THIS PORTAL PAGE (0331). Every page under /portal/<token> asks this FIRST, before it
 * reads a single customer row, and renders the sign-in screen unless the answer is "in".
 * (portal-gate.test pins that every page file does.)
 *
 *  - missing:   no such link. The page 404s, as before.
 *  - off:       the office turned it off or replaced it. "This link was turned off", as before.
 *  - gate:      a real, live link on a device that is not signed in. The sign-in screen: the
 *               business's skin and the address the code goes to, MASKED here on the server, so
 *               the full address never reaches the browser; and, when a code is already out and
 *               still good, how long ago it went, so the screen opens on the code box.
 *  - office_ended: an office look on this browser has ended (8 hours, Sign Out All Devices, the
 *               staff member no longer active). A notice to go back to the app, never the sign-in
 *               screen, whose Send My Code would email the customer a code they never asked for.
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
  | { kind: "gate"; org: PortalOrg; maskedEmail: string | null; codeSentMinutesAgo: number | null }
  | { kind: "office_ended"; orgName: string | null }
  | { kind: "in"; session: "customer" | "office" }
  | { kind: "not_ready" }
  | { kind: "error" };

type GateRaw = { disabled?: boolean; org?: PortalHomeOrgRaw; email?: string | null; live_code_sent_at?: string | null } | null;

function isMissingFunction(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "PGRST202" || code === "42883" || (/portal_(gate|session_check)/i.test(msg) && /could not find|does not exist/i.test(msg));
}

/** Whole minutes since `iso`, or null when there's no such time. Worked out here on the server so
 *  the sign-in screen renders the same words on the server and in the browser. */
function minutesAgo(iso: string | null | undefined): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60_000));
}

export const readPortalAccess = cache(async (token: string): Promise<PortalAccess> => {
  if (!isPortalToken(token)) return { kind: "missing" };
  const svc = createServiceClient();

  const jar = await cookies();
  // The office's look first (its own cookie, 0331), then the customer's own sign-in. Each cookie is
  // only ever checked for its own kind: a customer cookie can't open an office look or the reverse.
  const officeSecret = jar.get(PORTAL_OFFICE_COOKIE)?.value;
  const customerSecret = jar.get(PORTAL_COOKIE)?.value;
  let officeEnded = false;
  for (const [want, secret] of [["office", officeSecret], ["customer", customerSecret]] as const) {
    if (!isSessionSecret(secret)) continue;
    const { data, error } = await svc.rpc("portal_session_check", { p_token: token, p_session_hash: hashSecret(secret) });
    if (error) {
      if (isMissingFunction(error)) return { kind: "not_ready" };
      reportError("portal.session", error);
      return { kind: "error" };
    }
    if ((data as { kind?: string } | null)?.kind === want) return { kind: "in", session: want };
    // Not a live session of this kind for this link: fall through to the sign-in screen (or "turned off").
    if (want === "office") officeEnded = true;
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
  if (officeEnded) return { kind: "office_ended", orgName: g.org?.name ?? null };
  return {
    kind: "gate",
    org: portalHomeOrg(g.org ?? null),
    maskedEmail: maskEmail(g.email),
    codeSentMinutesAgo: minutesAgo(g.live_code_sent_at),
  };
});
