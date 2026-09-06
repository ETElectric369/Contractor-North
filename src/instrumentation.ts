/**
 * Next 15 instrumentation. Next forwards every server-side request error here (RSC render
 * throws incl. their `digest`, server actions, route handlers). We log it to OUR error_events
 * table — a queryable ops log the operator + Claude triage each session (no external service).
 * observe is imported lazily + guarded so a capture failure (e.g. under the edge runtime) can
 * never break the request itself.
 */
/** The PATH of a token portal IS the credential (0172): /q/, /c/, /i/, /pick/, /portal/,
 *  /api/share-pdf/. Logging it verbatim parked a live approve/sign token in error_events, where
 *  it outlived the portal's own revoke + expiry (audit v921). Keep the route, drop the secret. */
function redactTokenPath(path: string | undefined): string | undefined {
  if (!path) return path;
  return path
    .split("?")[0]
    // api/pay and voice were missing (audit v921 review blocker): a throw inside
    // api/pay/[token]/route.ts wrote the LIVE payment token verbatim into error_events.
    .replace(/^(\/(?:q|c|i|pick|portal|voice|api\/share-pdf|api\/pay)\/)[^/]+/, "$1<token>");
}

export async function onRequestError(
  err: unknown,
  request: { path?: string } | undefined,
  context: { routerKind?: string } | undefined,
): Promise<void> {
  try {
    const { reportError } = await import("@/lib/observe");
    reportError("rsc-render", err, {
      digest: (err as { digest?: string } | undefined)?.digest,
      path: redactTokenPath(request?.path),
      routerKind: context?.routerKind,
    });
  } catch {
    /* observability must never break a request */
  }
}
