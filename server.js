// 分身の旅日記 v1 サーバ。依存ゼロ (Node 標準 http) の静的配信 + trip API。
// v1 は認証・DB 不要。trips/*.json を配るだけ。
//
// ルート:
//   GET /                      → 最新便へリダイレクト
//   GET /trips/<date>          → ビューア (index.html)。JS が日付を読む
//   GET /l/<line_cd>           → ビューア (路線指定の便)
//   GET /api/latest            → 最新便の trip JSON
//   GET /api/trips/<date>      → 指定便の trip JSON
//   GET /api/index             → 連載一覧
//   GET /api/lines             → 旅の対象になる路線一覧 (ピッカー用)
//   GET /api/lines/<cd>        → 路線指定の便 (キャッシュ済み) の trip JSON
//   GET /api/lines/<cd>/generate  → その路線を巡って生成 (SSE で進捗+完成品を流す)
//   GET /<static>              → public/ の静的資産
//
// 起動: node server.js  (PORT 環境変数で変更可、既定 8787)

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { loadTrip, loadIndex, latestDate, loadLineTrip, buildOverview } from "./lib/trips-store.js";
import { listLines } from "./lib/stations.js";
import { generateTrip } from "./scripts/generate-trip.js";
import { hasApiKey, apiKeyEnvName, activeProvider } from "./lib/diary.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const PORT = Number(process.env.PORT) || 8787;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendFile(res, path) {
  const ext = extname(path);
  const body = readFileSync(path);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "content-length": body.length });
  res.end(body);
}

function serveIndex(res) {
  sendFile(res, join(PUBLIC, "index.html"));
}

// SSE (Server-Sent Events) の送信ヘルパ。生成の進捗を逐次流す。
function openSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 同じ路線の同時多重生成を防ぐ (API コストの無駄打ち防止)
const inflight = new Set();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = decodeURIComponent(url.pathname);

  // --- ルート: トップ (全国カバレッジマップ)。ビューア側が overview を読む ---
  if (path === "/") {
    return serveIndex(res);
  }

  // --- API ---
  if (path === "/api/latest") {
    const latest = latestDate();
    const trip = latest ? loadTrip(latest) : null;
    return trip ? sendJson(res, 200, { trip }) : sendJson(res, 404, { error: "no trips" });
  }
  const mTrip = path.match(/^\/api\/trips\/(\d{4}-\d{2}-\d{2})$/);
  if (mTrip) {
    const trip = loadTrip(mTrip[1]);
    return trip ? sendJson(res, 200, { trip }) : sendJson(res, 404, { error: "not found" });
  }
  if (path === "/api/index") {
    return sendJson(res, 200, loadIndex());
  }

  // --- このサーバが生成バックエンドを持つか (ビューアが 🚃 を出すか判定する) ---
  if (path === "/api/capabilities") {
    return sendJson(res, 200, { generate: true, provider: activeProvider(), hasKey: hasApiKey() });
  }

  // --- 全国カバレッジ (トップ) 用データ。実ファイルは無いので都度生成 ---
  if (path === "/trips/overview.json") {
    return sendJson(res, 200, buildOverview());
  }

  // --- trips/ 配下の JSON を配信 (静的ホストと同じパスでビューアを動かすため) ---
  if (/^\/trips\/(lines\/)?[^/]+\.json$/.test(path)) {
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    const fp = join(HERE, safe);
    const TRIPS = join(HERE, "trips");
    if (fp.startsWith(TRIPS) && existsSync(fp) && statSync(fp).isFile()) {
      return sendFile(res, fp);
    }
    return sendJson(res, 404, { error: "not found" });
  }

  // --- 路線ピッカー用の一覧 ---
  if (path === "/api/lines") {
    return sendJson(res, 200, listLines());
  }

  // --- 路線指定の便を巡って生成 (SSE) ---
  const mGen = path.match(/^\/api\/lines\/(\d+)\/generate$/);
  if (mGen) {
    const cd = Number(mGen[1]);
    const refresh = url.searchParams.get("refresh") === "1";
    const send = openSse(res);
    try {
      if (!refresh) {
        const cached = loadLineTrip(cd);
        if (cached) {
          send("done", { trip: cached, cached: true });
          return res.end();
        }
      }
      if (inflight.has(cd)) {
        send("error", { error: "この路線は今まさに生成中です。少し待ってからもう一度お試しください。" });
        return res.end();
      }
      if (!hasApiKey()) {
        send("error", {
          error: `サーバに ${apiKeyEnvName()} が未設定のため、日記を生成できません。線形と沿線情報の取得までは動作します。`,
          needsKey: true,
        });
        return res.end();
      }
      inflight.add(cd);
      const result = await generateTrip({
        lineCd: cd,
        store: "line",
        onProgress: (stage, msg) => send("progress", { stage, msg }),
      });
      send("done", { trip: result.trip });
    } catch (e) {
      send("error", { error: String((e && e.message) || e) });
    } finally {
      inflight.delete(cd);
      res.end();
    }
    return;
  }

  // --- 路線指定の便 (キャッシュ済み) の trip JSON ---
  const mLine = path.match(/^\/api\/lines\/(\d+)$/);
  if (mLine) {
    const trip = loadLineTrip(Number(mLine[1]));
    return trip ? sendJson(res, 200, { trip }) : sendJson(res, 404, { error: "not generated" });
  }

  // --- ビューアページ: /trips/<date> または /l/<line_cd> ---
  if (/^\/trips\/\d{4}-\d{2}-\d{2}$/.test(path) || /^\/l\/\d+$/.test(path)) {
    return serveIndex(res);
  }

  // --- 静的資産 (public/) ---
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC, safe);
  if (filePath.startsWith(PUBLIC) && existsSync(filePath) && statSync(filePath).isFile()) {
    return sendFile(res, filePath);
  }

  // 本番 (Cloudflare) と同じく 404.html を 404 で返す
  const notFound = join(PUBLIC, "404.html");
  if (existsSync(notFound)) {
    const body = readFileSync(notFound);
    res.writeHead(404, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
    return res.end(body);
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  const latest = latestDate();
  console.error(`分身の旅日記 → http://localhost:${PORT}/`);
  console.error(latest ? `最新便: /trips/${latest}` : "便がまだありません (node scripts/build-samples.js でシード)");
});
