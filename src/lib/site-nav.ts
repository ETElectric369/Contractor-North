/** The builder-page slug behind a nav link href. The routes hand OrgSite pageLinks in two shapes —
 *  root slugs on the org's own host ("/about") and the app-host preview ("/site/<handle>/p/about") —
 *  and the slug is the last path segment of both. Lets the homepage match sections to builder pages
 *  (portfolio/contact teasers) without a second query or any caller change. */
export function pageSlugFromHref(href: string): string {
  const path = String(href ?? "").split("#")[0].split("?")[0].replace(/\/+$/, "");
  return (path.split("/").pop() ?? "").toLowerCase();
}
