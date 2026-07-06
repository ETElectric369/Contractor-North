import * as Sentry from "@sentry/nextjs";

/** Server + edge error monitoring via Next 15's instrumentation hook. Ships DARK:
 *  a no-op until NEXT_PUBLIC_SENTRY_DSN is set, so there's zero runtime cost (and
 *  no data leaves) until you create a Sentry project and add the DSN env var. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
      // Server/edge perf tracing — env-overridable, defaults to 100% so server actions + API routes
      // report timing during the test window. Dial back with NEXT_PUBLIC_SENTRY_TRACES_RATE if needed.
      tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_RATE ?? "1"),
    });
  }
}

// Next forwards every server-side request error here (RSC render throws incl. their
// `digest`, server actions, route handlers). We log it to OUR sentry_events table (works
// with no DSN) AND forward to Sentry (a no-op until a DSN is set). This is the capture path
// that was missing — auto-caught render errors used to hit only the dark Sentry no-op, so
// the sink stayed empty while the app crashed. Import observe lazily + guarded so a capture
// failure (e.g. under the edge runtime) can never break the request itself.
export async function onRequestError(
  ...args: Parameters<typeof Sentry.captureRequestError>
): Promise<void> {
  const [err, request, context] = args;
  try {
    const { reportError } = await import("@/lib/observe");
    reportError("rsc-render", err, {
      digest: (err as { digest?: string } | undefined)?.digest,
      path: (request as { path?: string } | undefined)?.path,
      routerKind: (context as { routerKind?: string } | undefined)?.routerKind,
    });
  } catch {
    /* observability must never break a request */
  }
  Sentry.captureRequestError(...args);
}
