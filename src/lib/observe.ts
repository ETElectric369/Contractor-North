import "server-only";
import * as Sentry from "@sentry/nextjs";

/**
 * Report a background / best-effort failure that must NOT surface to the user but
 * also must not vanish silently. Sends it to Sentry (visible in the dashboard; a
 * no-op until NEXT_PUBLIC_SENTRY_DSN is set) and the server console. Never throws —
 * observability must never break the caller. Use in the catches of fire-and-forget
 * work (calendar sync, push, the daily automation cron) so a solo operator actually
 * finds out when an integration quietly breaks.
 */
export function reportError(where: string, e: unknown, extra?: Record<string, unknown>): void {
  try {
    console.error(`[${where}]`, e instanceof Error ? e.message : e, extra ?? "");
    Sentry.captureException(e, { tags: { where }, extra });
  } catch {
    /* never let reporting throw */
  }
}
