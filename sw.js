const CACHE = "noise-v10";
const NOISE_CACHE = "noise-audio";
const ASSETS = ["./", "index.html", "app.js", "manifest.json", "icon-192.svg", "icon-512.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== NOISE_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// Listen for messages from the app to store generated audio
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "store-audio") {
    const response = new Response(e.data.blob, {
      headers: { "Content-Type": "audio/wav" }
    });
    caches.open(NOISE_CACHE).then(cache => {
      cache.put(new Request("/generated-noise.wav"), response);
      // Notify the client that audio is ready
      e.source.postMessage({ type: "audio-stored" });
    });
  }
});
