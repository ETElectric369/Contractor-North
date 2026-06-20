import * as Sentry from "@sentry/nextjs";

/** Server + edge error monitoring via Next 15's instrumentation hook. Ships DARK:
 *  a no-op until NEXT_PUBLIC_SENTRY_DSN is set, so there's zero runtime cost (and
 *  no data leaves) until you create a Sentry project and add the DSN env var. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0, // errors only, no perf tracing (cheapest tier)
    });
  }
}

// Lets Next forward server-side request errors (incl. server actions) to Sentry.
export const onRequestError = Sentry.captureRequestError;
