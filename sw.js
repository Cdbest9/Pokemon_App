// Service worker: permette di aprire l'app anche offline (l'OCR e le pagine restano in cache).
const CACHE = "pokecollection-v1";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;   // le chiamate a CardTrader non passano di qui
  const heavy = /(\.wasm\.js|\.gz|worker\.min\.js|tesseract\.min\.js)$/.test(url.pathname);
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (heavy) {   // file pesanti dell'OCR: prima la cache
      const hit = await cache.match(req); if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true }); if (hit) return hit;
      throw err;
    }
  })());
});
