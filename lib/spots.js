// 沿線の実在スポット情報を Wikipedia から収集する。
// 日記の質はここで決まる (SPEC): 実在の固有名詞を織り込むための素材集め。
// - 路線記事: 歴史・特徴
// - 各駅記事: 周辺スポット・史跡・地形
// MediaWiki API (ja.wikipedia) の extracts を使う。記事が無い駅は素材なしとして扱う。

const WIKI_API = "https://ja.wikipedia.org/w/api.php";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * MediaWiki API を叩く小ヘルパ (JSON)。
 * @param {Record<string,string>} params
 */
async function wikiQuery(params) {
  const url =
    WIKI_API +
    "?" +
    new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params }).toString();
  const res = await fetch(url, {
    headers: { "User-Agent": "bunshin-tabi-nikki/1.0 (train diary spot collector)" },
  });
  if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
  return res.json();
}

/**
 * 記事タイトル群のイントロ抽出をまとめて取得する。
 * @param {string[]} titles
 * @param {number} chars  各記事の最大文字数
 * @returns {Promise<Map<string,string>>}  正規化前タイトル -> 抽出テキスト
 */
async function fetchExtracts(titles, chars = 600) {
  const result = new Map();
  // API は titles を | 区切りで複数受けるが、一度に多すぎると重いので 20 件ずつ
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    let data;
    try {
      data = await wikiQuery({
        action: "query",
        prop: "extracts",
        exintro: "1",
        explaintext: "1",
        exchars: String(chars),
        redirects: "1",
        titles: batch.join("|"),
      });
    } catch {
      continue;
    }
    // redirects/normalized で元タイトルとの対応を作る
    const q = data.query || {};
    const aliasToCanonical = new Map();
    for (const nz of q.normalized || []) aliasToCanonical.set(nz.from, nz.to);
    for (const rd of q.redirects || []) aliasToCanonical.set(rd.from, rd.to);
    const extractByTitle = new Map();
    for (const page of q.pages || []) {
      if (page.missing) continue;
      if (page.extract) extractByTitle.set(page.title, page.extract.trim());
    }
    for (const orig of batch) {
      let canonical = orig;
      // 別名を1〜2段たどる
      for (let hop = 0; hop < 3 && aliasToCanonical.has(canonical); hop++) {
        canonical = aliasToCanonical.get(canonical);
      }
      const ex = extractByTitle.get(canonical) || extractByTitle.get(orig);
      if (ex) result.set(orig, ex);
    }
    if (i + 20 < titles.length) await sleep(300);
  }
  return result;
}

/**
 * 路線と駅群のスポット素材を集める。
 * @param {{name:string, company:string}} line
 * @param {{name:string}[]} stations
 * @returns {Promise<{lineInfo:string|null, stationSpots:{name:string,info:string}[]}>}
 */
export async function collectSpots(line, stations) {
  // 路線記事の候補タイトル
  const lineTitles = [line.name, `${line.company}${line.name}`.replace(/\s/g, "")];
  const lineExtract = await fetchExtracts(lineTitles, 800);
  let lineInfo = null;
  for (const t of lineTitles) {
    if (lineExtract.has(t)) {
      lineInfo = lineExtract.get(t);
      break;
    }
  }

  // 駅記事: "<駅名>駅" で引く (同名駅の曖昧さは残るが素材用途なので許容)
  const stationTitles = stations.map((s) => `${s.name}駅`);
  const stationExtracts = await fetchExtracts(stationTitles, 500);
  const stationSpots = stations.map((s) => ({
    name: s.name,
    info: stationExtracts.get(`${s.name}駅`) || "",
  }));

  return { lineInfo, stationSpots };
}
