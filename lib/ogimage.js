// OGP 画像 (1200×630 PNG) を生成する。SNS 共有時のカード画像。
// 路線の線形 + 路線名・区間・距離を焼き込む。resvg-wasm で SVG→PNG、日本語は Noto Sans JP。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let _inited = null;
let _font = null;
async function ensure() {
  if (!_inited) {
    _inited = initWasm(readFileSync(join(ROOT, "node_modules/@resvg/resvg-wasm/index_bg.wasm")));
    // 太字に固定した静的インスタンス (バリアブルフォントだと細く描画されるため)
    _font = readFileSync(join(ROOT, "assets/NotoSansJP-Bold.ttf"));
  }
  await _inited;
}

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// 経度経度の track を、指定 box に収まるよう射影する関数を返す
function projector(track, box) {
  const lats = track.map((p) => p[0]);
  const lons = track.map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const cosLat = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
  const spanX = Math.max((maxLon - minLon) * cosLat, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min(box.w / spanX, box.h / spanY) * 0.86;
  const midLon = (minLon + maxLon) / 2, midLat = (minLat + maxLat) / 2;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return (lat, lon) => [
    Math.round((cx + (lon - midLon) * cosLat * scale) * 10) / 10,
    Math.round((cy - (lat - midLat) * scale) * 10) / 10, // 北=上
  ];
}

/**
 * 1便のOGP用SVGを組み立てる。
 * @param {object} trip  trip JSON
 * @param {string} siteHost  カード下部に出すホスト名 (プロトコルなし)
 */
export function tripSvg(trip, siteHost = "train-explorer.noteigi.workers.dev") {
  const line = trip.line, stations = trip.stations || [], track = trip.track || [];
  const first = stations.length ? stations[0].name : "";
  const last = stations.length ? stations[stations.length - 1].name : "";
  const persona = trip.persona || {};

  const box = { x: 636, y: 150, w: 520, h: 410 };
  let route = "", dots = "";
  if (track.length >= 2) {
    const proj = projector(track, box);
    const pts = track.map(([la, lo]) => proj(la, lo).join(",")).join(" ");
    route =
      `<polyline points="${pts}" fill="none" stroke="#ffffff" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<polyline points="${pts}" fill="none" stroke="#6d28d9" stroke-width="7.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    dots = stations
      .map((s) => {
        const [x, y] = proj(s.lat, s.lon);
        return `<circle cx="${x}" cy="${y}" r="5" fill="#ffffff" stroke="#6d28d9" stroke-width="2.2"/>`;
      })
      .join("");
  }

  const name = line.name || "";
  const nameSize = name.length > 13 ? 44 : name.length > 9 ? 54 : 62;
  const sub = `${line.company || ""} ・ ${first} → ${last} ・ 約${line.km ?? "?"}km`;
  const who = `${persona.name ? "分身" + persona.name + "の旅日記" : "分身の旅日記"}`;

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
<rect width="1200" height="630" fill="#f4f2f0"/>
<rect width="1200" height="96" fill="#2c3a47"/>
<text x="60" y="62" font-family="Noto Sans JP" font-weight="700" font-size="40" fill="#ffffff">分身の旅日記</text>
${route}${dots}
<text x="60" y="${228}" font-family="Noto Sans JP" font-weight="700" font-size="${nameSize}" fill="#2c3a47">${esc(name)}</text>
<text x="60" y="300" font-family="Noto Sans JP" font-size="31" fill="#4a453d">${esc(sub)}</text>
<text x="60" y="362" font-family="Noto Sans JP" font-size="31" fill="#d6486a">${esc(who)}</text>
<text x="60" y="412" font-family="Noto Sans JP" font-size="27" fill="#6b6459">${esc(trip.date || "")}${trip.weather ? " ・ " + esc(trip.weather) : ""}</text>
<text x="60" y="596" font-family="Noto Sans JP" font-size="22" fill="#8f887c">${esc(siteHost)}</text>
</svg>`;
}

/**
 * トップ (全国マップ) 用のOGP SVG。
 * @param {{trips:number,lines:number,km:number}} stats
 */
export function homeSvg(stats = {}) {
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
<rect width="1200" height="630" fill="#2c3a47"/>
<text x="600" y="250" text-anchor="middle" font-family="Noto Sans JP" font-weight="700" font-size="76" fill="#ffffff">分身の旅日記</text>
<text x="600" y="330" text-anchor="middle" font-family="Noto Sans JP" font-weight="400" font-size="34" fill="#c9c2b6">分身が日本の鉄道を旅した記録。毎朝1本、新しい路線へ。</text>
<text x="600" y="440" text-anchor="middle" font-family="Noto Sans JP" font-weight="700" font-size="40" fill="#e8657c">${stats.trips || 0}便 ・ ${stats.lines || 0}路線 ・ 累計${Math.round(stats.km || 0)}km</text>
</svg>`;
}

/**
 * SVG を 1200×630 PNG (Buffer) にラスタライズする。
 * @param {string} svg
 * @returns {Promise<Buffer>}
 */
export async function renderPng(svg) {
  await ensure();
  const r = new Resvg(svg, {
    font: { fontBuffers: [_font], defaultFontFamily: "Noto Sans JP", loadSystemFonts: false },
    fitTo: { mode: "width", value: 1200 },
  });
  return Buffer.from(r.render().asPng());
}
