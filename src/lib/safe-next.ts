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
