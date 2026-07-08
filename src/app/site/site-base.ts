import { headers } from "next/headers";

const SITES_DOMAIN = (process.env.SITES_DOMAIN || "contractornorth.com").toLowerCase();

/**
 * Link base for org-site article links, by how the page was reached:
 * - On the org's OWN host (its free subdomain, where middleware rewrites root-level paths):
 *   "" — links are /blog, /blog-1-1/redwood at the domain root.
 * - Browsing on the app host (contractornorth.com/site/<handle>): "/site/<handle>" so links
 *   stay inside the app-host route space.
 * Custom-domain pages use the by-domain routes and hardcode "" (always the org's own host).
 */
export async function handleLinkBase(handle: string): Promise<string> {
  const host = ((await headers()).get("host") || "").toLowerCase().split(":")[0];
  if (host === `${handle}.${SITES_DOMAIN}`) return "";
  return `/site/${handle}`;
}
