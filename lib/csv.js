// 駅データ.jp / OSM 由来の CSV を読むための最小パーサ。
// 依存を増やさないための自前実装。ダブルクオート囲みとエスケープ("")に対応する。

import { readFileSync } from "node:fs";

/**
 * 1行を列配列にパースする。RFC4180 風 (クオート内の , と "" に対応)。
 * @param {string} line
 * @returns {string[]}
 */
function parseLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * CSV 文字列をオブジェクト配列にパースする (1行目をヘッダとみなす)。
 * @param {string} text
 * @returns {Record<string,string>[]}
 */
export function parseCsv(text) {
  // CR/LF を正規化し、末尾の空行を落とす
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return [];
  const header = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "") continue;
    const cols = parseLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cols[j] ?? "";
    rows.push(row);
  }
  return rows;
}

/**
 * ファイルパスから CSV を読んでパースする。
 * @param {string} path
 * @returns {Record<string,string>[]}
 */
export function readCsv(path) {
  return parseCsv(readFileSync(path, "utf8"));
}
