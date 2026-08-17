// trip JSON の保存・読み込み・索引。v1 は DB 不要で JSON ファイルのみ。
// trips/<date>.json が各便。trips/index.json が新聞連載の一覧。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

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

export { TRIPS_DIR, LINES_DIR };
