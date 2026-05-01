// Workbooks PWA service worker.
//
// Job: register the PWA, cache the shell assets so the shell can boot
// offline (and for instant relaunches after install). DOES NOT cache
// user data — the workbook file the user opens is the database; we
// just bootstrap the runtime that reads it.
//
// Versioning: bump CACHE_NAME on shell updates to force refresh.

const CACHE_NAME = "workbooks-shell-v1";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch((e) => {
        // Some assets might not exist yet during dev; cache what's available.
        console.warn("[sw] partial precache:", e?.message ?? e);
      })),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // Cache-first for shell origin assets, network-first for everything else.
  // Workbook .html files (when launched via file_handlers) are NOT
  // intercepted — the launchQueue API handles them out-of-band.
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return (
          cached
          || fetch(event.request).then((res) => {
            // Opportunistically cache successful GETs of shell assets.
            if (
              event.request.method === "GET"
              && res.ok
              && SHELL_ASSETS.includes(url.pathname)
            ) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
            }
            return res;
          })
        );
      }),
    );
  }
});
