import { describe, it, expect, vi, afterEach } from "vitest";
import { connectionNeedsReauth, gcalTokenForConnection } from "@/lib/google-calendar";

/**
 * The dead-grant circuit breaker (7/15): a Google refresh that comes back
 * 400/401 means the grant is DEAD (revoked / stale scopes) — the connection
 * must mark itself broken (sync_tokens = {"error":"reauth"}) and every later
 * token ask must short-circuit, so the 15-min cron can't spam
 * "Token refresh failed (400)" forever. Transient failures still throw.
 */

/** Minimal supabase stub recording update() calls (the only I/O this path does). */
function fakeSupabase() {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  return {
    updates,
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          return {
            eq: async () => {
              updates.push({ table, patch });
              return { data: null, error: null };
            },
          };
        },
      };
    },
  };
}

const deadConn = (extra: Record<string, unknown> = {}) => ({
  id: "conn-1",
  org_id: "org-1",
  access_token: "stale",
  refresh_token: "dead-refresh",
  expires_at: new Date(Date.now() - 60_000).toISOString(), // expired → must refresh
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("connectionNeedsReauth — the sync_tokens reauth marker", () => {
  it("is true only for the {'error':'reauth'} marker", () => {
    expect(connectionNeedsReauth({ sync_tokens: { error: "reauth" } })).toBe(true);
    expect(connectionNeedsReauth({ sync_tokens: {} })).toBe(false);
    expect(connectionNeedsReauth({ sync_tokens: { "cal@x": { token: "t", at: "2026-07-01" } } })).toBe(false);
    expect(connectionNeedsReauth({ sync_tokens: null })).toBe(false);
    expect(connectionNeedsReauth(null)).toBe(false);
  });
});

describe("gcalTokenForConnection — dead grants break the circuit", () => {
  it("marks the connection broken on a 400 refresh and returns null (no throw)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })));
    const sb = fakeSupabase();
    const token = await gcalTokenForConnection(sb, deadConn());
    expect(token).toBeNull();
    expect(sb.updates).toEqual([
      { table: "calendar_connections", patch: { sync_tokens: { error: "reauth" } } },
    ]);
  });

  it("skips an already-broken connection without calling Google at all", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sb = fakeSupabase();
    const token = await gcalTokenForConnection(sb, deadConn({ sync_tokens: { error: "reauth" } }));
    expect(token).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // the cron's 15-min retry loop is broken here
    expect(sb.updates).toEqual([]); // and nothing is re-reported / re-written
  });

  it("still throws on a transient (5xx) failure — retry next run, no broken mark", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const sb = fakeSupabase();
    await expect(gcalTokenForConnection(sb, deadConn())).rejects.toThrow("Token refresh failed (503)");
    expect(sb.updates).toEqual([]);
  });

  it("returns the stored token untouched while it is still fresh", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sb = fakeSupabase();
    const token = await gcalTokenForConnection(
      sb,
      deadConn({ access_token: "fresh", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    expect(token).toBe("fresh");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
