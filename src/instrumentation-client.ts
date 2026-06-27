import * as Sentry from "@sentry/nextjs";

/** Browser error monitoring. Ships DARK: no-op until NEXT_PUBLIC_SENTRY_DSN is set. */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Performance tracing for the testing window — sample rate is env-overridable so quota can be
  // dialed back (e.g. NEXT_PUBLIC_SENTRY_TRACES_RATE=0.2). Defaults to 100% (full latency data;
  // a small internal crew won't hit the free quota). Still fully dark until the DSN is set.
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_RATE ?? "1"),
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
