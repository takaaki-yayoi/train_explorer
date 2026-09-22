// LLM による旅日記生成。既定は OpenAI (Chat Completions + 構造化出力)。
// プロバイダは環境変数 LLM_PROVIDER で切替可能 ("openai" | "anthropic")、既定は "openai"。
// 夜間バッチ想定なのでリアルタイム性は不要。構造化出力で diary 配列を確実に受け取る。
//
// 必要な環境変数:
//   OpenAI 版:    OPENAI_API_KEY   (任意で OPENAI_MODEL, 既定 gpt-4o-mini)
//   Anthropic 版: ANTHROPIC_API_KEY (任意で ANTHROPIC_MODEL, 既定 claude-opus-4-8)

import { checkTitles } from "./spots.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// diary 1件の JSON Schema (構造化出力の制約に使う)。
// OpenAI strict モードの要件を満たすため各オブジェクトで additionalProperties:false と
// 全プロパティの required を指定している。
const DIARY_SCHEMA = {
  type: "object",
  properties: {
    diary: {
      type: "array",
      description: "時系列の旅日記エントリ",
      items: {
        type: "object",
        properties: {
          t: { type: "string", description: "時刻 HH:MM" },
          st: { type: "integer", description: "stations のインデックス (0起点)" },
          type: { type: "string", enum: ["stop", "pass"] },
          text: { type: "string", description: "日記本文 (HTML, 固有名詞は<a>リンク可)" },
        },
        required: ["t", "st", "type", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["diary"],
  additionalProperties: false,
};

/** 現在有効なプロバイダ */
export function activeProvider() {
  return (process.env.LLM_PROVIDER || "openai").toLowerCase();
}

/** 有効プロバイダに必要な API キー名 */
export function apiKeyEnvName() {
  return activeProvider() === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

/** 有効プロバイダの API キーが設定済みか */
export function hasApiKey() {
  return Boolean(process.env[apiKeyEnvName()]);
}

/**
 * プロンプトを組み立てる。ペルソナ + 路線コンテキスト + 実在スポット素材。
 */
function buildPrompt({ line, persona, stations, spots, date, weather }, reinforce = "") {
  const N = stations.length;
  const lastName = stations[N - 1].name;
  const stationList = stations.map((s, i) => `${i}: ${s.name}`).join("\n");

  // 駅ごとの素材量は駅数で按分する (長大路線でプロンプトが膨れすぎないように)
  const budget = Math.max(400, Math.min(1300, Math.floor(24000 / N)));
  const flat = (t, n) => (t || "").replace(/\n+/g, " ").slice(0, n);
  const spotLines = spots.stationSpots
    .map((sp, i) => {
      const nearby = (sp.nearby || []).map((n) => `${n.title}(${n.km}km)`).join("、");
      const pois = (sp.pois || []).map((p) => `${p.name}[${p.kind}${p.m}m${p.note ? " " + p.note : ""}]`).join("、");
      if (!sp.info && !sp.around && !sp.history && !nearby && !pois)
        return `## ${i} ${sp.name}駅\n(Wikipedia素材なし。無理に書かず、書くなら検索リンクに逃がす)`;
      const parts = [`## ${i} ${sp.name}駅`];
      if (sp.info) parts.push(`概要: ${flat(sp.info, Math.floor(budget * 0.25))}`);
      if (sp.around) parts.push(`駅周辺: ${flat(sp.around, Math.floor(budget * 0.45))}`);
      if (sp.history) parts.push(`歴史: ${flat(sp.history, Math.floor(budget * 0.3))}`);
      if (sp.links && sp.links.length) parts.push(`Wikipediaに記事がある語: ${sp.links.join("、")}`);
      if (nearby) parts.push(`近くにあるWikipedia記事(記事名と駅からの直線距離): ${nearby}`);
      if (pois) parts.push(`駅周辺の地物(OpenStreetMap。[種類と駅からの距離]。Wikipedia記事は無いので、リンクするなら検索リンク): ${pois}`);
      return parts.join("\n");
    })
    .join("\n\n");

  const lineInfo = spots.lineInfo ? spots.lineInfo.replace(/\n+/g, " ").slice(0, 3500) : "(路線記事の素材なし)";

  const system = `あなたは「分身の旅日記」というサービスの日記生成エンジンです。
架空のキャラクター(分身)が日本の実在の鉄道路線を実際に旅した体で、一人称の旅日記を書きます。
読者はこの日記を地図と一緒に眺めます。移動が「旅」になる、味わいのある文章が目的です。

## 絶対ルール
- 事実の捏造をしない。自信がないスポットは書かないか、検索リンクに逃がす。
- 提供された実在スポット素材(Wikipedia抜粋)にある固有名詞を必ず織り込む。定型文っぽくなると一気に冷める。
- 素材に無い情景を作らない。駅舎の古さ・煉瓦・荒廃・匂いなど、素材に根拠の無い描写で埋めない。
- OpenStreetMap 由来の地物は名前と種類と距離しか分かっていない。名前から見た目や由来を想像で膨らませない。
  「駅から600mの川を渡る」「駅前の鮮魚店をのぞく」程度の、分かっている範囲で書く。
- どの駅にも当てはまる文を書かない。「特に目にとまるものはない」「静かな駅」「歴史を感じる」「次へ進む」の類は禁止。
  書くことが無い駅は、素材にある事実(地名の由来、開業や移管の経緯、周辺の施設や川)を一つ拾って分身の目線で一言評する。
- 固有名詞リンク: Wikipediaに確実に記事がある語(各駅素材の「Wikipediaに記事がある語」「近くにあるWikipedia記事」は記事名そのもの)は
  <a href="https://ja.wikipedia.org/wiki/記事名" target="_blank" rel="noopener">表示</a>、
  不確実な語は <a href="https://www.google.com/search?q=検索語" target="_blank" rel="noopener">表示</a>。
  URL内の記事名・検索語はそのまま日本語でよい(エンコード不要)。
- 駅名そのものにはリンクを付けない(ビューア側で自動生成するため)。
- text は上記<a>以外のHTMLタグを使わない。地の文はプレーン。`;

  const user = `# 今日の旅
- 日付: ${date}${weather ? ` (${weather})` : ""}
- 路線: ${line.name} (${line.company})
- 区間: ${stations[0].name} → ${stations[stations.length - 1].name} / 全長 約${line.km ?? "?"}km

# 分身 (ペルソナ)
- 名前: ${persona.name} ${persona.emoji}
- 性格/属性: ${persona.traits}
- 文体: ${persona.voice}
- 興味の対象: ${persona.interests}

# 駅リスト (この順に並んでいる。インデックスを st に使う)
${stationList}

# 路線の背景 (Wikipedia)
${lineInfo}

# 各駅の実在スポット素材 (Wikipedia抜粋 + OpenStreetMap。ここの固有名詞を使う)
${spotLines}

# 生成ルール (最重要: 路線を最後まで旅すること)
- この旅は起点 ${stations[0].name}(index 0) から終点 ${lastName}(index ${N - 1}) までの全${N}駅。**必ず全駅を順にたどり、終点まで到達すること。**
- **最後のエントリは必ず終点 ${lastName}(index ${N - 1}) の "stop"(途中下車)で締める。** 途中の駅で終わらせてはいけない。
- 各駅(index 0〜${N - 1})を stop か pass で最低1回は登場させる。st は 0 から ${N - 1} まで昇順(隣接駅の重複は可)。時刻 t も昇順。
- **エントリ数は駅数と同程度。最低でも ${Math.max(4, Math.ceil(N * 0.8))} 個。** 2〜3個で終わらせるのは失敗。
- 各エントリは type が "stop"(途中下車, 長文) か "pass"(車窓から, 短文)。stop は3〜6文でエピソード性を、pass は1〜2文で軽く。
- 起点と終点は stop。途中は魅力的な駅を2〜3つ stop にし、残りは pass。stop にする駅は、素材の中に分身の興味に刺さるものがある駅を選ぶ。
- **stop でも pass でも、各エントリにその駅の素材由来の固有名詞か具体的事実を最低1つ入れる。** 同じ言い回し・同じオチ(「〜は見当たらない」等)を繰り返さない。
- ローカル線ではダイヤの疎らさを反映する(途中下車したら次の列車まで数時間、という時間経過を入れるとリアルになる)。
- ${persona.name}の性格を通して「何に目を留めるか」を変える。${persona.interests}に沿った着眼で。${reinforce}

diary 配列だけを出力してください。`;

  return { system, user };
}

/**
 * OpenAI Chat Completions を呼ぶ (構造化出力: json_schema strict)。
 */
async function callOpenAI(system, user, opts) {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY が未設定です");
  // 環境変数は GitHub の Variables から来るので、貼り付け時に紛れた空白を落とす
  const model = opts.model || (process.env.OPENAI_MODEL || "").trim() || "gpt-4o-mini";

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "diary", strict: true, schema: DIARY_SCHEMA },
    },
    // 推論モデルでは推論トークンもこの上限に含まれる。小さいと長い路線で日記が途中で切れる
    max_completion_tokens: 32000,
  };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${JSON.stringify(data)}`);
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  if (msg && msg.refusal) throw new Error("生成が拒否されました: " + msg.refusal);
  const content = msg && msg.content;
  if (!content) throw new Error("応答に content がありません");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("日記 JSON のパースに失敗: " + content.slice(0, 200));
  }
  return { diaryRaw: parsed.diary, model: data.model || model, usage: data.usage || {} };
}

/**
 * Anthropic Messages を呼ぶ (構造化出力: output_config.format)。
 */
async function callAnthropic(system, user, opts) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = opts.model || process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

  const body = {
    model,
    max_tokens: 16000,
    system,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: DIARY_SCHEMA } },
    messages: [{ role: "user", content: user }],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(data)}`);
  if (data.stop_reason === "refusal") throw new Error("生成が拒否されました (refusal)");
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("応答に text ブロックがありません");
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error("日記 JSON のパースに失敗: " + textBlock.text.slice(0, 200));
  }
  return { diaryRaw: parsed.diary, model: data.model || model, usage: data.usage || {} };
}

/**
 * 日記を生成する。プロバイダは LLM_PROVIDER (既定 openai)。
 * @param {object} ctx  { line, persona, stations, spots, date, weather }
 * @param {{provider?:string, model?:string, apiKey?:string}} opts
 * @returns {Promise<{diary:object[], model:string, usage:object, provider:string}>}
 */
export async function generateDiary(ctx, opts = {}) {
  const provider = (opts.provider || activeProvider()).toLowerCase();
  const N = ctx.stations.length;
  const maxAttempts = opts.attempts || 3;
  let best = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const reinforce =
      attempt === 0
        ? ""
        : `\n\n【再生成の指示】前回の出力は途中の駅で終わってしまい不完全でした。今回は必ず起点から終点 ${ctx.stations[N - 1].name}(index ${N - 1}) まで全${N}駅をたどり、最後のエントリを終点の "stop" にしてください。エントリ数は最低 ${Math.max(4, Math.ceil(N * 0.8))} 個。`;
    const { system, user } = buildPrompt(ctx, reinforce);
    const out =
      provider === "anthropic" ? await callAnthropic(system, user, opts) : await callOpenAI(system, user, opts);
    const diary = sanitizeDiary(out.diaryRaw, N);
    if (!best || diary.length > best.diary.length) best = { diary, model: out.model, usage: out.usage };
    if (isComplete(diary, N)) {
      const deadLinks = await verifyWikiLinks(diary);
      return { diary, model: out.model, usage: out.usage, provider, attempts: attempt + 1, deadLinks };
    }
  }
  const deadLinks = await verifyWikiLinks(best.diary);
  return { ...best, provider, attempts: maxAttempts, incomplete: true, deadLinks };
}

/**
 * 日記の Wikipedia リンクを検証し、記事が存在しないものは Google 検索リンクに差し替える。
 * モデルは素材に無い語にも推測でリンクを張ることがある (実測で約2%)。リンク切れを読者に踏ませない。
 * 確認できなかったリンク (Wikipedia に繋がらない等) はそのまま残す。
 * @param {{text:string}[]} diary  書き換える
 * @returns {Promise<string[]>}  差し替えた記事名
 */
export async function verifyWikiLinks(diary) {
  const WIKI_HREF = /href="https:\/\/ja\.wikipedia\.org\/wiki\/([^"]+)"([^>]*)>([^<]*)<\/a>/g;
  const titleOf = (raw) => {
    let t = raw;
    try {
      t = decodeURIComponent(raw);
    } catch {}
    return t.replace(/_/g, " ").split("#")[0];
  };
  const titles = new Set();
  for (const e of diary) for (const m of e.text.matchAll(WIKI_HREF)) titles.add(titleOf(m[1]));
  if (!titles.size) return [];
  const checked = await checkTitles([...titles]);
  const replaced = [];
  for (const e of diary) {
    e.text = e.text.replace(WIKI_HREF, (all, raw, attrs, label) => {
      const title = titleOf(raw);
      if (checked.get(title) !== false) return all;
      if (!replaced.includes(title)) replaced.push(title);
      return `href="https://www.google.com/search?q=${label || title}"${attrs}>${label}</a>`;
    });
  }
  return replaced;
}

/**
 * 日記が路線を最後まで旅せているか (終点到達・十分な件数・起点あり)。
 */
export function isComplete(diary, stationCount) {
  if (!diary || diary.length < Math.max(3, Math.ceil(stationCount * 0.6))) return false;
  const maxSt = Math.max(...diary.map((e) => e.st));
  if (maxSt < stationCount - 1) return false; // 終点に到達していない
  if (!diary.some((e) => e.st === 0)) return false; // 起点がない
  return true;
}

/**
 * 生成結果を整える: st 範囲チェック、type 検証、空 text 除去。
 */
export function sanitizeDiary(diary, stationCount) {
  const clean = [];
  for (const e of diary || []) {
    let st = Number(e.st);
    if (!Number.isInteger(st) || st < 0) st = 0;
    if (st > stationCount - 1) st = stationCount - 1;
    const type = e.type === "pass" ? "pass" : "stop";
    const t = typeof e.t === "string" ? e.t : "";
    const text = typeof e.text === "string" ? e.text : "";
    if (!text) continue;
    clean.push({ t, st, type, text });
  }
  return clean;
}
