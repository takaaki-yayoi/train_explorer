// 駅データ.jp CSV の結合と抽出。
// - 駅リスト: station.line_cd = X を e_status=0 かつ e_sort 昇順で
// - 路線名/事業者名: line_cd → line_name, company_cd → company_name
// - CSV は座標を lon,lat の順で持つので lat/lon に入れ替えて返す

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readCsv } from "./csv.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, "..", "data");

// CSV ファイル名 (スナップショット同梱版)
const FILES = {
  station: "station20260618free.csv",
  line: "line20260618free.csv",
  company: "company20260409.csv",
};

let _db = null;

/**
 * CSV を一度だけ読み込み、索引を構築する。
 */
export function loadDb() {
  if (_db) return _db;
  const stations = readCsv(join(DATA_DIR, FILES.station));
  const lines = readCsv(join(DATA_DIR, FILES.line));
  const companies = readCsv(join(DATA_DIR, FILES.company));

  const lineByCd = new Map();
  for (const l of lines) lineByCd.set(l.line_cd, l);

  const companyByCd = new Map();
  for (const c of companies) companyByCd.set(c.company_cd, c);

  // line_cd -> 駅行の配列
  const stationsByLine = new Map();
  for (const s of stations) {
    if (!stationsByLine.has(s.line_cd)) stationsByLine.set(s.line_cd, []);
    stationsByLine.get(s.line_cd).push(s);
  }

  _db = { stations, lines, companies, lineByCd, companyByCd, stationsByLine };
  return _db;
}

/**
 * 除外すべき路線か (新幹線・地下鉄・ケーブル・鋼索・モノレール・新交通)。
 * プロトタイプ実績どおり line_name の文字列で判定する。
 * @param {string} lineName
 */
export function isExcludedLine(lineName) {
  if (!lineName) return true;
  return /新幹線|地下鉄|メトロ|ケーブル|鋼索|索道|ロープウェイ|モノレール|新交通|ゆりかもめ|ライナー(?!.)/.test(
    lineName
  );
}

/**
 * 有効な (旅の対象になる) 路線一覧を返す。
 * @returns {{line_cd:number, name:string, company:string, stationCount:number}[]}
 */
export function listLines() {
  const db = loadDb();
  const out = [];
  for (const [lineCd, sts] of db.stationsByLine) {
    const line = db.lineByCd.get(lineCd);
    if (!line || line.e_status !== "0") continue;
    if (isExcludedLine(line.line_name)) continue;
    const valid = sts.filter((s) => s.e_status === "0");
    if (valid.length < 2) continue; // 2駅未満は旅にならない
    const company = db.companyByCd.get(line.company_cd);
    out.push({
      line_cd: Number(lineCd),
      name: line.line_name,
      company: company ? company.company_name : "",
      stationCount: valid.length,
    });
  }
  out.sort((a, b) => a.line_cd - b.line_cd);
  return out;
}

/**
 * 指定 line_cd の路線メタ + 駅リストを返す。
 * 駅は e_status=0 のみ、e_sort 昇順、座標は [lat,lon] に正規化。
 * @param {number|string} lineCd
 * @returns {{line:{line_cd:number,name:string,company:string,km:number|null},
 *            stations:{name:string,lat:number,lon:number}[]}|null}
 */
export function getLine(lineCd) {
  const db = loadDb();
  const key = String(lineCd);
  const line = db.lineByCd.get(key);
  if (!line) return null;
  const company = db.companyByCd.get(line.company_cd);
  const raw = (db.stationsByLine.get(key) || []).filter((s) => s.e_status === "0");
  raw.sort((a, b) => Number(a.e_sort) - Number(b.e_sort));
  const stations = raw.map((s) => ({
    name: s.station_name,
    lat: Number(s.lat),
    lon: Number(s.lon),
    station_cd: Number(s.station_cd),
  }));
  return {
    line: {
      line_cd: Number(line.line_cd),
      name: line.line_name,
      company: company ? company.company_name : "",
      km: null, // 実延長は線形取得後に埋める
    },
    stations,
  };
}

/**
 * 路線名 (部分一致) から候補路線を検索する。線形取得の路線名突き合わせに使う。
 * @param {string} query
 */
export function searchLinesByName(query) {
  return listLines().filter((l) => l.name.includes(query));
}
