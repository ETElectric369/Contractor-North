/**
 * Next 15 instrumentation. Next forwards every server-side request error here (RSC render
 * throws incl. their `digest`, server actions, route handlers). We log it to OUR error_events
 * table — a queryable ops log the operator + Claude triage each session (no external service).
 * observe is imported lazily + guarded so a capture failure (e.g. under the edge runtime) can
 * never break the request itself.
 */
export async function onRequestError(
  err: unknown,
  request: { path?: string } | undefined,
  context: { routerKind?: string } | undefined,
): Promise<void> {
  try {
    const { reportError } = await import("@/lib/observe");
    reportError("rsc-render", err, {
      digest: (err as { digest?: string } | undefined)?.digest,
      path: request?.path,
      routerKind: context?.routerKind,
    });
  } catch {
    /* observability must never break a request */
  }
}
