// 沿線の実在スポット情報を Wikipedia から収集する。
// 日記の質はここで決まる (SPEC): 実在の固有名詞を織り込むための素材集め。
// - 路線記事: 歴史・特徴 (イントロ + あれば「沿線概況」節)
// - 各駅記事: イントロ + 「駅周辺」「歴史」節。イントロだけだと「〜にある駅である」しか取れない
// - 駅の座標の近くにある記事 (geosearch): 史跡・寺社・港・酒蔵など
// MediaWiki API (ja.wikipedia) を使う。同名駅は座標で照合し、記事が無い駅は素材なしとして扱う。

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
  // レート制限 (429 や非JSONの "too many requests") は間を空けて再試行する。
  // ここで諦めると素材なしのまま日記が書かれ、定型文だらけになる。
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(2000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "bunshin-tabi-nikki/1.0 (https://bunshin-tabi.com; train diary spot collector)" },
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`Wikipedia API ${res.status}`);
      return JSON.parse(body);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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

/** 2点間の距離 (km)。同名駅の照合用なので球面近似で十分。 */
function distKm(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6371;
}

// 記事の座標が駅の座標からこれ以上離れていたら別の同名駅とみなす
const SAME_STATION_KM = 3;

/**
 * 駅記事の本文 (wikitext)・イントロ・座標・曖昧さ回避フラグをまとめて取得する。
 * @param {string[]} titles
 * @returns {Promise<Map<string,{title:string,intro:string,wikitext:string,coord:{lat:number,lon:number}|null,disambig:boolean}>>}
 */
async function fetchPages(titles) {
  const result = new Map();
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    let data;
    try {
      data = await wikiQuery({
        action: "query",
        prop: "extracts|revisions|coordinates|pageprops",
        exintro: "1",
        explaintext: "1",
        exchars: "400",
        exlimit: "20",
        rvprop: "content",
        rvslots: "main",
        colimit: "max",
        ppprop: "disambiguation",
        redirects: "1",
        titles: batch.join("|"),
      });
    } catch {
      continue;
    }
    const q = data.query || {};
    const aliasToCanonical = new Map();
    for (const nz of q.normalized || []) aliasToCanonical.set(nz.from, nz.to);
    for (const rd of q.redirects || []) aliasToCanonical.set(rd.from, rd.to);
    const pageByTitle = new Map();
    for (const page of q.pages || []) {
      if (page.missing) continue;
      const rev = page.revisions && page.revisions[0];
      const co = page.coordinates && page.coordinates[0];
      pageByTitle.set(page.title, {
        title: page.title,
        intro: (page.extract || "").trim(),
        wikitext: (rev && rev.slots && rev.slots.main && rev.slots.main.content) || "",
        coord: co ? { lat: co.lat, lon: co.lon } : null,
        disambig: Boolean(page.pageprops && "disambiguation" in page.pageprops),
      });
    }
    for (const orig of batch) {
      let canonical = orig;
      for (let hop = 0; hop < 3 && aliasToCanonical.has(canonical); hop++) {
        canonical = aliasToCanonical.get(canonical);
      }
      const pg = pageByTitle.get(canonical) || pageByTitle.get(orig);
      if (pg) result.set(orig, pg);
    }
    if (i + 20 < titles.length) await sleep(300);
  }
  return result;
}

/** wikitext から [[リンク先]] の記事名を拾う (ファイル・カテゴリ・年月日は除く)。 */
function extractLinkTitles(wikitext) {
  const out = [];
  for (const m of wikitext.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const t = m[1].trim();
    if (!t || t.includes(":")) continue;
    if (/^\d+(年|月\d+日|年代|世紀)$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** wikitext を素材用のプレーンテキストにする (脚注・テンプレート・表を落とし、リンクは表示文字列に)。 */
function wikitextToPlain(wikitext) {
  let s = wikitext
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<gallery[^>]*>[\s\S]*?<\/gallery>/gi, "")
    .replace(/\{\|[\s\S]*?\|\}/g, "");
  // テンプレートは入れ子があるので内側から繰り返し落とす
  for (let i = 0; i < 5 && /\{\{[^{}]*\}\}/.test(s); i++) s = s.replace(/\{\{[^{}]*\}\}/g, "");
  return s
    .replace(/\[\[(?:ファイル|画像|File|Image):[^\]]*\]\]/gi, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\S+\s+([^\]]*)\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/'{2,}/g, "")
    .replace(/^=+\s*(.*?)\s*=+\s*$/gm, "【$1】")
    .replace(/^[*#:;]+\s*/gm, "・")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** 見出し (レベル2) が pattern に合う節の wikitext を返す。無ければ ""。 */
function sectionOf(wikitext, pattern) {
  const heads = [...wikitext.matchAll(/^==\s*([^=].*?)\s*==\s*$/gm)];
  for (let i = 0; i < heads.length; i++) {
    if (!pattern.test(heads[i][1])) continue;
    const from = heads[i].index + heads[i][0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : wikitext.length;
    return wikitext.slice(from, to);
  }
  return "";
}

// 近傍記事のうち旅の素材にならないもの (駅・学校・金融・役所・道路・廃止自治体・事件事故など)
const NEARBY_NOISE =
  /駅|停留場|信号場|学校|大学|幼稚園|保育|学園|郵便局|銀行|信用金庫|協同組合|消防|警察|放送|新聞|病院|役所|役場|庁舎|[市町村郡区]$|[市町村] \(|県道|国道|自動車道|インターチェンジ|バイパス|バス|ホテル|株式会社|工場|店$|団地|選挙区|事件|事故|災害|空襲|パチンコ|自衛隊|交番/;

/**
 * 駅の座標の近くにある Wikipedia 記事 (史跡・寺社・橋・港・酒蔵など) を近い順に返す。
 * 駅記事の「駅周辺」が銀行と学校だけ、という駅の素材を補う。記事名なのでそのままリンクにできる。
 * @param {{lat:number,lon:number}} station
 * @returns {Promise<{title:string,km:number}[]>}
 */
async function fetchNearby(station) {
  let data;
  try {
    data = await wikiQuery({
      action: "query",
      list: "geosearch",
      gscoord: `${station.lat}|${station.lon}`,
      gsradius: "2500",
      gslimit: "40",
    });
  } catch {
    return [];
  }
  return ((data.query && data.query.geosearch) || [])
    .filter((g) => !NEARBY_NOISE.test(g.title))
    .slice(0, 10)
    .map((g) => ({ title: g.title, km: Math.round(g.dist / 100) / 10 }));
}

/**
 * 同名駅の曖昧さ回避ページから、座標がいちばん近い駅記事を選ぶ。
 * @param {{wikitext:string}} page
 * @param {{name:string,lat:number,lon:number}} station
 */
async function resolveDisambig(page, station) {
  const candidates = extractLinkTitles(page.wikitext)
    .filter((t) => t.startsWith(`${station.name}駅`))
    .slice(0, 20);
  if (!candidates.length) return null;
  const pages = await fetchPages(candidates);
  let best = null;
  for (const pg of pages.values()) {
    if (pg.disambig || !pg.coord) continue;
    const d = distKm(station, pg.coord);
    if (d <= SAME_STATION_KM && (!best || d < best.d)) best = { pg, d };
  }
  return best ? best.pg : null;
}

/** 記事名のうち実在するものだけを返す (赤リンク除け)。リダイレクトは転送先の名前にする。 */
async function filterExistingTitles(titles) {
  const ok = new Set();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    let data;
    try {
      data = await wikiQuery({ action: "query", redirects: "1", titles: batch.join("|") });
    } catch {
      continue;
    }
    const q = data.query || {};
    const alias = new Map();
    for (const nz of q.normalized || []) alias.set(nz.from, nz.to);
    for (const rd of q.redirects || []) alias.set(rd.from, rd.to);
    const exists = new Set((q.pages || []).filter((p) => !p.missing && !p.invalid).map((p) => p.title));
    for (const orig of batch) {
      let canonical = orig;
      for (let hop = 0; hop < 3 && alias.has(canonical); hop++) canonical = alias.get(canonical);
      if (exists.has(canonical)) ok.add(orig);
    }
    if (i + 50 < titles.length) await sleep(300);
  }
  return ok;
}

/**
 * 路線と駅群のスポット素材を集める。
 * 駅記事はイントロだけだと「〜にある駅である」しか取れないので、「駅周辺」「歴史」節まで読む。
 * @param {{name:string, company:string}} line
 * @param {{name:string, lat?:number, lon?:number}[]} stations
 * @returns {Promise<{lineInfo:string|null, stationSpots:{name:string,info:string,around:string,history:string,links:string[],nearby:{title:string,km:number}[]}[]}>}
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
  // 車窓の素材: 路線記事に「沿線概況」節があれば足す (渡る川・見える山・地形が書いてある)
  const linePages = await fetchPages(lineTitles);
  for (const t of lineTitles) {
    const pg = linePages.get(t);
    const along = pg && !pg.disambig ? wikitextToPlain(sectionOf(pg.wikitext, /^沿線(概況|風景|概要)/)) : "";
    if (along) {
      lineInfo = `${lineInfo || ""}\n【沿線概況】\n${along.slice(0, 2500)}`.trim();
      break;
    }
  }

  // 駅記事: "<駅名>駅" で引き、同名駅は座標で照合する
  const stationTitles = stations.map((s) => `${s.name}駅`);
  const pages = await fetchPages([...new Set(stationTitles)]);
  const stationSpots = [];
  for (const s of stations) {
    let pg = pages.get(`${s.name}駅`) || null;
    const hasCoord = Number.isFinite(s.lat) && Number.isFinite(s.lon);
    if (pg && hasCoord) {
      const wrong = pg.disambig || (pg.coord && distKm(s, pg.coord) > SAME_STATION_KM);
      if (wrong) pg = pg.disambig ? await resolveDisambig(pg, s) : null;
    } else if (pg && pg.disambig) {
      pg = null;
    }
    const nearby = hasCoord ? await fetchNearby(s) : [];
    if (hasCoord) await sleep(150);
    if (!pg) {
      stationSpots.push({ name: s.name, info: "", around: "", history: "", links: [], nearby });
      continue;
    }
    const aroundWiki = sectionOf(pg.wikitext, /^(駅)?周辺/);
    stationSpots.push({
      name: s.name,
      info: pg.intro,
      around: wikitextToPlain(aroundWiki),
      history: wikitextToPlain(sectionOf(pg.wikitext, /^(歴史|沿革)/)),
      links: extractLinkTitles(aroundWiki),
      nearby,
    });
  }

  // 周辺節のリンク先のうち、実在する記事だけを「確実にリンクできる語」として残す
  const allLinks = [...new Set(stationSpots.flatMap((sp) => sp.links))];
  const existing = await filterExistingTitles(allLinks);
  for (const sp of stationSpots) sp.links = sp.links.filter((t) => existing.has(t)).slice(0, 15);

  return { lineInfo, stationSpots };
}
