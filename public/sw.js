// Contractor North service worker — conservative, safe-by-design.
//
// Navigations are ALWAYS network-first (the app html is never served stale),
// so a SW bug can't trap users on old code. We only cache hashed/immutable
// static assets and an offline fallback page. API and auth requests are never
// touched. Bump VERSION to invalidate the static cache.
const VERSION = "cn-v628";
const STATIC_CACHE = `static-${VERSION}`;
// Pages visited while online, kept so a dead zone shows the real page instead of /offline.
// SEPARATE from the static cache because it holds ORG DATA and has to be purgeable on sign-out.
const PAGE_CACHE = `pages-${VERSION}`;
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
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== PAGE_CACHE).map((k) => caches.delete(k))),
      )
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
  //
  // The cache arm was DEAD until now: nothing ever wrote a navigation into a cache, so
  // `caches.match(req)` always missed and every offline navigation fell to /offline. A tech in a
  // Chilcoot dead zone got the offline page for a job he'd had open ten minutes earlier. Now a
  // successful navigation is copied into PAGE_CACHE, so the last-seen version of a page he
  // actually visited is there when the signal isn't.
  //
  // Still network-FIRST, so nobody is ever served stale html when the network works.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only cache a real, complete page. An opaque/redirected/error response cached here
          // would be served back as if it were the page.
          if (res && res.ok && res.type === "basic" && !res.redirected) {
            const copy = res.clone();
            caches.open(PAGE_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
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

// PURGE ON SIGN-OUT. PAGE_CACHE holds rendered pages, which means it holds one org's customers,
// jobs and money. On a shared or handed-down device the next person must not be able to page back
// into it, so signing out clears it. Static assets are impersonal and stay.
self.addEventListener("message", (event) => {
  if (event.data?.type === "purge-pages") {
    event.waitUntil(caches.delete(PAGE_CACHE));
  }
});

// ── Web push ────────────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Contractor North";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/dashboard" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
