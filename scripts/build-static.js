// 静的ホスト用の配信ディレクトリ dist/ を組み立てる。
//   - public/ (ビューア資産) と trips/ (便データ) を1つにまとめる
//   - トップの全国マップ用 overview.json を生成
//   - OGP画像 (各便 + トップ) を /og/ に生成
//   - 各便の実HTML (/trips/<date>.html, /l/<cd>.html) を、便ごとの OGP メタ入りで出力
//     (SNSクローラはJSを実行せず<head>を読むため、SPAのままでは全ページ同じになる)
//
// 静的ホストの設定:  ビルドコマンド = node scripts/build-static.js / 出力 = dist
// SPA ルーティングは wrangler.jsonc (single-page-application) 側。
// サイトの絶対URLは環境変数 SITE_URL で上書き可 (既定は本番URL)。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync, cpSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { buildOverview, allTrips } from "../lib/trips-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = join(ROOT, "dist");
const SITE = (process.env.SITE_URL || "https://bunshin-tabi.com").replace(/\/$/, "");

const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// <!--OGP-->...<!--/OGP--> の中身を差し替える
function injectMeta(html, block) {
  return html.replace(/<!--OGP-->[\s\S]*?<!--\/OGP-->/, `<!--OGP-->\n${block}\n<!--/OGP-->`);
}

function metaBlock({ title, desc, url, image, type = "article" }) {
  const L = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:site_name" content="分身の旅日記">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
  ];
  if (image) {
    L.push(
      `<meta property="og:image" content="${esc(image)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:image" content="${esc(image)}">`
    );
  } else {
    L.push(`<meta name="twitter:card" content="summary">`);
  }
  L.push(`<meta name="twitter:title" content="${esc(title)}">`, `<meta name="twitter:description" content="${esc(desc)}">`);
  return L.join("\n");
}

// ---- 組み立て ----
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, "public"), DIST, { recursive: true });

const TRIPS = join(ROOT, "trips");
if (existsSync(TRIPS)) cpSync(TRIPS, join(DIST, "trips"), { recursive: true });
mkdirSync(join(DIST, "trips"), { recursive: true });

const overview = buildOverview();
writeFileSync(join(DIST, "trips", "overview.json"), JSON.stringify(overview));

const trips = allTrips();

// OGP画像 (best-effort: 依存や描画で失敗してもビルドは止めない)。
// ogimage は @resvg/resvg-wasm に依存するため、動的 import で保護する。
let ogOk = false;
try {
  const og = await import("../lib/ogimage.js");
  mkdirSync(join(DIST, "og", "trips"), { recursive: true });
  mkdirSync(join(DIST, "og", "l"), { recursive: true });
  const siteHost = SITE.replace(/^https?:\/\//, "");
  for (const t of trips) {
    writeFileSync(join(DIST, t.ogPath.slice(1)), await og.renderPng(og.tripSvg(t.trip, siteHost)));
  }
  writeFileSync(join(DIST, "og", "default.png"), await og.renderPng(og.homeSvg(overview.stats)));
  ogOk = true;
  console.error(`OGP画像: ${trips.length + 1}枚生成`);
} catch (e) {
  console.error(`OGP画像の生成をスキップ (${e.message})。テキストメタのみで続行。`);
}

// 各便の実HTML (便ごとの OGP メタ入り)。テンプレートは dist/index.html を一度だけ読む。
const template = readFileSync(join(DIST, "index.html"), "utf8");

for (const t of trips) {
  const trip = t.trip;
  const p = trip.persona || {};
  const st = trip.stations || [];
  const first = st.length ? st[0].name : "";
  const last = st.length ? st[st.length - 1].name : "";
  const title = `${p.emoji ? p.emoji + " " : ""}分身${p.name || ""}の旅日記 — ${trip.line.name}`;
  const desc = `${trip.line.company || ""} ${first}→${last}・約${trip.line.km ?? "?"}km・${trip.date}。分身が実在の鉄道を旅した一人称の日記。`;
  const image = ogOk ? SITE + t.ogPath : null;
  const html = injectMeta(template, metaBlock({ title, desc, url: SITE + t.url, image, type: "article" }));
  const outPath = join(DIST, t.htmlFile);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
}

// トップ (index.html) は website 種別で絶対URL化
writeFileSync(
  join(DIST, "index.html"),
  injectMeta(template, metaBlock({
    title: "分身の旅日記 — 日本全国の旅",
    desc: "分身が日本の実在の鉄道を旅した記録。毎朝1本、新しい路線へ。",
    url: SITE + "/",
    image: ogOk ? SITE + "/og/default.png" : null,
    type: "website",
  }))
);

console.error(`dist/ を組み立てました → ${DIST}`);
console.error(`  便HTML: ${trips.length}件 / overview: ${overview.stats.trips}便 / OGP: ${ogOk ? "あり" : "なし"}`);
console.error(`  ビルドコマンド: node scripts/build-static.js / 出力: dist / SITE=${SITE}`);
