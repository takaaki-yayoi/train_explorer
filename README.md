# 分身の旅日記 (v1: 公共の便)

自分の分身 (キャラクター) が日本の実在の鉄道路線を旅し、途中下車した駅や車窓の風景に感想を残す。ユーザーはその旅日記を地図と一緒に眺める — 「操作する旅」ではなく「分身が勝手にした旅の報告を受け取る」非同期体験。

v1 はアカウントなし。毎朝1本、全ユーザーが同じ旅日記を読む**新聞連載**形式。認証・DB・ユーザー別コストはすべて不要で、`trips/<date>.json` を配るだけ。

詳細な企画は [SPEC.md](SPEC.md) 参照。

## 動かす

依存ゼロ (Node.js 18+ の標準機能のみ)。ビルド不要。

```bash
# 1) 参照実装3本をシードデータに変換 (山手線/名松線/加太線)
node scripts/build-samples.js

# 2) サーバ起動 → http://localhost:8787/
node server.js
```

ブラウザで開くと最新便へリダイレクトされる。各便は静的URL `/trips/2026-07-11` で共有可能。

## 構成

```
data/          駅データ.jp CSV スナップショット (4本、同梱)
lib/           コアライブラリ (依存なし)
  csv.js         最小 CSV パーサ
  stations.js    駅/路線/事業者の結合・抽出 (e_sort順, lon/lat入替, 除外判定)
  geo.js         ハーバサイン / Douglas-Peucker / 駅の射影 / 弧長→座標
  track.js       Overpass 線形取得 → グラフ+ダイクストラ → 間引き → 検証 → キャッシュ
  spots.js       Wikipedia から沿線スポット素材を収集
  personas.js    分身 (ペルソナ) 定義とローテーション
  diary.js       Anthropic API で日記生成 (構造化出力)
  trips-store.js trip JSON の保存・索引
scripts/       CLI (下記)
cache/tracks/  line_cd 単位の線形キャッシュ (全便で共有)
trips/         生成された便 (<date>.json) と index.json
public/        ビューア (単一HTML + vanilla JS + Leaflet CDN + PWA)
server.js      依存ゼロの静的配信 + trip API
```

## パイプライン (夜間バッチ)

```
路線選定 → 線形取得/キャッシュ確認 (Overpass) → スポット収集 (Wikipedia) → LLM生成 → trip JSON保存
```

```bash
# 翌朝の便を生成 (路線を日付シードで決定的に選定、キャラをローテーション)
OPENAI_API_KEY=sk-... node scripts/generate-daily.js

# cron 例: 毎晩3時に翌日分
# 0 3 * * *  cd /path/to/train_explorer && OPENAI_API_KEY=... node scripts/generate-daily.js
```

### 個別コマンド

```bash
node scripts/list-lines.js [絞り込み語|--random]      # 有効な路線一覧 (537路線)
node scripts/fetch-track.js <line_cd> [--loop]        # 線形だけ取得してキャッシュ
node scripts/generate-trip.js --line <cd> [--date ..] [--persona id] [--loop] [--dry]
node scripts/generate-daily.js [--date ..] [--line cd]
node scripts/build-samples.js                         # 参照3本 → シード
```

`--dry` は LLM 呼び出し前まで実行し、線形とスポット素材を確認する (APIキー不要)。

### 路線を指定して巡らせる (オンデマンド生成)

ビューアのヘッダ 🚃 ボタンから路線を選ぶと、その場で分身がその路線を巡って日記を書く。

- サーバは `GET /api/lines/<cd>/generate` を **SSE** で応答し、進捗 (線形取得 → 沿線調査 → 日記生成) を逐次流す。
- 生成結果は `trips/lines/<cd>.json` にキャッシュされ、静的URL `/l/<line_cd>` で共有できる。同じ路線の再選択はキャッシュを再利用 (API 無駄打ちなし)。
- `OPENAI_API_KEY` をサーバ環境に設定して起動すると日記まで生成される。未設定でも線形・沿線情報は動くが、日記生成時にその旨を表示する。

```bash
OPENAI_API_KEY=sk-... node server.js
```

> ⚠️ オンデマンド生成は1回ごとに LLM API を呼ぶ (少額課金)。個人利用・手元確認向け。公開デプロイ時はレート制限や認証でゲートするか、この経路を無効化すること。

## デプロイ (静的ホスト + GitHub Actions)

公開サイトは **連載を静的ホストで配信** し、**毎晩の生成は GitHub Actions** が回す構成。ランタイム費用ゼロ・荒らされる面なし。🚃 オンデマンド生成は手元の Node サーバー専用 (公開サイトでは自動的に非表示)。

**仕組み**: `public/`(ビューア)と `trips/`(便データ)は静的ファイルなので、`node scripts/build-static.js` が両者を `dist/` にまとめ、SPA ルーティング用の `_redirects` を書き出す。ビューアは `trips/*.json` を直読みするのでバックエンド不要。

### 手順

1. **GitHub にリポジトリを作って push**
   ```bash
   git init && git add -A && git commit -m "initial"
   git remote add origin git@github.com:<you>/train_explorer.git
   git push -u origin main
   ```
2. **静的ホストを連携** (Cloudflare Pages か Netlify、どちらも無料枠・`_redirects` 対応)
   - リポジトリを接続
   - ビルドコマンド: `node scripts/build-static.js`
   - 出力ディレクトリ: `dist`
3. **Actions に OpenAI キーを登録**
   - GitHub リポジトリ → Settings → Secrets and variables → Actions → `OPENAI_API_KEY` を追加
4. 以降、[.github/workflows/daily.yml](.github/workflows/daily.yml) が毎日 04:00 JST に翌朝の便を生成→コミット→push し、ホストが自動再デプロイする (手動実行は Actions タブの "Run workflow")。

> 🚃 **手元で路線を試す/公開便を仕込む**: `OPENAI_API_KEY=sk-... node server.js` を自分のPCで動かすと 🚃 が使える。気に入った路線の `trips/lines/<cd>.json` を commit すれば、公開サイトの `/l/<line_cd>` でも見られる (ローカルで curate → commit で公開)。

## 技術メモ

- **線形**: `line_cd` 単位で一度取得してキャッシュすれば全便・全ユーザーで共有 (実在路線は約610本のみ)。全way頂点のグラフを作り起点駅〜終点駅をダイクストラ探索するので、共用区間 (直通運転) や複線・環状線に強い。Overpass はレート制限があるためミラー3つを順に試し、エラー時のXMLレスポンスを判定する。
- **検証** (`validateTrack`): 各駅を線形へ垂線射影し、駅順で弧長が単調増加すること・駅と線形の距離が数十m以内・総延長が実路線長とほぼ一致することを確認。加太線で12.1km (実12.0km)、名松線43.5km、山手線34.5kmで確認済み。
- **LLM**: 既定は **OpenAI** (`OPENAI_API_KEY`, モデルは `OPENAI_MODEL` で変更可・既定 `gpt-4o-mini`)。Chat Completions の構造化出力 (`response_format: json_schema` strict) で `diary` 配列を確実に受け取る。プロンプトにペルソナ・路線背景・駅周辺の実在スポットを渡し、固有名詞リンクを本文に埋め込ませる。事実の捏造は禁止、自信のない語は検索リンクに逃がす。品質を上げたい場合は `OPENAI_MODEL=gpt-4o` 等に。`LLM_PROVIDER=anthropic` にすると Anthropic (`ANTHROPIC_API_KEY`, 既定 `claude-opus-4-8`) に切替可能 ([lib/diary.js](lib/diary.js) がプロバイダ選択式)。
- **ビューア**: 分身の移動は弧長ベース (累積距離配列 + 二分探索 + 線形補間)。地図タイルは OpenStreetMap 標準 と 地理院タイル航空写真 の切替 (キー不要)。駅名リンクは `Special:Search` 経由で自動生成 (同名駅の曖昧さ回避)。PWA 対応 (ホーム画面追加、オフライン閲覧)。

## 法務 (確認済み 2026-07-12)

- **駅データ.jp**: 商用利用OK・連絡不要・出典明記不要 (歓迎)・加工利用OK。CSVスナップショットを同梱・保持。
- **OpenStreetMap**: ODbL。「© OpenStreetMap contributors」表記を維持。
- **地理院タイル**: 「地理院タイル」出典表記を維持。
- **Wikipedia・Google検索へのリンク**: 制約なし。

ビューアのクレジット表記でこれらを明示している。

## v2 以降 (刺さった場合)

ユーザーごとの分身作成 (名前・絵文字・性格プロンプト)、旅の履歴、訪問路線の記録。分身管理を有料機能に。Webプッシュ通知 (iOS PWA対応済み)。
