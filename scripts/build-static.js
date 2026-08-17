// 静的ホスト用の配信ディレクトリ dist/ を組み立てる。
// public/ (ビューア資産) と trips/ (便データ) を1つのフォルダにまとめ、
// SPA ルーティング用の _redirects を書き出す。
//
// 静的ホスト (Cloudflare Pages / Netlify) の設定:
//   ビルドコマンド:  node scripts/build-static.js
//   出力ディレクトリ: dist
//
// 使い方: node scripts/build-static.js

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync, cpSync, writeFileSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = join(ROOT, "dist");

// クリーンビルド
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1) ビューア資産 (public/*) をルートへ
cpSync(join(ROOT, "public"), DIST, { recursive: true });

// 2) 便データ (trips/*.json, trips/lines/*.json) を /trips/ へ
const TRIPS = join(ROOT, "trips");
if (existsSync(TRIPS)) {
  cpSync(TRIPS, join(DIST, "trips"), { recursive: true });
}

// 3) SPA ルーティング (静的ファイルが無いパスだけ index.html を返す)。
//    実ファイル (/trips/xxx.json 等) はホストが先に配信するので巻き込まれない。
//    Cloudflare Pages / Netlify 共通の _redirects 形式。
const redirects = `# 分身の旅日記 — SPA ルーティング
/trips/*  /index.html  200
/l/*      /index.html  200
`;
writeFileSync(join(DIST, "_redirects"), redirects);

console.error(`dist/ を組み立てました → ${DIST}`);
console.error(`  ビルドコマンド:   node scripts/build-static.js`);
console.error(`  出力ディレクトリ: dist`);
