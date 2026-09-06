// 夜間バッチ: 翌朝の便を生成する。
// 路線をランダム選定 (線形取得に成功しやすいよう駅数などでフィルタ) + キャラをローテーション。
// 使い方:
//   node scripts/generate-daily.js                翌日分を生成
//   node scripts/generate-daily.js --date 2026-07-13
//   node scripts/generate-daily.js --line 32005   路線を指定
//
// cron 例 (毎晩3時に翌日分):  0 3 * * *  cd /path && node scripts/generate-daily.js

import { listLines, getLine } from "../lib/stations.js";
import { getOrBuildTrack } from "../lib/track.js";
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
// 線形が取れない路線に当たることがあるので、候補は順番付きで返し、順に試す。
function pickLineCandidates(limit = 6) {
  if (explicitLine) return [explicitLine];
  const candidates = listLines().filter((l) => l.stationCount >= 5 && l.stationCount <= 30);
  const pool = candidates.length ? candidates : listLines();
  const visited = visitedLines();
  const start = hashDate(date) % pool.length;
  const fresh = [];
  const seen = [];
  for (let n = 0; n < pool.length && fresh.length < limit; n++) {
    const l = pool[(start + n) % pool.length];
    (visited.has(l.line_cd) ? seen : fresh).push(l.line_cd);
  }
  if (!fresh.length) {
    console.error(`候補 ${pool.length}本をすべて旅し終えました。2巡目に入ります。`);
    return seen.slice(0, limit);
  }
  return fresh;
}

// 環状線の簡易判定: 始点と終点が近い
function detectLoop(stations) {
  const first = stations[0];
  const last = stations[stations.length - 1];
  return Math.hypot(first.lat - last.lat, first.lon - last.lon) < 0.01 && stations.length > 5;
}

// 線形が駅からこれ以上ずれていたら、地図がまるで別の路線になる。
// 2026-09-05 の広電３号線は、軌道線を拾えず近くの JR の線路を描いてしまい
// 駅から最大1.5km ずれていた。そういう便は出さずに次の候補へ回す。
const MAX_STATION_DIST_M = 300;

// 候補を順に試し、線形がまともに引けた最初の路線を返す。
// (線形は line_cd 単位でキャッシュされるので、ここで引いた分は本生成でそのまま使われる)
async function pickTravelableLine() {
  const candidates = pickLineCandidates();
  let fallback = null;
  for (const lineCd of candidates) {
    const line = getLine(lineCd);
    if (!line) continue;
    const loop = detectLoop(line.stations);
    try {
      const track = await getOrBuildTrack(line.line, line.stations, { loop });
      const v = track.validation || {};
      if (v.ok || (v.monotonic && v.maxStationDist <= MAX_STATION_DIST_M)) {
        return { lineCd, line, loop };
      }
      console.error(
        `線形が怪しいので見送り: ${line.line.name} (駅最大距離 ${v.maxStationDist}m${v.monotonic ? "" : " / 弧長逆行"})`
      );
      fallback = fallback || { lineCd, line, loop };
    } catch (e) {
      console.error(`線形を取得できず見送り: ${line.line.name} (${e.message})`);
    }
  }
  if (fallback) {
    console.error("どの候補も線形が怪しいため、いちばん先の候補で作ります。");
    return fallback;
  }
  throw new Error("線形を取得できる路線が候補にありませんでした");
}

const { lineCd, line, loop } = await pickTravelableLine();

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
