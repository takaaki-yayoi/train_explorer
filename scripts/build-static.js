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

// 日記本文にはスポットへのリンク (<a>) が含まれる。プレーンテキストが要る所で使う。
const stripTags = (s) => String(s == null ? "" : s).replace(/<[^>]+>/g, "").trim();

const fmtDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  const wd = ["日", "月", "火", "水", "木", "金", "土"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}年${m}月${d}日 (${wd})`;
};

// <!--OGP-->...<!--/OGP--> の中身を差し替える
function injectMeta(html, block) {
  return html.replace(/<!--OGP-->[\s\S]*?<!--\/OGP-->/, `<!--OGP-->\n${block}\n<!--/OGP-->`);
}

// <!--ARTICLE-->...<!--/ARTICLE--> の中身を差し替える (静的本文)
function injectArticle(html, block) {
  return html.replace(/<!--ARTICLE-->[\s\S]*?<!--\/ARTICLE-->/, `<!--ARTICLE-->\n${block}\n<!--/ARTICLE-->`);
}

function metaBlock({ title, desc, url, image, type = "article", jsonLd }) {
  const L = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
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
  if (jsonLd) {
    // </script> や < でスクリプトを閉じさせない (JSON-LD の定石)
    const json = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
    L.push(`<script type="application/ld+json">${json}</script>`);
  }
  return L.join("\n");
}

// ---- 構造化データ (JSON-LD) ----

const PUBLISHER = {
  "@type": "Organization",
  name: "分身の旅日記",
  url: SITE + "/",
  logo: { "@type": "ImageObject", url: SITE + "/icon-512.png" },
};

function breadcrumbs(name, url) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "分身の旅日記", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name, item: url },
    ],
  };
}

// 便ページ: BlogPosting + パンくず
function tripJsonLd({ trip, title, desc, url, image }) {
  const p = trip.persona || {};
  const stations = (trip.stations || []).map((s) => s.name);
  // 便は毎朝配信。時刻は日本時間の朝で固定 (日付しか持たないため)
  const published = `${trip.date}T07:00:00+09:00`;
  const post = {
    "@type": "BlogPosting",
    headline: title,
    description: desc,
    inLanguage: "ja",
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    datePublished: published,
    dateModified: published,
    author: { "@type": "Person", name: `分身${p.name || ""}`.trim() },
    publisher: PUBLISHER,
    articleSection: "旅日記",
    keywords: [trip.line.name, trip.line.company, ...stations.map((s) => `${s}駅`), "鉄道", "旅日記"]
      .filter(Boolean)
      .join(","),
    articleBody: (trip.diary || []).map((e) => stripTags(e.text)).join("\n"),
  };
  if (image) post.image = [image];
  return { "@context": "https://schema.org", "@graph": [post, breadcrumbs(title, url)] };
}

// トップ: WebSite + Blog (最近の便一覧)
function homeJsonLd({ title, desc, url, trips }) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        name: "分身の旅日記",
        alternateName: "bunshin-tabi",
        description: desc,
        url,
        inLanguage: "ja",
        publisher: PUBLISHER,
      },
      {
        "@type": "Blog",
        name: title,
        url,
        inLanguage: "ja",
        publisher: PUBLISHER,
        blogPost: trips.slice(0, 20).map((t) => ({
          "@type": "BlogPosting",
          headline: `分身の旅日記 — ${t.trip.line.name}`,
          url: SITE + t.url,
          datePublished: `${t.trip.date}T07:00:00+09:00`,
        })),
      },
    ],
  };
}

// ---- 静的本文 (検索エンジン / JS無効時向け) ----
// ビューアは JSON を fetch して JS で日記を描くため、そのままでは HTML に本文が無く
// インデックス対象がタイトルと description だけになる。同じ内容を HTML にも書き出す。
function articleBlock({ trip, title, url }, others) {
  const st = trip.stations || [];
  const p = trip.persona || {};
  const first = st.length ? st[0].name : "";
  const last = st.length ? st[st.length - 1].name : "";
  const L = [
    `<h1>${esc(title)}</h1>`,
    `<p class="seo-sub">${esc(trip.line.name)} (${esc(trip.line.company || "")}) ${esc(first)} → ${esc(last)}` +
      ` 約${esc(trip.line.km ?? "?")}km ／ ${esc(fmtDate(trip.date))}` +
      `${trip.weather ? " " + esc(trip.weather) : ""}${p.traits ? " ／ " + esc(p.traits) : ""}</p>`,
  ];
  for (const e of trip.diary || []) {
    const stName = st[e.st] ? st[e.st].name : "";
    L.push(
      `<section>` +
        `<h2><span class="seo-time">${esc(e.t || "")}</span>${esc(stName)}` +
        `<span class="seo-tag">${e.type === "stop" ? "途中下車" : "車窓から"}</span></h2>` +
        // 日記本文は自前で生成した HTML (スポットへのリンクを含む) なのでそのまま出す
        `<p>${e.text || ""}</p>` +
      `</section>`
    );
  }
  L.push(`<p>— この便はここまで。${esc(p.name || "分身")}はまた次の路線へ —</p>`);

  // 内部リンク (クローラの巡回経路)。自分自身は除いて新しい順に数件。
  const nav = others.filter((o) => o.url !== url).slice(0, 8);
  L.push(
    `<nav class="seo-nav"><h2>ほかの旅</h2><ul>` +
      `<li><a href="/">全国マップ (トップ)</a></li>` +
      nav
        .map((o) => `<li><a href="${esc(o.url)}">${esc(o.trip.date)} ${esc(o.trip.line.name)}</a></li>`)
        .join("") +
      `</ul></nav>`
  );
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
  const url = SITE + t.url;
  const html = injectArticle(
    injectMeta(
      template,
      metaBlock({ title, desc, url, image, type: "article", jsonLd: tripJsonLd({ trip, title, desc, url, image }) })
    ),
    articleBlock({ trip, title, url: t.url }, trips)
  );
  const outPath = join(DIST, t.htmlFile);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
}

// トップ (index.html) は website 種別で絶対URL化
const homeTitle = "分身の旅日記 — 日本全国の旅";
const homeDesc = "分身が日本の実在の鉄道を旅した記録。毎朝1本、新しい路線へ。";
writeFileSync(
  join(DIST, "index.html"),
  injectMeta(template, metaBlock({
    title: homeTitle,
    desc: homeDesc,
    url: SITE + "/",
    image: ogOk ? SITE + "/og/default.png" : null,
    type: "website",
    jsonLd: homeJsonLd({ title: homeTitle, desc: homeDesc, url: SITE + "/", trips }),
  }))
);

// ---- sitemap.xml / robots.txt ----
// 便ページは拡張子なしの URL (/trips/<date>, /l/<cd>) で配信されるので、canonical と揃える。
const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: SITE + "/", lastmod: trips.length ? trips[0].trip.date : today, changefreq: "daily", priority: "1.0" },
  ...trips.map((t) => ({ loc: SITE + t.url, lastmod: t.trip.date, changefreq: "monthly", priority: "0.8" })),
];
writeFileSync(
  join(DIST, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod>` +
          `<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`
      )
      .join("\n") +
    `\n</urlset>\n`
);
writeFileSync(
  join(DIST, "robots.txt"),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`
);

console.error(`dist/ を組み立てました → ${DIST}`);
console.error(`  便HTML: ${trips.length}件 / overview: ${overview.stats.trips}便 / OGP: ${ogOk ? "あり" : "なし"}`);
console.error(`  sitemap: ${urls.length}URL / robots.txt / JSON-LD・canonical・静的本文: あり`);
console.error(`  ビルドコマンド: node scripts/build-static.js / 出力: dist / SITE=${SITE}`);
