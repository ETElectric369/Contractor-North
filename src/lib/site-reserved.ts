import { CONTENT_ROOTS } from "@/lib/site-content-roots";

/**
 * Custom builder pages serve at ROOT-level slugs on an org site (tahoedeck.com/about), so a migrated
 * site's already-indexed URLs (/about, /portfolio, /contact) keep serving 200s in North's style —
 * "as if nothing happened". The single risk of root-level slugs is a page shadowing a real app/site
 * route, so this set is the ONE guard, shared by:
 *   - middleware: a single-segment org-site path NOT in here is routed to the page resolver.
 *   - saveSitePage: refuses to create a page whose slug is reserved (defense in depth).
 * Anything that is a real app route, a content root, an asset, or infra MUST be listed.
 */
// Every REAL top-level app/site route segment (mirrors the route dirs under src/app, incl. the (app)
// route-group children which are all served at root). A page slug matching any of these would either
// shadow the route or — for routes linked/reachable on an org host, esp. the login → forgot → reset
// password flow — be captured by the page resolver and dead-end at the homepage. Adding a new
// top-level route means adding it here. Marketing slugs people actually want (about, portfolio,
// services, faq, gallery, reviews…) are NOT app routes, so they stay available.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...CONTENT_ROOTS, // "blog", "blog-1-1" — the article engine owns these
  // The homepage itself is "/" — a /home (or /index, /homepage) decoy page must be impossible
  "home", "index", "homepage",
  // Auth / onboarding (the login flow is the one app path reachable from an org's public site)
  "login", "logout", "forgot", "reset", "set-password", "account-deactivated", "onboarding",
  "subscribe", "auth",
  // Public + short-link routes
  "estimate", "inquire", "voice", "portal", "print", "pick", "content", "c", "i", "q",
  // App surfaces (the (app) route group — all at root)
  "activity", "analytics", "appointments", "assistant", "audit", "audits", "billing", "bills",
  "bugs", "calendar", "change-orders", "compliance", "crm", "dashboard", "employee-docs", "forms",
  "handbook", "insurance", "inventory", "jobs", "leads", "map", "materials", "organize", "payments",
  "payroll", "permits", "petty-cash", "planner", "plans", "price-list", "purchasing", "quotes",
  "recurring", "resources", "safety", "schedule", "settings", "tasks", "tax-report", "team",
  "timecards", "timeclock", "tools", "work-orders",
  // Infra / assets
  "api", "site", "p", "_next", "assets", "images", "static", "offline",
  "sitemap", "sitemap.xml", "robots.txt", "manifest", "manifest.webmanifest", "sw.js",
  "favicon.ico", "favicon", "icon", "apple-touch-icon",
]);

/** A single non-empty path segment slug (lowercase, url-safe). Mirrors the site_pages.slug CHECK. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(String(slug || "").toLowerCase());
}

/** Normalize a raw title/slug input into a legal page slug — shared by saveSitePage AND the page
 *  editor's pre-save check, so both sides test the SAME string against the reserved set. */
export function slugifySiteSlug(s: string): string {
  return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/**
 * Given a request pathname on an ORG host, return the page slug it should resolve to — or null if
 * this path is NOT a custom-page candidate (root, multi-segment, reserved, dotted asset, or malformed).
 * Middleware uses this to decide what to hand to the page resolver; keeping the decision here (not
 * inline) means the write-time guard and the route-time guard can never drift.
 */
export function pageSlugFromPath(pathname: string): string | null {
  const p = pathname.replace(/^\/+|\/+$/g, ""); // strip leading/trailing slashes
  if (!p || p.includes("/")) return null; // only single-segment paths are pages
  if (p.includes(".")) return null; // dotted → asset/file, never a page
  const slug = p.toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  if (isReservedSlug(slug)) return null;
  return slug;
}

/**
 * Legacy CMS paths (Squarespace/Wix/WordPress defaults) from a migrated site's old life.
 * Shared by middleware (multi-segment prefixes → 301 home) and the page resolver (a
 * single-segment legacy slug with NO builder page behind it → 301 home instead of 404,
 * so a stale /gallery bookmark still lands somewhere useful). Moved here from middleware
 * so the two checks can never drift (SEO wave, 2026-07-24).
 */
const LEGACY_EXACT = new Set([
  "/about", "/about-us", "/portfolio", "/gallery", "/services", "/our-work",
  "/projects", "/contact", "/contact-us", "/home", "/store", "/shop",
  "/testimonials", "/reviews", "/faq",
]);
const LEGACY_PREFIX = ["/shop/", "/store/", "/products", "/product/", "/gallery/", "/portfolio/", "/services/"];
export function isLegacyCmsPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/"; // tolerate a trailing slash
  if (LEGACY_EXACT.has(p)) return true;
  return LEGACY_PREFIX.some((pre) => pathname.startsWith(pre));
}
