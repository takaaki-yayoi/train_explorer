// 1便を生成する: 路線選定 → 線形取得/キャッシュ → スポット収集 → LLM生成 → trip JSON保存。
// CLI としても、サーバ (オンデマンド生成) からのモジュールとしても使える。
// 使い方 (CLI):
//   node scripts/generate-trip.js --line 32005 --date 2026-07-13 --persona kuro
//   node scripts/generate-trip.js --line 11513 --loop           (環状線指定)
//   node scripts/generate-trip.js --line 32005 --dry            (LLM前まで/保存しない)
//
// LLM の API キーが必要 (--dry のときは不要)。既定は OPENAI_API_KEY。
// LLM_PROVIDER=anthropic にすると ANTHROPIC_API_KEY を使う。

import { fileURLToPath } from "node:url";
import { getLine } from "../lib/stations.js";
import { getOrBuildTrack } from "../lib/track.js";
import { collectSpots } from "../lib/spots.js";
import { generateDiary } from "../lib/diary.js";
import { pickPersonaForDate, getPersona } from "../lib/personas.js";
import { saveTrip, saveLineTrip } from "../lib/trips-store.js";

/**
 * 始点と終点が近ければ環状線とみなす (山手線など)。
 */
export function detectLoop(stations) {
  if (stations.length <= 5) return false;
  const a = stations[0], b = stations[stations.length - 1];
  return Math.hypot(a.lat - b.lat, a.lon - b.lon) < 0.01;
}

/**
 * 1便を生成する。
 * @param {object} p
 * @param {number} p.lineCd
 * @param {string} [p.date]        既定は今日
 * @param {string} [p.personaId]   未指定なら日付でローテーション
 * @param {boolean} [p.loop]       未指定なら駅配置から自動判定
 * @param {boolean} [p.dry]        LLM 生成をスキップ (素材だけ返す)
 * @param {string} [p.weather]
 * @param {'daily'|'line'|null} [p.store]  保存先。'daily'=連載, 'line'=路線指定, null=保存しない
 * @param {(stage:string, msg:string)=>void} [p.onProgress]  進捗コールバック
 */
export async function generateTrip({
  lineCd,
  date = new Date().toISOString().slice(0, 10),
  personaId,
  loop,
  dry = false,
  weather = "晴れ",
  store = "daily",
  onProgress = () => {},
}) {
  const line = getLine(lineCd);
  if (!line) throw new Error(`line_cd ${lineCd} が見つかりません`);
  if (loop === undefined) loop = detectLoop(line.stations);

  const persona = personaId ? getPersona(personaId) : pickPersonaForDate(date);

  onProgress("track", `線形を取得中… (${line.line.name})`);
  const track = await getOrBuildTrack(line.line, line.stations, { loop });
  line.line.km = track.km;
  onProgress(
    "track_done",
    `${track.track.length}頂点 / ${track.km}km / 検証 ${track.validation.ok ? "OK" : "要確認"}`
  );

  onProgress("spots", "沿線を調べています… (Wikipedia)");
  const spots = await collectSpots(line.line, line.stations);
  const withInfo = spots.stationSpots.filter((s) => s.info).length;
  onProgress("spots_done", `路線記事 ${spots.lineInfo ? "あり" : "なし"} / 駅記事 ${withInfo}/${line.stations.length}`);

  const ctx = { line: line.line, persona, stations: line.stations, spots, date, weather };

  if (dry) {
    onProgress("dry", "LLM生成をスキップ");
    return { line: line.line, persona, stations: line.stations, spots, dry: true };
  }

  onProgress("diary", `${persona.name} ${persona.emoji} が日記を書いています…`);
  const gen = await generateDiary(ctx);
  onProgress("diary_done", `${gen.diary.length}エントリ / model ${gen.model}`);

  const trip = {
    date,
    line: {
      line_cd: line.line.line_cd,
      name: line.line.name,
      company: line.line.company,
      km: track.km,
    },
    persona: { name: persona.name, emoji: persona.emoji, traits: persona.traits },
    weather,
    stations: line.stations.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon })),
    track: track.track,
    diary: gen.diary,
    meta: {
      generated_at: new Date().toISOString(),
      model: gen.model,
      track_via: track.via,
      on_demand: store === "line",
    },
  };

  let path = null;
  if (store === "daily") path = saveTrip(trip);
  else if (store === "line") path = saveLineTrip(trip);
  if (path) onProgress("saved", path);

  return { trip, path };
}

// ---- CLI 実行時のみ ----
function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const arg = (name, def = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : def;
  };
  const has = (name) => process.argv.includes(`--${name}`);

  const lineCd = Number(arg("line"));
  if (!lineCd) {
    console.error("使い方: node scripts/generate-trip.js --line <line_cd> [--date YYYY-MM-DD] [--persona id] [--loop] [--dry]");
    process.exit(1);
  }
  const result = await generateTrip({
    lineCd,
    date: arg("date") || undefined,
    personaId: arg("persona"),
    loop: has("loop") ? true : undefined,
    dry: has("dry"),
    weather: arg("weather", "晴れ"),
    onProgress: (stage, msg) => console.error(`[${stage}] ${msg}`),
  });
  if (result?.dry) {
    console.log(JSON.stringify({ line: result.line, persona: result.persona, spots: result.spots }, null, 2));
  } else {
    console.error(`\n完成: /trips/${result.trip.date}  (${result.trip.line.name} / ${result.trip.persona.name})`);
  }
}
