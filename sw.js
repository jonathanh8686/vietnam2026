/* Offline support: same-origin files are network-first (so Notion updates
 * show up as soon as you're online) with a 4s timeout, falling back to the
 * last saved copy. Fonts and Leaflet are served from cache when present.
 * Map tiles are not cached. */
// Bump VERSION together with the ?v= on style.css/app.js in every .html file.
var VERSION = '5';
var CACHE = 'vn26-v' + VERSION;
var CORE = [
  './', 'index.html', 'calendar.html', 'itinerary.html', 'housing.html',
  'css/style.css?v=' + VERSION, 'js/app.js?v=' + VERSION, 'data/trip.json', 'data/notion.json',
  'icon.svg', 'manifest.webmanifest'
];
var CDN = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com)\//;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return caches.open(CACHE).then(function (cache) {
    var net = fetch(req).then(function (res) {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 4000); });
    // Versioned assets (?v=) must match exactly, so a slow network never pairs
    // new HTML with a stylesheet or script saved from an older version.
    var exact = /[?&]v=/.test(req.url);
    var cached = function () {
      return cache.match(req, { ignoreSearch: !exact }).then(function (hit) { return hit || net; });
    };
    return Promise.race([net, timeout.then(cached)]).then(function (res) { return res || cached(); }, cached);
  });
}

function cacheFirst(req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      });
      return hit || net;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === location.origin) e.respondWith(networkFirst(req));
  else if (CDN.test(req.url)) e.respondWith(cacheFirst(req));
});
