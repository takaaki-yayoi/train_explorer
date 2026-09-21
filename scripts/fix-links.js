// 既存の便の日記にある Wikipedia リンクを検証し、記事が存在しないものを Google 検索リンクに差し替える。
// LLM は呼ばない (API キー不要)。新しく作る便は生成時に同じ検証を通るので、これは過去の便の手当て用。
// 使い方:
//   node scripts/fix-links.js            全便
//   node scripts/fix-links.js --check    書き換えずに報告だけ

import { readdirSync } from "node:fs";
import { verifyWikiLinks } from "../lib/diary.js";
import { loadTrip, saveTrip, loadLineTrip, saveLineTrip, TRIPS_DIR, LINES_DIR } from "../lib/trips-store.js";

const checkOnly = process.argv.includes("--check");

const targets = [];
for (const f of readdirSync(TRIPS_DIR).sort()) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (m) targets.push({ label: m[1], load: () => loadTrip(m[1]), save: saveTrip });
}
for (const f of readdirSync(LINES_DIR).sort()) {
  const m = f.match(/^(\d+)\.json$/);
  if (m) targets.push({ label: `lines/${m[1]}`, load: () => loadLineTrip(Number(m[1])), save: saveLineTrip });
}

let total = 0;
for (const target of targets) {
  const trip = target.load();
  if (!trip || !Array.isArray(trip.diary)) continue;
  const replaced = await verifyWikiLinks(trip.diary);
  if (!replaced.length) continue;
  total += replaced.length;
  console.error(`${target.label} ${trip.line.name}: ${replaced.join("、")}`);
  if (!checkOnly) target.save(trip);
}
console.error(`\n存在しない記事へのリンク ${total}件${checkOnly ? "" : " を検索リンクに差し替えました"}`);
