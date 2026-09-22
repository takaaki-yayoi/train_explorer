// OpenStreetMap から駅周辺の名前付き地物 (POI) を集める。
// Wikipedia の駅記事は「駅周辺」が銀行と学校の羅列だったり、記事自体が無い駅もある。
// OSM には Wikipedia に記事の無い小さな橋・川・寺社・史跡・灯台などが名前付きで入っているので、
// それを素材として足す。分身の興味 (橋梁・河川・寺社・食・海岸) に沿うタグだけ拾う。
//
// 路線の全駅を1回の Overpass クエリでまとめて引く (駅ごとに叩くと Actions からは待たされる)。
// OSM のタグはリンク先にならないので、これらの語には検索リンクを使う。

import { queryOverpass } from "./track.js";

// 駅からこの半径 (m) の中を探す。史跡・自然・橋などは少し遠くても素材になるが、
// 店や公園は駅前のものだけでよい (遠いと「途中下車して寄った」が嘘っぽくなる)。
const RADIUS_M = 1200;
const NEAR_ONLY_M = 600;
const NEAR_ONLY_KINDS = new Set(["公園", "食事処", "店", "菓子屋", "パン屋", "酒屋", "魚屋", "寺", "神社", "宗教施設"]);

// 拾うタグ。旅の素材になる種類だけ。
// (店・住宅・公共機関・道路は除く。それは Wikipedia の駅周辺で足りる)
const SELECTORS = [
  '["historic"]',
  '["tourism"~"^(attraction|viewpoint|museum|artwork|gallery|aquarium|zoo|theme_park)$"]',
  '["amenity"~"^(place_of_worship|marketplace)$"]',
  '["natural"~"^(peak|beach|cape|spring|hot_spring|cliff|volcano|bay|strait|wetland|waterfall)$"]',
  '["waterway"~"^(river|stream|canal|dam|weir)$"]',
  '["bridge"="yes"]["railway"~"rail|tram|light_rail|narrow_gauge"]',
  '["bridge"="yes"]["highway"]',
  '["bridge:movable"]',
  '["man_made"~"^(lighthouse|bridge|tower|windmill|pier|breakwater|kiln|water_tower)$"]',
  '["railway"~"^(abandoned|disused|preserved|turntable|roundhouse)$"]',
  '["leisure"~"^(park|garden|nature_reserve)$"]',
  '["landuse"~"^(vineyard|orchard|salt_pond)$"]',
  '["harbour"="yes"]',
  '["shop"~"^(seafood|confectionery|bakery|tea|sake|wine|alcohol|dairy|pastry|farm)$"]',
  '["craft"~"^(brewery|sake_brewery|winery|distillery|pottery|sawmill|blacksmith)$"]',
  '["amenity"~"^(restaurant|cafe|food_court)$"]["cuisine"]',
];

// 種類の日本語ラベル。日記のモデルには「何であるか」だけ分かればよい。
const KIND_LABELS = [
  [/^railway=(abandoned|disused)/, "廃線跡"],
  [/^railway=preserved/, "保存鉄道"],
  [/^railway=(turntable|roundhouse)/, "転車台/機関庫"],
  [/^bridge:movable=/, "可動橋"],
  [/^bridge=yes\|railway=/, "鉄道橋"],
  [/^bridge=yes/, "橋"],
  [/^historic=(castle|castle_site|fort)/, "城跡"],
  [/^historic=(archaeological_site|ruins)/, "遺跡"],
  [/^historic=(monument|memorial)/, "記念碑"],
  [/^historic=shrine/, "祠"],
  [/^historic=/, "史跡"],
  [/^amenity=place_of_worship\|religion=shinto/, "神社"],
  [/^amenity=place_of_worship\|religion=buddhist/, "寺"],
  [/^amenity=place_of_worship/, "宗教施設"],
  [/^amenity=marketplace/, "市場"],
  [/^tourism=museum/, "博物館"],
  [/^tourism=viewpoint/, "展望地"],
  [/^tourism=aquarium/, "水族館"],
  [/^tourism=/, "観光地"],
  [/^natural=peak/, "山"],
  [/^natural=beach/, "浜"],
  [/^natural=cape/, "岬"],
  [/^natural=(spring|hot_spring)/, "湧水/温泉"],
  [/^natural=waterfall/, "滝"],
  [/^natural=/, "自然"],
  [/^waterway=(river|stream)/, "川"],
  [/^waterway=canal/, "水路"],
  [/^waterway=(dam|weir)/, "堰"],
  [/^man_made=lighthouse/, "灯台"],
  [/^man_made=bridge/, "橋"],
  [/^man_made=(pier|breakwater)/, "港"],
  [/^man_made=kiln/, "窯"],
  [/^man_made=/, "構造物"],
  [/^harbour=/, "港"],
  [/^leisure=nature_reserve/, "自然保護区"],
  [/^leisure=/, "公園"],
  [/^landuse=vineyard/, "ぶどう畑"],
  [/^landuse=orchard/, "果樹園"],
  [/^landuse=salt_pond/, "塩田"],
  [/^craft=(brewery|sake_brewery)/, "酒蔵"],
  [/^craft=winery/, "ワイナリー"],
  [/^craft=/, "工房"],
  [/^shop=seafood/, "魚屋"],
  [/^shop=(confectionery|pastry)/, "菓子屋"],
  [/^shop=bakery/, "パン屋"],
  [/^shop=(sake|alcohol|wine)/, "酒屋"],
  [/^shop=/, "店"],
  [/^amenity=(restaurant|cafe|food_court)/, "食事処"],
];

// 名前で除外するもの (駐車場・トイレ・番号だけの小公園など素材にならない名前)
const NAME_NOISE =
  /駐車場|トイレ|便所|自動販売機|ATM|コインランドリー|バス停|停留所|の跡地$|[0-9０-９一二三四五六七八九十]+号(公園|緑地)|児童公園|第[0-9０-９]+公園|水準点|三角点|スタンプ|社務所|^[A-Za-z0-9 .\-]+$/;

// 橋は道路や路線の名前 (「国道8号」「福光福岡線」) がそのまま付いていることが多い。橋の名前だけ残す。
const BRIDGE_NAME = /(橋|ブリッジ|架道橋|高架橋|陸橋)[)）]?$/;

/** OSM の name は "Shirotori Shrine 白鳥神社" のように英語が前置きされていることがある。日本語部分だけにする。 */
function japaneseName(tags) {
  const raw = (tags["name:ja"] || tags.name || "").trim();
  const m = raw.match(/[\u3000-\u30ff\u4e00-\u9fff\uff10-\uff5e][^]*$/);
  return m ? m[0].trim() : raw;
}

/** 2点間の距離 (m)。 */
function distM(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6371000;
}

/** 地物の種類ラベル。 */
function kindOf(tags) {
  const key = ["bridge:movable", "bridge", "railway", "historic", "amenity", "tourism", "natural", "waterway", "man_made", "harbour", "leisure", "landuse", "craft", "shop"]
    .filter((k) => tags[k])
    .map((k) => `${k}=${tags[k]}`)
    .join("|");
  const probe = key + (tags.religion ? `|religion=${tags.religion}` : "");
  for (const [re, label] of KIND_LABELS) if (re.test(probe)) return label;
  return null;
}

/**
 * 路線の全駅について、周辺 POI を1回のクエリで集める。
 * @param {{name:string, lat:number, lon:number}[]} stations
 * @returns {Promise<{name:string, kind:string, m:number, note?:string}[][]>}  駅ごとの POI (近い順)
 */
export async function collectPois(stations) {
  const withCoord = stations.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!withCoord.length) return stations.map(() => []);

  // around に複数座標を渡すと「いずれかの点から半径内」になるので、全駅を1クエリで引ける。
  // nwr で node/way/relation をまとめて拾い、center で代表点をもらう。
  const coordList = withCoord.map((s) => `${s.lat},${s.lon}`).join(",");
  const body = SELECTORS.map((sel) => `nwr${sel}["name"](around:${RADIUS_M},${coordList});`).join("\n");
  const ql = `[out:json][timeout:90];\n(\n${body}\n);\nout tags center 800;`;

  let json;
  try {
    json = await queryOverpass(ql);
  } catch (e) {
    // 素材が無くても日記は書ける。ここで落として便を作れなくするより、Wikipedia だけで進める
    console.error(`OSM POI の取得に失敗 (Wikipedia の素材だけで進めます): ${e.message}`);
    return stations.map(() => []);
  }

  // 地物ごとに代表点を出し、いちばん近い駅に割り当てる (同じ川が5駅に出てくるのを避ける)
  const perStation = stations.map(() => []);
  const seen = new Set();
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const name = japaneseName(tags);
    if (!name || NAME_NOISE.test(name)) continue;
    // チェーン店は土地の素材にならない
    if (tags.brand || tags["brand:wikidata"]) continue;
    const kind = kindOf(tags);
    if (!kind) continue;
    if (/橋$/.test(kind) && !BRIDGE_NAME.test(name)) continue;
    const pt = el.type === "node" ? { lat: el.lat, lon: el.lon } : el.center;
    if (!pt) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    let bestIdx = -1;
    let bestD = Infinity;
    stations.forEach((s, i) => {
      if (!Number.isFinite(s.lat)) return;
      const d = distM(s, pt);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    });
    if (bestIdx < 0 || bestD > RADIUS_M) continue;
    if (NEAR_ONLY_KINDS.has(kind) && bestD > NEAR_ONLY_M) continue;
    // 駅名と同じ名前の地物 (駅前広場など) は素材にならない
    if (name.includes(stations[bestIdx].name) && /駅/.test(name)) continue;

    const poi = { name, kind, m: Math.round(bestD / 10) * 10 };
    const note = tags.description || tags.inscription || tags["cuisine"] || tags["start_date"];
    if (note) poi.note = String(note).slice(0, 60);
    perStation[bestIdx].push(poi);
  }

  // 近い順に並べ、種類が偏らないように (同じ種類は3件まで) 絞る
  return perStation.map((list) => {
    list.sort((a, b) => a.m - b.m);
    const perKind = new Map();
    const out = [];
    for (const p of list) {
      const n = perKind.get(p.kind) || 0;
      if (n >= 3) continue;
      perKind.set(p.kind, n + 1);
      out.push(p);
      if (out.length >= 12) break;
    }
    return out;
  });
}
