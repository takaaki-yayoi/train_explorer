// 静的ホスト用の配信ディレクトリ dist/ を組み立てる。
// public/ (ビューア資産) と trips/ (便データ) を1つのフォルダにまとめ、
// SPA ルーティング用の _redirects を書き出す。
//
// 静的ホストの設定:
//   ビルドコマンド:  node scripts/build-static.js
//   出力ディレクトリ: dist
// SPA ルーティング (実ファイルが無いパスに index.html を返す) は:
//   - Cloudflare (Workers 静的アセット): wrangler.jsonc の
//       assets.not_found_handling = "single-page-application"
//   - Netlify:  dist/_redirects に  /*  /index.html  200  を置く (下のコメント参照)
//
// 使い方: node scripts/build-static.js

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";

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

// SPA ルーティングは wrangler.jsonc (Cloudflare) 側で設定する。
// Netlify を使う場合はここで dist/_redirects に `/*  /index.html  200` を書けばよいが、
// Cloudflare の Workers アセットは _redirects を厳格に検証するため既定では出力しない。

console.error(`dist/ を組み立てました → ${DIST}`);
console.error(`  ビルドコマンド:   node scripts/build-static.js`);
console.error(`  出力ディレクトリ: dist`);
