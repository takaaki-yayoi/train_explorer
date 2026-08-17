// キルスイッチ SW。
// 以前の SW が /trips/<date> のナビゲーションで Cloudflare 上リダイレクトになる
// /index.html をキャッシュから返し、空ページ (真っ白) を生む不具合があった。
// v1 ではオフライン機能より確実性を優先し、SW を廃止する。
// この SW は「fetch に一切介入せず」「起動時に全キャッシュ削除 + 自身を unregister +
// 開いているタブを再読込」して、既に壊れた SW を持つブラウザも自動回復させる。

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        // 制御が外れた状態で再読込し、ネットワーク直取得に戻す
        try { client.navigate(client.url); } catch { /* ignore */ }
      }
    })()
  );
});

// fetch ハンドラは定義しない → すべてネットワーク素通し (SW は何も介入しない)
