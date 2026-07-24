import { headers } from "next/headers";
import { sizedImage, socialImage } from "@/lib/site-image";

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

import type { PublicOrg } from "@/lib/public-org";

/**
 * The org's default social-share image — the same fallback chain the homepage has always
 * used (hero background → first portfolio photo → logo). Builder pages, the blog index, and
 * cover-less articles previously shipped NO og:image at all, so shares rendered bare cards
 * (SEO wave 2026-07-24). Null only when the org truly has no imagery.
 */
export function defaultSocialImage(org: PublicOrg): string | null {
  const s = org.settings;
  // socialImage caps the served variant at ~1200px — scrapers shouldn't pull a full camera original.
  return socialImage(s.splash_bg_url || s.portfolio?.[0]?.url || org.logo_url || null);
}

/** The AUTOMATIC per-org favicon (Erik 7/24): every tenant site's browser-tab icon is its own
 *  logo, minted on the fly by the image pipeline (64px favicon + 180px apple-touch) — zero
 *  config per client, exactly like the rest of the site platform. A <link rel="icon"> in page
 *  metadata overrides the app-level /favicon.ico in every modern browser. SVG logos pass
 *  through untransformed (fine as a favicon; skipped for apple-touch, which iOS wants raster).
 *  No logo → undefined, so the page inherits the platform default. */
export function orgIcons(org: PublicOrg): { icon: string; apple?: string } | undefined {
  const logo = org.logo_url;
  if (!logo) return undefined;
  const isSvg = /\.svg(\?|$)/i.test(logo);
  return { icon: sizedImage(logo, 64), ...(isSvg ? {} : { apple: sizedImage(logo, 180) }) };
}
