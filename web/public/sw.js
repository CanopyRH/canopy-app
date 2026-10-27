// Keeps the app shell for offline opening. Chain data is never cached, and the network always wins, so a fix reaches people on their next visit.
const CACHE = "canopy-shell-v4";
const SHELL = ["app.html", "app.css", "app.js", "manifest.webmanifest", "icon-192.png", "assets/canopy-logo.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== CACHE).map((x) => caches.delete(x))))));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Video arrives in partial (206) pieces, which a cache can't hold.
        if (res.status === 200) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
