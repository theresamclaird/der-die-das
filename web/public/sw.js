// Minimal runtime cache-first service worker (Phase 0).
// Robust to Vite's hashed asset names: caches same-origin GETs as they're
// fetched, so the app shell + nouns data work offline after first load.
// For production-grade precaching/versioning, switch to vite-plugin-pwa.
const CACHE = "ddd-v1";

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(request).then((hit) =>
      hit ||
      fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      }).catch(() => caches.match("/")),
    ),
  );
});
