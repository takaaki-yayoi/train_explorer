// trip JSON の保存・読み込み・索引。v1 は DB 不要で JSON ファイルのみ。
// trips/<date>.json が各便。trips/index.json が新聞連載の一覧。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { simplifyTrack } from "./geo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIPS_DIR = join(HERE, "..", "trips");
// オンデマンド生成 (路線を指定して巡らせた便) は line_cd 単位で別保管。
// 新聞連載 (日付キー) を汚さず、同じ路線の再選択でキャッシュ再利用できる。
const LINES_DIR = join(TRIPS_DIR, "lines");

function ensureDir() {
  mkdirSync(TRIPS_DIR, { recursive: true });
}

/** trip を保存し、索引を更新する */
export function saveTrip(trip) {
  ensureDir();
  const path = join(TRIPS_DIR, `${trip.date}.json`);
  writeFileSync(path, JSON.stringify({ trip }, null, 0));
  rebuildIndex();
  return path;
}

/** date で trip を読み込む (なければ null) */
export function loadTrip(date) {
  const path = join(TRIPS_DIR, `${date}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8"));
  return data.trip || data;
}

/** 全 trip ファイルから索引を作り直す */
export function rebuildIndex() {
  ensureDir();
  const files = readdirSync(TRIPS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const entries = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(TRIPS_DIR, f), "utf8"));
      const t = data.trip || data;
      entries.push({
        date: t.date,
        line: t.line?.name,
        company: t.line?.company,
        km: t.line?.km,
        persona: t.persona ? { name: t.persona.name, emoji: t.persona.emoji } : null,
      });
    } catch {
      /* 壊れたファイルは索引から除外 */
    }
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : -1)); // 新しい順
  writeFileSync(join(TRIPS_DIR, "index.json"), JSON.stringify(entries, null, 0));
  return entries;
}

/** 索引を読む (なければ作る) */
export function loadIndex() {
  const path = join(TRIPS_DIR, "index.json");
  if (!existsSync(path)) return rebuildIndex();
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 最新の便の date を返す */
export function latestDate() {
  const idx = loadIndex();
  return idx.length ? idx[0].date : null;
}

// ---- オンデマンド (路線指定) の便 ----

/** 路線指定の便を line_cd 単位で保存する (新聞連載の索引には載せない) */
export function saveLineTrip(trip) {
  mkdirSync(LINES_DIR, { recursive: true });
  const path = join(LINES_DIR, `${trip.line.line_cd}.json`);
  writeFileSync(path, JSON.stringify({ trip }, null, 0));
  return path;
}

/** 路線指定の便を読み込む (なければ null) */
export function loadLineTrip(lineCd) {
  const path = join(LINES_DIR, `${lineCd}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8"));
  return data.trip || data;
}

// ---- 全国カバレッジ (トップの一覧マップ) 用の overview ----

// 全国地図に載せる用に線形を粗く間引く (国スケールなら数十点で十分)
function downsampleTrack(track) {
  if (!track || track.length <= 2) return track || [];
  let t = simplifyTrack(track, 0.0015, false);
  if (t.length > 60) {
    const stride = Math.ceil(t.length / 60);
    const out = t.filter((_, i) => i % stride === 0);
    if (out[out.length - 1] !== t[t.length - 1]) out.push(t[t.length - 1]);
    t = out;
  }
  return t.map(([la, lo]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5]);
}

// 日記の1件からHTMLを除いた一節を作る (トップの"味見"表示・全国マップの吹き出し用)
function teaserAt(diary, i) {
  if (!diary || !diary.length) return "";
  const e = diary[(i + diary.length) % diary.length];
  const plain = String(e.text || "").replace(/<[^>]+>/g, "").trim();
  return plain.length > 82 ? plain.slice(0, 82) + "…" : plain;
}

function overviewEntry(trip, url, kind) {
  return {
    date: trip.date,
    kind,
    url,
    line: {
      line_cd: trip.line.line_cd,
      name: trip.line.name,
      company: trip.line.company,
      km: trip.line.km,
    },
    persona: trip.persona ? { name: trip.persona.name, emoji: trip.persona.emoji } : null,
    // teaser = 出発の一節 (トップの味見表示と、全国マップで始点にいるときの吹き出し)
    // teaserEnd = 終着の一節 (全国マップで終点にいるときの吹き出し)
    teaser: teaserAt(trip.diary, 0),
    teaserEnd: teaserAt(trip.diary, -1),
    track: downsampleTrack(trip.track),
  };
}

/**
 * これまでの全便から、トップの全国マップ用データを作る。
 * 連載 (日付) の便 + オンデマンド (路線指定) の便を集約する。
 */
export function buildOverview() {
  const entries = [];
  for (const it of loadIndex()) {
    const trip = loadTrip(it.date);
    if (trip && trip.track) entries.push(overviewEntry(trip, `/trips/${trip.date}`, "daily"));
  }
  if (existsSync(LINES_DIR)) {
    for (const f of readdirSync(LINES_DIR)) {
      if (!/\.json$/.test(f)) continue;
      try {
        const data = JSON.parse(readFileSync(join(LINES_DIR, f), "utf8"));
        const trip = data.trip || data;
        if (trip && trip.track) entries.push(overviewEntry(trip, `/l/${trip.line.line_cd}`, "line"));
      } catch {
        /* 壊れたファイルは無視 */
      }
    }
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // 路線数・累計kmは line_cd で重複排除
  const kmByLine = new Map();
  for (const e of entries) if (!kmByLine.has(e.line.line_cd)) kmByLine.set(e.line.line_cd, e.line.km || 0);
  let km = 0;
  for (const v of kmByLine.values()) km += v || 0;

  return {
    generated_at: new Date().toISOString(),
    stats: { trips: entries.length, lines: kmByLine.size, km: Math.round(km * 10) / 10 },
    trips: entries,
  };
}

/**
 * 全便 (連載 + オンデマンド) をフル JSON で列挙する。OGP画像・各便HTML生成に使う。
 * @returns {{trip:object, url:string, kind:string, ogPath:string, htmlFile:string}[]}
 */
export function allTrips() {
  const out = [];
  for (const it of loadIndex()) {
    const trip = loadTrip(it.date);
    if (trip) out.push({ trip, url: `/trips/${trip.date}`, kind: "daily", ogPath: `/og/trips/${trip.date}.png`, htmlFile: `trips/${trip.date}.html` });
  }
  if (existsSync(LINES_DIR)) {
    for (const f of readdirSync(LINES_DIR)) {
      if (!/\.json$/.test(f)) continue;
      try {
        const data = JSON.parse(readFileSync(join(LINES_DIR, f), "utf8"));
        const trip = data.trip || data;
        const cd = trip.line.line_cd;
        out.push({ trip, url: `/l/${cd}`, kind: "line", ogPath: `/og/l/${cd}.png`, htmlFile: `l/${cd}.html` });
      } catch {
        /* 壊れたファイルは無視 */
      }
    }
  }
  return out;
}

export { TRIPS_DIR, LINES_DIR };
