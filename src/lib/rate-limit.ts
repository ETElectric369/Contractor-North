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

/**
 * How many of a key's hits are left in the current window (`limit` when none are used, or the window
 * has passed). Reads only: it never counts a hit. null when the count can't be read (then say
 * nothing about it rather than a wrong number).
 */
export async function rateLimitLeft(key: string, limit: number, windowSeconds: number): Promise<number | null> {
  try {
    const sb = createServiceClient();
    const { data, error } = await sb.from("rate_limits").select("count, window_start").eq("key", key.slice(0, 200)).maybeSingle();
    if (error) return null;
    const row = data as { count: number; window_start: string } | null;
    if (!row) return limit;
    if (new Date(row.window_start).getTime() < Date.now() - windowSeconds * 1000) return limit;
    return Math.max(0, limit - Number(row.count ?? 0));
  } catch {
    return null;
  }
}

/**
 * Give one hit back: a paid call that failed before it was any use (the model errored, or its
 * answer was cut off) should not use up one of a person's capped tries. Compare-and-set on the
 * count, so a concurrent hit is never lost; best effort (false = it couldn't be given back, and
 * the caller says so).
 */
export async function rateLimitGiveBack(key: string): Promise<boolean> {
  try {
    const sb = createServiceClient();
    const k = key.slice(0, 200);
    for (let i = 0; i < 3; i++) {
      const { data, error } = await sb.from("rate_limits").select("count").eq("key", k).maybeSingle();
      if (error || !data) return false;
      const n = Number((data as { count: number }).count ?? 0);
      if (n <= 0) return true;
      const { data: upd, error: uErr } = await sb.from("rate_limits").update({ count: n - 1 }).eq("key", k).eq("count", n).select("key");
      if (uErr) return false;
      if ((upd ?? []).length === 1) return true;
    }
    return false;
  } catch {
    return false;
  }
}
