// オフライン対応：常にネットワーク優先、つながらないときだけキャッシュ
const CACHE = 'kabuka-hack-v18';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/providers.js', 'js/signals.js', 'js/indicators.js', 'js/backtest.js', 'js/chart.js', 'js/ai.js', 'js/explain.js', 'js/levels.js', 'js/market.js', 'js/review.js', 'js/aitrack.js', 'js/csvimport.js', 'js/portfolio.js', 'js/treemap.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request.url.split('?')[0], copy)); return r; })
        .catch(() => caches.match(e.request.url.split('?')[0])),
    );
    return;
  }
  // 画面：常に最新を取りに行き、オフラインのときだけキャッシュを使う
  e.respondWith(
    fetch(e.request)
      .then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request)),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});
