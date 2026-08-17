// 有効な路線一覧を表示する。旅の対象路線を確認・選定するための補助。
// 使い方:
//   node scripts/list-lines.js            全件
//   node scripts/list-lines.js 加太        名前で絞り込み
//   node scripts/list-lines.js --random    ランダムに1件

import { listLines } from "../lib/stations.js";

const arg = process.argv[2];
const lines = listLines();

if (arg === "--random") {
  const l = lines[Math.floor(Math.random() * lines.length)];
  console.log(`${l.line_cd}\t${l.name} (${l.company}) ${l.stationCount}駅`);
} else {
  const filtered = arg ? lines.filter((l) => l.name.includes(arg) || l.company.includes(arg)) : lines;
  for (const l of filtered) {
    console.log(`${l.line_cd}\t${l.name} (${l.company}) ${l.stationCount}駅`);
  }
  console.error(`\n${filtered.length} / ${lines.length} 路線`);
}
