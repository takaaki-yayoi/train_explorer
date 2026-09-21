// 既存の便の日記だけを書き直す。路線・駅・線形・分身・天気は据え置き、
// 沿線素材 (Wikipedia) を集め直して LLM に日記を書かせ直す。
// generate-daily.js --force は路線の選定からやり直すので、過去の便に使うと
// 同じ日付のまま別の路線の便になってしまう。素材集めやモデルを改善したあとで
// 過去の便に反映したいときはこちらを使う。
// 使い方:
//   node scripts/regenerate-diaries.js --from 2026-08-01 --to 2026-09-20
//   node scripts/regenerate-diaries.js --date 2026-09-12
//   node scripts/regenerate-diaries.js --from 2026-08-01 --redo   (書き直し済みの便もやり直す)
//   node scripts/regenerate-diaries.js --lines                    (路線指定の便 trips/lines/ も対象に含める)
//
// 書き直した便には meta.regenerated_at を付け、次回は飛ばす (途中で落ちても続きから再開できる)。
// 1便ごとに保存する。LLM の API キーが必要 (generate-trip.js と同じ)。

import { readdirSync } from "node:fs";
import { collectSpots } from "../lib/spots.js";
import { generateDiary, hasApiKey, apiKeyEnvName } from "../lib/diary.js";
import { PERSONAS } from "../lib/personas.js";
import { loadTrip, saveTrip, loadLineTrip, saveLineTrip, TRIPS_DIR, LINES_DIR } from "../lib/trips-store.js";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const from = arg("date") || arg("from") || "0000-00-00";
const to = arg("date") || arg("to") || "9999-99-99";
const redo = has("redo");

if (!hasApiKey()) {
  console.error(`${apiKeyEnvName()} が未設定です`);
  process.exit(1);
}

// 対象: 期間内の連載の便 (+ --lines なら路線指定の便)
const targets = [];
for (const f of readdirSync(TRIPS_DIR).sort()) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (m && m[1] >= from && m[1] <= to) targets.push({ label: m[1], load: () => loadTrip(m[1]), save: saveTrip });
}
if (has("lines")) {
  for (const f of readdirSync(LINES_DIR).sort()) {
    const m = f.match(/^(\d+)\.json$/);
    if (m) targets.push({ label: `lines/${m[1]}`, load: () => loadLineTrip(Number(m[1])), save: saveLineTrip });
  }
}

let done = 0;
let skipped = 0;
let failed = 0;
for (const target of targets) {
  const trip = target.load();
  const tag = `${target.label} ${trip && trip.line ? trip.line.name : ""}`;
  // LLM で作っていない便 (手書きのサンプルなど) には触らない
  if (!trip || !trip.meta || !trip.meta.model) {
    console.error(`- ${tag}: LLM 生成の便ではないので飛ばす`);
    skipped++;
    continue;
  }
  if (trip.meta.regenerated_at && !redo) {
    console.error(`- ${tag}: 書き直し済み (${trip.meta.model})。飛ばす`);
    skipped++;
    continue;
  }
  // trip には分身の名前しか残っていないので、文体と興味は定義から引く
  const persona = PERSONAS.find((p) => p.name === trip.persona.name);
  if (!persona) {
    console.error(`- ${tag}: 分身「${trip.persona.name}」の定義が無いので飛ばす`);
    skipped++;
    continue;
  }

  try {
    console.error(`* ${tag} / ${persona.name} ${persona.emoji}: 沿線を調べています…`);
    const spots = await collectSpots(trip.line, trip.stations);
    const ctx = { line: trip.line, persona, stations: trip.stations, spots, date: trip.date, weather: trip.weather };
    const gen = await generateDiary(ctx);
    if (gen.incomplete) {
      // 終点まで書けなかった日記で、完走している元の日記を潰さない
      console.error(`  ! 終点まで書けなかったので元の日記を残す (${gen.diary.length}エントリ)`);
      failed++;
      continue;
    }
    trip.diary = gen.diary;
    trip.meta = { ...trip.meta, model: gen.model, regenerated_at: new Date().toISOString() };
    target.save(trip);
    done++;
    console.error(`  ✓ ${gen.diary.length}エントリ / model ${gen.model}`);
  } catch (e) {
    console.error(`  ! 失敗したので元の日記を残す: ${e.message}`);
    failed++;
  }
}

console.error(`\n書き直し ${done}便 / 見送り ${skipped}便 / 失敗 ${failed}便`);
if (failed) process.exit(1);
