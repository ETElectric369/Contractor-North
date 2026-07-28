import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { mayServeOrgOnHost } from "@/lib/public-host";

/**
 * THE one call an org-scoped public route makes to decide whether it may render.
 *
 * WHY IT EXISTS AS A SINGLE FUNCTION. The cross-tenant leak that started this was three routes
 * (/site/<handle>, /estimate/<handle>, /inquire/<org-id>) that each resolved a tenant from the
 * URL and never compared it to the host. The first fix added a helper and called it from each
 * route — which is a CONVENTION: a fourth route added next year is a leak by default, because
 * nothing makes the author call it. Worse, the two call sites that did exist got the app-host
 * case wrong in the same way, so the helper's own default became an anonymous tenant directory.
 *
 * So the check is packaged whole: host + validated session + the decision + the 404, in one
 * await. A route cannot call "half" of this, and there is exactly one place to audit.
 *
 * WHAT IT ENFORCES:
 *   - the tenant's own host (custom domain, www, or <handle>.SITES_DOMAIN) serves that tenant to
 *     anyone — a public marketing page and a public lead form are supposed to be public;
 *   - an APP host renders another tenant only to a signed-in human (preview, internal tooling);
 *   - anything else is 404, indistinguishable from a URL that never existed.
 *
 * The session is read with supabase.auth.getUser(), which VALIDATES it. It is deliberately not a
 * cookie-presence test: the guard this replaced checked that a cookie NAMED sb-*-auth-token
 * existed and was defeated in one line with `curl -H 'Cookie: sb-x-auth-token=garbage'`.
 *
 * Note the asymmetry that is correct: ANY signed-in user may preview ANY tenant on the app host.
 * That is a deliberate, narrow trade — it keeps the tenant directory closed to the open internet
 * while leaving internal tooling workable. If the product ever needs preview scoped to the
 * viewer's own org, this is the one function to tighten, and every route inherits it.
 */
export async function assertOrgServable(
  settings: { custom_domain?: string | null; public_handle?: string | null } | null | undefined,
): Promise<void> {
  if (!(await orgIsServable(settings))) notFound();
}

/** The same decision without the 404 — for generateMetadata, which must return an empty object
 *  rather than throw, and which has to agree with the page or the wrong-host URL would still
 *  advertise a title and a canonical for a page that 404s. */
export async function orgIsServable(
  settings: { custom_domain?: string | null; public_handle?: string | null } | null | undefined,
): Promise<boolean> {
  const host = (await headers()).get("host");
  // Fast path: the tenant's own host never needs a session lookup, and this is the hot path that
  // every real public page visit takes.
  if (mayServeOrgOnHost(settings, host, false)) return true;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return mayServeOrgOnHost(settings, host, !!user);
}
