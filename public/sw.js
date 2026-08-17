// 分身の旅日記 サービスワーカー (v1)。
// アプリシェルをキャッシュし、trip JSON はネット優先+フォールバックで一度読んだ便をオフライン閲覧可能に。
const SHELL = "bunshin-shell-v4";
const DATA = "bunshin-data-v4";
// "/" は最新便への 302 リダイレクトなのでキャッシュしない。実体の /index.html を使う。
const SHELL_ASSETS = ["/index.html", "/style.css", "/app.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // 便のページ (/trips/<date>) はアプリシェル (index) を返す
  if (url.origin === location.origin && /^\/trips\/\d{4}-\d{2}-\d{2}$/.test(url.pathname)) {
    e.respondWith(caches.match("/index.html").then((r) => r || fetch(e.request)));
    return;
  }

  // 生成ストリーム (SSE) はキャッシュせず素通し (event-stream は clone/put できない)
  if (url.origin === location.origin && /\/generate$/.test(url.pathname)) {
    return; // ブラウザ既定のネットワーク処理に任せる
  }

  // trip データ (trips/*.json) と API: ネット優先、失敗時キャッシュ (毎朝の更新を取りこぼさない)
  const isData = url.pathname.startsWith("/api/") || /^\/trips\/.*\.json$/.test(url.pathname);
  if (url.origin === location.origin && isData) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // それ以外 (同一オリジンの静的資産): キャッシュ優先
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
