// 指定路線の線形を Overpass から取得してキャッシュする。
// line_cd 単位で一度取れば全便で共有できる (610路線のみ)。
// 使い方:
//   node scripts/fetch-track.js 32005            加太線を取得
//   node scripts/fetch-track.js 11302 --loop     山手線 (環状線)
//   node scripts/fetch-track.js 11513 --refresh  キャッシュ無視で再取得

import { getLine } from "../lib/stations.js";
import { getOrBuildTrack } from "../lib/track.js";

const lineCd = Number(process.argv[2]);
const loop = process.argv.includes("--loop");
const refresh = process.argv.includes("--refresh");

if (!lineCd) {
  console.error("使い方: node scripts/fetch-track.js <line_cd> [--loop] [--refresh]");
  process.exit(1);
}

const line = getLine(lineCd);
if (!line) {
  console.error(`line_cd ${lineCd} が見つかりません`);
  process.exit(1);
}

console.error(`取得中: ${line.line.name} (${line.line.company}) ${line.stations.length}駅 ...`);

const result = await getOrBuildTrack(line.line, line.stations, { loop, refresh });

console.error(
  [
    `路線: ${result.name}`,
    `取得元: ${result.via}${result.cached ? " (キャッシュ)" : ""}`,
    `頂点数: ${result.track.length}`,
    `総延長: ${result.km}km`,
    `検証: ${result.validation.ok ? "OK" : "要確認"} (駅最大距離 ${result.validation.maxStationDist}m)`,
    result.validation.issues?.length ? `  課題: ${result.validation.issues.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
);
