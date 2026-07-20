import { createServiceClient } from "@/lib/supabase/server";

/**
 * Distributed fixed-window rate limit backed by Postgres (the rate_limit_hit function). Atomic —
 * concurrent requests can't race past the cap, unlike a per-serverless-instance in-memory map.
 * Returns TRUE when the caller is OVER the limit for the current window (i.e. REJECT the request).
 *
 * FAILS OPEN by default on any error, so a limiter hiccup never blocks real users — the right
 * trade for an authenticated surface where a false block costs more than a missed limit.
 *
 * Pass `{ failClosed: true }` on any UNAUTHENTICATED path where exceeding the limit SPENDS MONEY
 * (model calls, outbound email/SMS). There, a limiter outage silently removing the only cost
 * control is the worse failure: degrade the feature instead.
 *
 *   if (await rateLimited(`chat:${ip}`, 15, 60)) return 429                     // ≤15 per 60s per key
 *   if (await rateLimited(`chat:${ip}`, 15, 60, { failClosed: true })) return 429
 */
export async function rateLimited(
  key: string,
  limit: number,
  windowSeconds: number,
  opts?: { failClosed?: boolean },
): Promise<boolean> {
  const onError = !!opts?.failClosed; // true = report "over the limit" = reject
  try {
    const sb = createServiceClient();
    const { data, error } = await sb.rpc("rate_limit_hit", {
      p_key: key.slice(0, 200),
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return onError;
    return data === true;
  } catch {
    return onError;
  }
}

/** First forwarded client IP from a request's headers, or "anon". */
export function clientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
}
