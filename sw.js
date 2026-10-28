// Отбор: кэш оболочки приложения, чтобы лента открывалась мгновенно и без сети.
// Свежие данные (feed.json, config.json) всегда берутся из сети.
const V = 'otbor-v3';
const SHELL = ['./', 'index.html', 'parse.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/\/(feed|config)\.json$/.test(url.pathname)) return; // данные — только из сети

  // Страница и код: сначала сеть (чтобы приходили обновления), без сети — из кэша
  if (req.mode === 'navigate' || /\/$|index\.html$|parse\.js$/.test(url.pathname)) {
    const key = url.pathname.endsWith('parse.js') ? 'parse.js' : 'index.html';
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(V).then(c => c.put(key, copy)); return res; })
        .catch(() => caches.match(key))
    );
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});
