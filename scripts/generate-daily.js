// 夜間バッチ: 翌朝の便を生成する。
// 路線をランダム選定 (線形取得に成功しやすいよう駅数などでフィルタ) + キャラをローテーション。
// 使い方:
//   node scripts/generate-daily.js                翌日分を生成
//   node scripts/generate-daily.js --date 2026-07-13
//   node scripts/generate-daily.js --line 32005   路線を指定
//
// cron 例 (毎晩3時に翌日分):  0 3 * * *  cd /path && node scripts/generate-daily.js

import { listLines, getLine } from "../lib/stations.js";
import { pickPersonaForDate } from "../lib/personas.js";
import { generateTrip } from "./generate-trip.js";
import { loadTrip, allTrips } from "../lib/trips-store.js";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

// 対象日: 既定は「翌日」(夜間に翌朝の便を用意する)
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const date = arg("date") || tomorrow();
const explicitLine = arg("line") ? Number(arg("line")) : null;

// 既に生成済みなら何もしない (冪等)。--force で上書き再生成。
const force = process.argv.includes("--force");
if (!force && loadTrip(date)) {
  console.error(`${date} の便は既に存在します。スキップ (上書きするなら --force)。`);
  process.exit(0);
}

// 日付から候補列のどこを見に行くかを決める。
// 素の日付 (20260819) をそのまま剰余すると、1日進む = インデックスが1つ進む になる。
// 候補列は line_cd 昇順 = 事業者・地域ごとの固まりなので、これだと同じ地方が延々と続く
// (実測: 30日で3地方しか回らず、近畿が13日連続)。
// FNVハッシュを通すだけでも足りない。最後の掛け算の 16777619 % 候補数 がそのまま歩幅になり、
// 1日進む = 2つ進む に変わるだけ。murmur3 の最終撹拌まで入れて初めて日付が散る。
function hashDate(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

// これまでに旅した路線 (連載の便 + 路線指定の便)
function visitedLines() {
  const set = new Set();
  for (const { trip } of allTrips()) {
    const cd = trip && trip.line && trip.line.line_cd;
    if (cd) set.add(Number(cd));
  }
  return set;
}

// 路線選定: 旅として成立しやすい規模 (5〜30駅程度) の中から、日付シードで決定的に選ぶ。
// 未踏の路線を優先する (撹拌だけだと1年で134回も既訪問路線に当たる)。
function pickLine() {
  if (explicitLine) return explicitLine;
  const candidates = listLines().filter((l) => l.stationCount >= 5 && l.stationCount <= 30);
  const pool = candidates.length ? candidates : listLines();
  const visited = visitedLines();
  const start = hashDate(date) % pool.length;
  for (let n = 0; n < pool.length; n++) {
    const l = pool[(start + n) % pool.length];
    if (!visited.has(l.line_cd)) {
      if (n) console.error(`未踏優先: ${n}本ずらしました (${n}本が訪問済み)`);
      return l.line_cd;
    }
  }
  console.error(`候補 ${pool.length}本をすべて旅し終えました。2巡目に入ります。`);
  return pool[start].line_cd;
}

const lineCd = pickLine();
const line = getLine(lineCd);
// 環状線の簡易判定: 始点と終点が近い
const first = line.stations[0];
const last = line.stations[line.stations.length - 1];
const loop =
  Math.hypot(first.lat - last.lat, first.lon - last.lon) < 0.01 && line.stations.length > 5;

const persona = pickPersonaForDate(date);
console.error(`=== 夜間バッチ: ${date} の便 ===`);
console.error(`路線: ${line.line.name} (${line.line.company}) / 分身: ${persona.name} ${persona.emoji}${loop ? " / 環状線" : ""}`);

try {
  await generateTrip({ lineCd, date, loop });
  console.error(`\n翌朝の便を用意しました: /trips/${date}`);
} catch (e) {
  console.error(`生成に失敗: ${e.message}`);
  process.exit(1);
}
