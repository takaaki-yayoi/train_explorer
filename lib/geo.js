// 線形処理のジオメトリ関数群。
// 座標は基本 [lat, lon] のペアで扱う (trip JSON の track と同じ並び)。
// 注意: 駅データ.jp CSV は lon,lat の順で格納されているため、そこは stations.js 側で入れ替える。

const R = 6371; // 地球半径 (km)
const toR = (x) => (x * Math.PI) / 180;

/**
 * 2点 [lat,lon] 間のハーバサイン距離 (km)。
 * @param {[number,number]} a
 * @param {[number,number]} b
 */
export function haversine(a, b) {
  const dLat = toR(b[0] - a[0]);
  const dLon = toR(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 線形 [[lat,lon],...] の累積距離配列と総延長 (km) を返す。
 * @param {[number,number][]} track
 * @returns {{cum:number[], total:number}}
 */
export function cumulative(track) {
  const cum = [0];
  for (let i = 1; i < track.length; i++) cum[i] = cum[i - 1] + haversine(track[i - 1], track[i]);
  return { cum, total: cum[cum.length - 1] };
}

/**
 * 線形の総延長 (km)。
 * @param {[number,number][]} track
 */
export function trackLengthKm(track) {
  return cumulative(track).total;
}

/**
 * Douglas-Peucker 法で線形を間引く。
 * 緯度経度を平面近似 (経度は cos(lat) 補正) して垂線距離を測る。
 * @param {[number,number][]} pts  [lat,lon] の列
 * @param {number} tolerance  許容誤差 (度)。既定 0.00003 ≈ 3m。
 * @returns {[number,number][]}
 */
export function douglasPeucker(pts, tolerance = 0.00003) {
  if (pts.length <= 2) return pts.slice();
  // 経度補正の基準は線形中央の緯度を使う (局所路線なら十分)
  const cosLat = Math.cos(toR(pts[Math.floor(pts.length / 2)][0])) || 1e-9;

  const keep = new Array(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;

  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = -1;
    let idx = -1;
    const ax = pts[lo][1] * cosLat;
    const ay = pts[lo][0];
    const bx = pts[hi][1] * cosLat;
    const by = pts[hi][0];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    for (let i = lo + 1; i < hi; i++) {
      const px = pts[i][1] * cosLat;
      const py = pts[i][0];
      let u = ((px - ax) * dx + (py - ay) * dy) / len2;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx > lo) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * 環状線対応の Douglas-Peucker。始点=終点で退化するため2分割してから適用する。
 * @param {[number,number][]} pts
 * @param {number} tolerance
 * @param {boolean} loop  環状かどうか
 */
export function simplifyTrack(pts, tolerance = 0.00003, loop = false) {
  if (!loop || pts.length < 4) return douglasPeucker(pts, tolerance);
  const mid = Math.floor(pts.length / 2);
  const a = douglasPeucker(pts.slice(0, mid + 1), tolerance);
  const b = douglasPeucker(pts.slice(mid), tolerance);
  return a.concat(b.slice(1));
}

/**
 * 駅 {lat,lon} を線形上に垂線射影し、起点からの弧長 (km) と最短距離 (km) を返す。
 * @param {{lat:number,lon:number}} st
 * @param {[number,number][]} track
 * @param {number[]} cum  cumulative(track).cum
 * @returns {{arc:number, dist:number}}
 */
export function projectStation(st, track, cum) {
  const cosLat = Math.cos(toR(st.lat)) || 1e-9;
  let bestD = Infinity;
  let bestArc = 0;
  const px = st.lon * cosLat;
  const py = st.lat;
  for (let i = 0; i < track.length - 1; i++) {
    const ax = track[i][1] * cosLat;
    const ay = track[i][0];
    const bx = track[i + 1][1] * cosLat;
    const by = track[i + 1][0];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let u = ((px - ax) * dx + (py - ay) * dy) / len2;
    u = Math.max(0, Math.min(1, u));
    const dDeg = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
    if (dDeg < bestD) {
      bestD = dDeg;
      bestArc = cum[i] + u * (cum[i + 1] - cum[i]);
    }
  }
  // 度→km の概算 (1度 ≈ 111km)。垂線距離は微小なので線形近似で十分。
  return { arc: bestArc, dist: bestD * 111 };
}

/**
 * 弧長 s (km) に対応する線形上の座標 [lat,lon] を二分探索+線形補間で返す。
 * @param {number} s
 * @param {[number,number][]} track
 * @param {number[]} cum
 * @param {number} total
 */
export function latLngAt(s, track, cum, total) {
  s = Math.max(0, Math.min(total, s));
  let lo = 0;
  let hi = track.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (cum[m] <= s) lo = m;
    else hi = m;
  }
  const seg = cum[hi] - cum[lo] || 1e-12;
  const u = (s - cum[lo]) / seg;
  return [
    track[lo][0] + (track[hi][0] - track[lo][0]) * u,
    track[lo][1] + (track[hi][1] - track[lo][1]) * u,
  ];
}
