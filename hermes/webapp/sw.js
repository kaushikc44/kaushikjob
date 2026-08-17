// Minimal service worker — exists purely so Android/Chrome treats this page
// as an installable PWA. No offline caching (this app needs a live network
// connection to be useful anyway), just a pass-through fetch handler.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => self.clients.claim());
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));
