// Contractor North service worker — conservative, safe-by-design.
//
// Navigations are ALWAYS network-first (the app html is never served stale),
// so a SW bug can't trap users on old code. We only cache hashed/immutable
// static assets and an offline fallback page. API and auth requests are never
// touched. Bump VERSION to invalidate the static cache.
const VERSION = "cn-v1";
const STATIC_CACHE = `static-${VERSION}`;
const PRECACHE = ["/offline", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Never cache or intercept API / auth traffic.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  // Page navigations: network-first → cache → offline page. Never serve stale html.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(req).then((cached) => cached || caches.match("/offline")),
      ),
    );
    return;
  }

  // Static assets (hashed by Next, or images/fonts): stale-while-revalidate.
  if (
    url.pathname.startsWith("/_next/static") ||
    /\.(?:png|svg|jpg|jpeg|webp|gif|ico|woff2?|css|js)$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
