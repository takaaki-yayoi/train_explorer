// 参照実装の3本 (reference/*.html) を trip JSON に変換してシードデータにする。
// これで LLM 生成やネットワークなしにビューアが即動く。
// 各 HTML は const stations / const track / const diary を持つので、その data ブロックだけを
// vm で評価して取り出す (地図描画コードは切り落とす)。メタ情報はヘッダ+設定表から。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { saveTrip } from "../lib/trips-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REF_DIR = join(HERE, "..", "reference");

// 参照ごとのメタ情報。日付は連載として並ぶよう 07-12 の直前に割り当てる。
const CONFIG = [
  {
    file: "bunshin_travel_diary.html",
    date: "2026-07-09",
    line: { line_cd: 11302, name: "JR山手線", company: "JR東日本", km: 34.5 },
    persona: { name: "タカ", emoji: "🎒", traits: "のんびり屋、食べ物と古い街並みに弱い" },
    weather: "晴れ",
  },
  {
    file: "bunshin_diary_02_meisho.html",
    date: "2026-07-10",
    line: { line_cd: 11513, name: "JR名松線", company: "JR東海", km: 43.5 },
    persona: { name: "タカ", emoji: "🎒", traits: "のんびり屋、食べ物と古い街並みに弱い" },
    weather: "晴れ",
  },
  {
    file: "bunshin_diary_03_kada.html",
    date: "2026-07-11",
    line: { line_cd: 32005, name: "南海加太線", company: "南海電鉄", km: 12.0 },
    persona: { name: "クロ", emoji: "🐈‍⬛", traits: "廃線と橋梁に目がない無口な猫" },
    weather: "晴れ",
  },
];

// HTML から stations/track/diary を評価して取り出す
function extractData(html) {
  const scriptStart = html.indexOf("const stations");
  if (scriptStart < 0) throw new Error("const stations が見つかりません");
  // 地図描画開始マーカーの手前まで
  const mapMarker = html.indexOf("// ===== 地図", scriptStart);
  // const 宣言は vm のコンテキスト global に紐づかないので var に変換して取り出す
  const block = html
    .slice(scriptStart, mapMarker > 0 ? mapMarker : undefined)
    .replace(/\bconst\b/g, "var");

  // wp/gs ヘルパを注入 (参照によっては未定義なので保険で必ず定義)
  const wp = (term, label) =>
    '<a href="https://ja.wikipedia.org/wiki/' +
    encodeURIComponent(term) +
    '" target="_blank" rel="noopener">' +
    (label || term) +
    "</a>";
  const gs = (query, label) =>
    '<a href="https://www.google.com/search?q=' +
    encodeURIComponent(query) +
    '" target="_blank" rel="noopener">' +
    label +
    "</a>";

  const sandbox = { wp, gs, stations: null, track: null, diary: null, encodeURIComponent };
  vm.createContext(sandbox);
  // block 内で wp/gs を再定義していても sandbox の値を上書きするだけで問題ない
  vm.runInContext(block, sandbox, { timeout: 3000 });
  const { stations, track, diary } = sandbox;
  if (!stations || !track || !diary) throw new Error("stations/track/diary の抽出に失敗");
  return { stations, track, diary };
}

let count = 0;
for (const cfg of CONFIG) {
  const html = readFileSync(join(REF_DIR, cfg.file), "utf8");
  const { stations, track, diary } = extractData(html);
  const trip = {
    date: cfg.date,
    line: cfg.line,
    persona: cfg.persona,
    weather: cfg.weather,
    stations: stations.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon })),
    track,
    diary,
    meta: { generated_at: cfg.date + "T00:00:00Z", source: "reference:" + cfg.file },
  };
  const path = saveTrip(trip);
  console.error(`✓ ${cfg.date}  ${cfg.line.name}  (${diary.length}件, ${track.length}頂点)  → ${path}`);
  count++;
}
console.error(`\n${count} 便をシードしました。`);
