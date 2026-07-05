import { createServiceClient } from "@/lib/supabase/server";

/**
 * Distributed fixed-window rate limit backed by Postgres (the rate_limit_hit function). Atomic —
 * concurrent requests can't race past the cap, unlike a per-serverless-instance in-memory map.
 * Returns TRUE when the caller is OVER the limit for the current window (i.e. REJECT the request).
 * FAILS OPEN on any error so a limiter hiccup never blocks real users.
 *
 *   if (await rateLimited(`chat:${ip}`, 15, 60)) return 429   // ≤15 per 60s per key
 */
export async function rateLimited(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    const sb = createServiceClient();
    const { data, error } = await sb.rpc("rate_limit_hit", {
      p_key: key.slice(0, 200),
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** First forwarded client IP from a request's headers, or "anon". */
export function clientIp(headers: Headers): string {
  return (headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
}
