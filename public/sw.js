// Simple PWA service worker: cache app shell and model, offline-first for navigation, cache-first for assets.
// Versioned cache
const CACHE = "erasebg-v1";
const APP_SHELL = [
  "/",
  "/editor/",
  "/recent/",
  "/privacy/",
  "/settings/",
  "/manifest.json",
  "/icon.svg",
];

// Install: pre-cache shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL).catch(()=>{}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: offline-first for navigations, cache-first for others, network fallback
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Cache model/CDN requests for background-removal
  if (url.hostname.includes("cdn.jsdelivr.net") || url.hostname.includes("cdn.skypack.dev") || url.pathname.includes("model") || url.pathname.includes(".onnx") || url.pathname.includes(".wasm")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Navigation: network-first fallback to cache
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res)=>{
        const clone = res.clone();
        caches.open(CACHE).then(c=>c.put(req, clone)).catch(()=>{});
        return res;
      }).catch(()=> caches.match(req).then(r=> r || caches.match("/")))
    );
    return;
  }

  // Other assets: cache-first
  event.respondWith(
    caches.match(req).then((cached)=>{
      if (cached) return cached;
      return fetch(req).then((res)=>{
        if (res.ok && req.method==="GET" && url.origin===location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c=>c.put(req, clone)).catch(()=>{});
        }
        return res;
      }).catch(()=> cached);
    })
  );
});
