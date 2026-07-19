/** A header/footer nav link on an org's public site. */
export type SiteNavLink = { href: string; label: string };

/** The builder-page slug behind a nav link href. The routes hand OrgSite pageLinks in two shapes —
 *  root slugs on the org's own host ("/about") and the app-host preview ("/site/<handle>/p/about") —
 *  and the slug is the last path segment of both. Lets the homepage match sections to builder pages
 *  (portfolio/contact teasers) without a second query or any caller change. */
export function pageSlugFromHref(href: string): string {
  const path = String(href ?? "").split("#")[0].split("?")[0].replace(/\/+$/, "");
  return (path.split("/").pop() ?? "").toLowerCase();
}

/** Nav links for the published builder pages, in the shape the current host needs: on the org's own
 *  host (base "") the public root slug ("/about" — a middleware rewrite); on the app host the
 *  internal route ("/site/<handle>/p/about"). ONE mapping for every route that renders site chrome,
 *  so the two shapes can't drift per-surface. */
export function navPageLinks(base: string, pages: { slug: string; nav_label: string }[]): SiteNavLink[] {
  return pages.map((p) => ({ href: base ? `${base}/p/${p.slug}` : `/${p.slug}`, label: p.nav_label }));
}

/** Prefix a homepage section anchor for the page it's rendered on: on the homepage itself the bare
 *  "#work" scrolls; on any other page of the site the same link must travel home first ("/#work",
 *  or "/site/<handle>#work" on the app host) or it silently resolves nowhere. */
export function sectionAnchor(anchorBase: string, anchor: `#${string}`): string {
  return `${anchorBase}${anchor}`;
}
