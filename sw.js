// TraceMyWay service worker — tile + app-shell caching for offline map use.
//
// Scope: this file must live next to index.html (site root) so it can
// intercept requests for the whole app. It does two things:
//
//   1. Caches CARTO map tiles the first time they're fetched, then serves
//      them from cache on later requests (cache-first, refreshed in the
//      background when online). This is what lets a previously-viewed
//      area keep rendering with no signal.
//   2. Caches the app shell (index.html, tailwind.css, Leaflet, favicon)
//      the same way, so the app itself can open with no connection too.
//
// Routing (OSRM) and search (Nominatim) calls are deliberately left alone —
// they're not cached, and go straight to the network as before.

const APP_SHELL_CACHE = 'tmw-shell-v1';
const TILE_CACHE = 'tmw-tiles-v1';
const MAX_TILES = 4000; // rough cap so the cache can't grow unbounded

const APP_SHELL_URLS = [
  './',
  './index.html',
  './tailwind.css',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './icons/TraceMyWay.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .catch(() => { /* best-effort — a missing file here shouldn't block install */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => name !== APP_SHELL_CACHE && name !== TILE_CACHE)
        .map((name) => caches.delete(name))
    ))
  );
  self.clients.claim();
});

function isTileRequest(url) {
  return url.hostname.endsWith('basemaps.cartocdn.com');
}

function isAppShellRequest(url) {
  return url.origin === self.location.origin;
}

// Cache.keys() returns entries in roughly insertion order in practice (not
// spec-guaranteed, but true in Chrome/Firefox/Safari today), so trimming
// from the front approximates evicting the oldest tiles first. Good enough
// for keeping storage bounded without a full LRU index.
async function trimTileCache() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  const excess = keys.length - MAX_TILES;
  if (excess > 0) {
    await Promise.all(keys.slice(0, excess).map((req) => cache.delete(req)));
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        const networkFetch = fetch(event.request)
          .then((res) => {
            if (res && res.ok) {
              cache.put(event.request, res.clone());
              trimTileCache();
            }
            return res;
          })
          .catch(() => null);
        // Serve the cached tile instantly if we have one (and refresh it in
        // the background); otherwise wait on the network.
        if (cached) return cached;
        const fromNetwork = await networkFetch;
        return fromNetwork || new Response('', { status: 504, statusText: 'Offline and not cached' });
      })
    );
    return;
  }

  if (isAppShellRequest(url)) {
    event.respondWith(
      caches.open(APP_SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) {
          // Stale-while-revalidate: return the cached copy now, refresh
          // quietly for next time.
          fetch(event.request)
            .then((res) => { if (res && res.ok) cache.put(event.request, res.clone()); })
            .catch(() => {});
          return cached;
        }
        try {
          const res = await fetch(event.request);
          if (res && res.ok) cache.put(event.request, res.clone());
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
  }
});
