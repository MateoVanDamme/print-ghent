// Cache STL tiles fetched from the fly-over-ghent GCS bucket so repeat
// crops don't re-download the same gigabytes. Bump the version whenever
// the upstream tile contents change.
const CACHE_NAME = 'print-ghent-tiles-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const url = event.request.url;
    if (!url.includes('storage.googleapis.com/fly-over-ghent/') || !url.endsWith('.stl')) {
        return;
    }
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(url);
        if (cached) return cached;
        const response = await fetch(url);
        if (response.ok) cache.put(url, response.clone());
        return response;
    })());
});
