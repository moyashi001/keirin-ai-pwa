/**
 * service-worker.js
 * オフライン動作のためのキャッシュ戦略(cache-first + バックグラウンド更新)。
 * 静的アセット・ONNX Runtimeランタイム・(あれば)AIモデル本体をキャッシュする。
 *
 * 重要: index.html/styles.css/*.js を更新した際は、このファイル内の VERSION を
 * 必ずインクリメントすること。VERSION を変えないとこのファイル自体のバイト内容が
 * 変わらず、ブラウザがSW更新を検知できないため、既存ユーザーに古いキャッシュが
 * 配信され続けてしまう。
 */

const VERSION = 'v3';
const CACHE_NAME = `keirin-ai-cache-${VERSION}`;

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './modelRunner.js',
  './featureBuilder.js',
  './htmlParser.js',
  './generateArticle.js',
  './db.js',
  './components/betting.js',
  './components/chart.js',
  './components/raceCard.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './vendor/ort/ort.min.js',
  './vendor/ort/ort-wasm.wasm',
  './vendor/ort/ort-wasm-simd.wasm',
];

const OPTIONAL_ASSETS = ['./assets/keirin_model.onnx'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE_ASSETS);
      // モデルファイルは無い場合が多いため、失敗しても致命的にしない
      await Promise.all(
        OPTIONAL_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url);
            if (res.ok) await cache.put(url, res);
          } catch (_) {
            /* モデル未配置の場合は無視 */
          }
        })
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) {
        // バックグラウンドで最新版に更新(次回アクセス時に反映)
        fetch(req)
          .then((res) => {
            if (res && res.ok) caches.open(CACHE_NAME).then((c) => c.put(req, res));
          })
          .catch(() => {});
        return cached;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        if (req.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});
