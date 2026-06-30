// Minimal runtime cache service worker (Phase 0).
// Robust to Vite's hashed asset names: caches same-origin GETs as they're
// fetched, so the app shell + nouns data work offline after first load.
// For production-grade precaching/versioning, switch to vite-plugin-pwa.
const CACHE = "ddd-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  // Navigations are network-first: always try a fresh index.html so a new deploy
  // can't get stuck behind a stale cached shell that points at asset filenames
  // which no longer exist — a refresh that never recovers without clearing site
  // data (issue #12). Fall back to the cached shell only when offline.
  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match("/")).then((res) => res || Response.error())),
    );
    return;
  }

  // Hashed assets are content-addressed, so cache-first is safe and fast. A
  // failed asset fetch is NOT backfilled with the app shell — returning HTML for
  // a script/JSON request only masks the real failure.
  e.respondWith(
    caches.match(request).then((hit) =>
      hit ||
      fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      }),
    ),
  );
});
