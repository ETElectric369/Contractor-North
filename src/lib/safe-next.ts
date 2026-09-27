/**
 * Validate a `?next=` redirect target from a form/URL: only same-app RELATIVE paths pass.
 * Blocks open redirects — absolute URLs ("https://evil.com"), protocol-relative ("//evil.com"),
 * and backslash tricks ("/\evil.com", which some browsers normalize to //) all return null so
 * the caller falls back to its own default landing.
 */
export function safeNextPath(raw: unknown): string | null {
  const p = String(raw ?? "");
  return p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") ? p : null;
}

/**
 * Where a signed-out visit is sent: /login, carrying the WHOLE destination (path and query) in
 * `next`. The query used to ride on the login URL instead (`/settings?tab=features` came back as
 * `/login?tab=features&next=%2Fsettings`), so after signing in the person landed on the page but
 * not the tab, card or record the link was for.
 */
export function loginRedirectUrl(nextUrl: URL): URL {
  const url = new URL(nextUrl.toString());
  const next = `${nextUrl.pathname}${nextUrl.search}`;
  url.pathname = "/login";
  url.search = "";
  url.hash = "";
  url.searchParams.set("next", next);
  return url;
}
