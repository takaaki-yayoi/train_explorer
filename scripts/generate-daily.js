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
import { loadTrip } from "../lib/trips-store.js";

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

// 路線選定: 環状線判定と、旅として成立しやすい規模 (5〜30駅程度) を優先
function pickLine() {
  if (explicitLine) return explicitLine;
  const candidates = listLines().filter((l) => l.stationCount >= 5 && l.stationCount <= 30);
  const pool = candidates.length ? candidates : listLines();
  // 日付シードで決定的に選ぶ (再現性)
  const seed = Number(date.replace(/-/g, "")) || 0;
  return pool[seed % pool.length].line_cd;
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
