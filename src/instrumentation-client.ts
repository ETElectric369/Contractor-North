import * as Sentry from "@sentry/nextjs";

/** Browser error monitoring. Ships DARK: no-op until NEXT_PUBLIC_SENTRY_DSN is set. */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
