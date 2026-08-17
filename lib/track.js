// OpenStreetMap Overpass API から路線の実線形を取得するパイプライン。
// SPEC「線形取得パイプライン (実証済み)」を実装:
//   1. relation["route"="train"] → 無ければ way["railway"="rail"] を name 部分一致で
//   2. way 群の全頂点をノードとするグラフを構築し、起点駅〜終点駅間をダイクストラ探索
//      (共用区間・複線・環状線に強い。孤立断片対策に最大連結成分を使う)
//   3. Douglas-Peucker で間引き (環状線は2分割)
//   4. 検証: 弧長単調増加 / 駅と線形の距離 / 総延長
//   5. 線形が駅手前で終わる場合は駅座標まで延長
//
// line_cd 単位でキャッシュ (cache/tracks/<line_cd>.json) すれば全便で共有できる。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  haversine,
  cumulative,
  simplifyTrack,
  projectStation,
  trackLengthKm,
} from "./geo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, "..", "cache", "tracks");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Overpass にクエリを投げる。ミラーを順に試し、レート制限(429)や XML エラーページに耐える。
 * Overpass は正常時 JSON、エラー時 XML を返すので Content 判定を必ず行う。
 * @param {string} ql  Overpass QL (out:json 前提)
 * @returns {Promise<object>} 解析済み JSON
 */
export async function queryOverpass(ql) {
  let lastErr;
  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length * 2; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "bunshin-tabi-nikki/1.0 (train diary; contact via project)",
        },
        body: "data=" + encodeURIComponent(ql),
      });
      const ct = res.headers.get("content-type") || "";
      const text = await res.text();
      if (res.status === 429 || res.status === 504) {
        lastErr = new Error(`${endpoint} rate-limited (${res.status})`);
        await sleep(2000 + attempt * 2000);
        continue;
      }
      // エラー時は XML/HTML が返る
      if (!ct.includes("json") || text.trimStart().startsWith("<")) {
        lastErr = new Error(`${endpoint} returned non-JSON (status ${res.status})`);
        await sleep(1500);
        continue;
      }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  throw new Error(`Overpass query failed after retries: ${lastErr?.message}`);
}

// Overpass の out geom 応答から way ごとの [lat,lon] 列を取り出す
function extractWays(json) {
  const ways = [];
  for (const el of json.elements || []) {
    if (el.type === "way" && Array.isArray(el.geometry)) {
      ways.push(el.geometry.map((g) => [g.lat, g.lon]));
    }
    // relation の out geom はメンバー way に geometry が付く場合と members 経由の場合がある
    if (el.type === "relation" && Array.isArray(el.members)) {
      for (const mem of el.members) {
        if (mem.type === "way" && Array.isArray(mem.geometry)) {
          ways.push(mem.geometry.map((g) => [g.lat, g.lon]));
        }
      }
    }
  }
  return ways.filter((w) => w.length >= 2);
}

/**
 * 路線名で way 群を取得する。relation → way の順にフォールバック。
 * @param {string} lineName  例 "南海加太線" / "山手線"
 * @returns {Promise<{ways:[number,number][][], via:string}>}
 */
export async function fetchLineWays(lineName) {
  // OSM 上は事業者名付き("南海電気鉄道加太線")や "JR" 冠の表記ゆれがあるため、
  // 末尾の路線名コア (…線) を正規表現の部分一致で拾う。
  const core = escapeRegex(lineName.replace(/^JR|^ＪＲ/, ""));
  // 1) route relation
  const relQl = `[out:json][timeout:60];
relation["route"="train"]["name"~"${core}"];
out geom;`;
  let json = await queryOverpass(relQl);
  let ways = extractWays(json);
  if (ways.length >= 1) return { ways, via: "relation" };

  // 2) way 検索
  const wayQl = `[out:json][timeout:60];
way["railway"="rail"]["name"~"${core}"];
out geom;`;
  json = await queryOverpass(wayQl);
  ways = extractWays(json);
  return { ways, via: "way" };
}

/**
 * bbox 内の全 railway=rail の way を取得する (共用区間の経路探索用)。
 * @param {[number,number,number,number]} bbox  [south, west, north, east]
 */
export async function fetchRailInBbox(bbox) {
  const [s, w, n, e] = bbox;
  const ql = `[out:json][timeout:90];
way["railway"="rail"](${s},${w},${n},${e});
out geom;`;
  const json = await queryOverpass(ql);
  return extractWays(json);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 7桁固定の座標キー (端点一致・ノード同一視に使う)
function key(pt) {
  return pt[0].toFixed(7) + "," + pt[1].toFixed(7);
}

/**
 * way 群の全頂点からグラフを構築する。
 * ノード = 座標キー、エッジ = way 内の隣接頂点 (重み = ハーバサイン距離)。
 * @param {[number,number][][]} ways
 * @returns {{adj:Map<string,{to:string,w:number}[]>, coord:Map<string,[number,number]>}}
 */
function buildGraph(ways) {
  const adj = new Map();
  const coord = new Map();
  const addNode = (pt) => {
    const k = key(pt);
    if (!coord.has(k)) {
      coord.set(k, pt);
      adj.set(k, []);
    }
    return k;
  };
  for (const w of ways) {
    for (let i = 0; i < w.length - 1; i++) {
      const a = addNode(w[i]);
      const b = addNode(w[i + 1]);
      if (a === b) continue;
      const d = haversine(w[i], w[i + 1]);
      adj.get(a).push({ to: b, w: d });
      adj.get(b).push({ to: a, w: d });
    }
  }
  return { adj, coord };
}

// 連結成分をラベリングし、各ノード -> 成分ID を返す
function connectedComponents(adj) {
  const comp = new Map();
  let id = 0;
  for (const start of adj.keys()) {
    if (comp.has(start)) continue;
    const stack = [start];
    comp.set(start, id);
    while (stack.length) {
      const u = stack.pop();
      for (const { to } of adj.get(u)) {
        if (!comp.has(to)) {
          comp.set(to, id);
          stack.push(to);
        }
      }
    }
    id++;
  }
  return comp;
}

// 指定成分内で座標 target に最も近いノードキーを返す
function nearestNodeInComp(coord, comp, compId, target) {
  let best = null;
  let bestD = Infinity;
  for (const [k, pt] of coord) {
    if (comp.get(k) !== compId) continue;
    const d = haversine(pt, target);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return { key: best, dist: bestD };
}

// ダイクストラ (単純な配列優先度で十分な規模: 数千ノード)
function dijkstra(adj, coord, srcKey, dstKey) {
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  dist.set(srcKey, 0);
  // 素朴だが min 抽出を線形で。ノード数が多い路線でも実用範囲。
  const pending = new Set(adj.keys());
  while (pending.size) {
    let u = null;
    let ud = Infinity;
    for (const k of pending) {
      const d = dist.get(k) ?? Infinity;
      if (d < ud) {
        ud = d;
        u = k;
      }
    }
    if (u === null || ud === Infinity) break;
    pending.delete(u);
    visited.add(u);
    if (u === dstKey) break;
    for (const { to, w } of adj.get(u)) {
      if (visited.has(to)) continue;
      const nd = ud + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
      }
    }
  }
  if (!prev.has(dstKey) && srcKey !== dstKey) return null;
  const path = [dstKey];
  let cur = dstKey;
  while (cur !== srcKey) {
    cur = prev.get(cur);
    if (cur === undefined) return null;
    path.push(cur);
  }
  path.reverse();
  return path.map((k) => coord.get(k));
}

/**
 * way 群と起点/終点駅から、駅間をつなぐ1本の線形を経路探索で得る。
 * 最大連結成分内で起点・終点に最も近いノードを選ぶ (孤立断片対策)。
 * @param {[number,number][][]} ways
 * @param {{lat:number,lon:number}} startSt
 * @param {{lat:number,lon:number}} endSt
 * @returns {[number,number][]|null}
 */
export function routeThroughWays(ways, startSt, endSt) {
  if (!ways.length) return null;
  const { adj, coord } = buildGraph(ways);
  const comp = connectedComponents(adj);
  // 成分ごとのノード数
  const sizes = new Map();
  for (const c of comp.values()) sizes.set(c, (sizes.get(c) || 0) + 1);
  // 起点・終点の両方をなるべく含む最良成分を選ぶ: 各成分での (起点距離+終点距離) 最小
  let bestComp = null;
  let bestScore = Infinity;
  const startPt = [startSt.lat, startSt.lon];
  const endPt = [endSt.lat, endSt.lon];
  for (const c of sizes.keys()) {
    const s = nearestNodeInComp(coord, comp, c, startPt);
    const e = nearestNodeInComp(coord, comp, c, endPt);
    if (!s.key || !e.key) continue;
    const score = s.dist + e.dist;
    if (score < bestScore) {
      bestScore = score;
      bestComp = { c, s, e };
    }
  }
  if (!bestComp) return null;
  const path = dijkstra(adj, coord, bestComp.s.key, bestComp.e.key);
  return path;
}

/**
 * 線形の向きを駅順に合わせ、両端を起点/終点駅の座標まで延長する。
 * OSM 上の路線起点が分岐点で駅の手前で終わる場合の対策 (SPEC 手順6)。
 */
function orientAndExtend(track, startSt, endSt) {
  if (track.length < 2) return track;
  const startPt = [startSt.lat, startSt.lon];
  const endPt = [endSt.lat, endSt.lon];
  const dHead = haversine(track[0], startPt) + haversine(track[track.length - 1], endPt);
  const dRev = haversine(track[track.length - 1], startPt) + haversine(track[0], endPt);
  let t = dRev < dHead ? track.slice().reverse() : track.slice();
  // 端点が駅から離れていれば駅座標を継ぎ足す (30m 以上のとき)
  if (haversine(t[0], startPt) > 0.03) t.unshift(startPt);
  if (haversine(t[t.length - 1], endPt) > 0.03) t.push(endPt);
  return t;
}

/**
 * 線形を検証する。SPEC 手順5: 弧長単調増加 / 駅と線形の距離 / 総延長。
 * @param {[number,number][]} track
 * @param {{name:string,lat:number,lon:number}[]} stations
 * @returns {{ok:boolean, km:number, maxStationDist:number, monotonic:boolean, issues:string[]}}
 */
export function validateTrack(track, stations) {
  const issues = [];
  const { cum, total } = cumulative(track);
  const arcs = stations.map((s) => projectStation(s, track, cum).arc);
  const dists = stations.map((s) => projectStation(s, track, cum).dist);
  let monotonic = true;
  for (let i = 1; i < arcs.length; i++) {
    if (arcs[i] < arcs[i - 1] - 0.05) {
      monotonic = false;
      issues.push(`駅順の弧長が逆行: ${stations[i - 1].name}→${stations[i].name}`);
    }
  }
  const maxStationDist = Math.max(...dists);
  if (maxStationDist > 0.15) {
    issues.push(`線形から遠い駅がある (最大 ${(maxStationDist * 1000) | 0}m)`);
  }
  return {
    ok: monotonic && maxStationDist <= 0.15,
    km: Math.round(total * 10) / 10,
    maxStationDist: Math.round(maxStationDist * 1000),
    monotonic,
    issues,
  };
}

// 駅群を包む bbox を余白付きで返す
function stationsBbox(stations, padDeg = 0.02) {
  let s = Infinity,
    w = Infinity,
    n = -Infinity,
    e = -Infinity;
  for (const st of stations) {
    s = Math.min(s, st.lat);
    n = Math.max(n, st.lat);
    w = Math.min(w, st.lon);
    e = Math.max(e, st.lon);
  }
  return [s - padDeg, w - padDeg, n + padDeg, e + padDeg];
}

/**
 * 路線の線形を構築する (取得 → 経路探索 → 間引き → 検証 → 延長)。
 * @param {{line_cd:number,name:string}} lineMeta
 * @param {{name:string,lat:number,lon:number}[]} stations  e_sort 順
 * @param {{loop?:boolean, forceBbox?:boolean}} opts
 * @returns {Promise<{track:[number,number][], validation:object, km:number, via:string}>}
 */
export async function buildTrack(lineMeta, stations, opts = {}) {
  if (stations.length < 2) throw new Error("駅が2つ未満です");
  const startSt = stations[0];
  const endSt = stations[stations.length - 1];
  const loop = opts.loop ?? false;

  let ways = [];
  let via = "";
  if (!opts.forceBbox) {
    const r = await fetchLineWays(lineMeta.name);
    ways = r.ways;
    via = r.via;
  }

  let route = ways.length ? routeThroughWays(ways, startSt, endSt) : null;
  let validation = route ? validateTrack(route, stations) : { ok: false, issues: ["経路なし"] };

  // 路線名だけで繋がらない (共用区間など) → bbox で周辺線路を集めて再探索
  if (!validation.ok) {
    const bboxWays = await fetchRailInBbox(stationsBbox(stations));
    // 路線名由来の way と混ぜてグラフを作る
    const merged = ways.concat(bboxWays);
    const route2 = routeThroughWays(merged, startSt, endSt);
    if (route2) {
      const v2 = validateTrack(route2, stations);
      if (!route || v2.ok || v2.maxStationDist < validation.maxStationDist) {
        route = route2;
        validation = v2;
        via = via ? via + "+bbox" : "bbox";
      }
    }
  }

  if (!route) throw new Error(`線形を構築できませんでした: ${lineMeta.name}`);

  route = orientAndExtend(route, startSt, endSt);
  route = simplifyTrack(route, 0.00003, loop);
  const finalValidation = validateTrack(route, stations);
  const km = trackLengthKm(route);

  return {
    track: route.map(([la, lo]) => [Math.round(la * 1e6) / 1e6, Math.round(lo * 1e6) / 1e6]),
    validation: finalValidation,
    km: Math.round(km * 10) / 10,
    via,
  };
}

/** キャッシュパス */
function cachePath(lineCd) {
  return join(CACHE_DIR, `${lineCd}.json`);
}

/** キャッシュ済み線形を返す (なければ null) */
export function readCachedTrack(lineCd) {
  const p = cachePath(lineCd);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/** 線形をキャッシュに保存する */
export function writeCachedTrack(lineCd, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(lineCd), JSON.stringify(data));
}

/**
 * キャッシュ優先で線形を取得する。無ければ Overpass から構築して保存。
 * @param {{line_cd:number,name:string}} lineMeta
 * @param {{name:string,lat:number,lon:number}[]} stations
 * @param {{loop?:boolean, refresh?:boolean}} opts
 */
export async function getOrBuildTrack(lineMeta, stations, opts = {}) {
  if (!opts.refresh) {
    const cached = readCachedTrack(lineMeta.line_cd);
    if (cached) return { ...cached, cached: true };
  }
  const built = await buildTrack(lineMeta, stations, opts);
  const record = {
    line_cd: lineMeta.line_cd,
    name: lineMeta.name,
    track: built.track,
    km: built.km,
    via: built.via,
    validation: built.validation,
    fetched_at: new Date().toISOString().slice(0, 10),
  };
  writeCachedTrack(lineMeta.line_cd, record);
  return { ...record, cached: false };
}
