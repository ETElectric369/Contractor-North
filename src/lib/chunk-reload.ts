// Stale-chunk recovery. When a browser tab is left open across a deploy, a later lazy
// import tries to fetch a code chunk the NEW build renamed → "Loading chunk NNNN failed" /
// ChunkLoadError. It's benign — the fix is simply to reload into the fresh build — but it
// surfaced as a blank error-boundary card (and noise in the error log). These helpers let the
// boundaries auto-recover instead.

/** True if the error is a stale/failed code-chunk load (all the shapes Next/webpack throw). */
export function isChunkLoadError(e: unknown): boolean {
  const msg = (e instanceof Error ? `${e.name} ${e.message}` : String(e ?? "")).toLowerCase();
  return (
    msg.includes("loading chunk") ||
    msg.includes("chunkloaderror") ||
    msg.includes("loading css chunk") ||
    msg.includes("dynamically imported module") || // "Failed to fetch dynamically imported module"
    msg.includes("importing a module script failed")
  );
}


/** A tab from an OLD deploy talking to the NEW one: the webpack runtime asks for a module id it
 *  never shipped ("e[o] is not a function"), or a server-action id the new build doesn't know
 *  ("An unexpected response was received from the server"). Same cure as a stale chunk. */
export function isStaleBuildError(e: unknown): boolean {
  const msg = (e instanceof Error ? `${e.name} ${e.message}` : String(e ?? "")).toLowerCase();
  return (
    msg.includes("unexpected response was received from the server") ||
    msg.includes("failed to find server action") ||
    /e\[o\] is not a function|\(a,a\.exports,r\)/.test(msg)
  );
}

/** The network blipped mid-fetch — WebKit "Load failed", Chrome "Failed to fetch", the lowercase
 *  "network error" the browser itself emits. Not a defect in our code: a retry, not a crash card. */
export function isTransportError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e ?? "")).trim().toLowerCase();
  return /^(load failed|failed to fetch|network error|networkerror|the network connection was lost|the internet connection appears to be offline)/.test(msg);
}

const RELOAD_KEY = "cn_chunk_reload_at";
const RELOAD_GUARD_MS = 10_000;

/**
 * If `e` is a stale-chunk error, reload the page ONCE into the fresh build and return true.
 * Guarded by a short-lived sessionStorage timestamp so a genuinely broken chunk (offline, a
 * real 404) can't loop-reload — after one reload inside the window we return false and let the
 * boundary report the error + show its fallback. A future deploy (well past the window) still
 * earns its own single reload.
 */
export function recoverFromChunkError(e: unknown): boolean {
  if (typeof window === "undefined" || !(isChunkLoadError(e) || isStaleBuildError(e))) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < RELOAD_GUARD_MS) return false; // already tried just now → don't loop
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}
