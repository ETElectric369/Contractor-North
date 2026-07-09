/**
 * Serialize an object for safe embedding in a `<script type="application/ld+json">` block via
 * dangerouslySetInnerHTML. JSON.stringify does NOT escape `<`/`>`, so a string containing
 * `</script>` would break out of the script element and execute — a stored-XSS vector whenever any
 * embedded value is even semi-untrusted (e.g. a site collaborator's marketing copy). Escape the
 * angle brackets + the JS line separators (U+2028/U+2029, which are invalid raw in a script).
 */
export function jsonLdSafe(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
}
