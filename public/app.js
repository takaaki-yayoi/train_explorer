// 分身の旅日記 ビューア本体。trip JSON を読み込み、Leaflet 地図 + 日記フィードを描く。
// 参照実装の弧長ベース移動 (cum / latLngAt / project) を踏襲。

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ---- URL からルートを判定する ----
  // /trips/<date> = 連載の便 / /l/<line_cd> = 路線指定の便 / それ以外 = 最新便
  function parseRoute() {
    let m = location.pathname.match(/\/trips\/(\d{4}-\d{2}-\d{2})/);
    if (m) return { kind: "date", date: m[1] };
    m = location.pathname.match(/^\/l\/(\d+)/);
    if (m) return { kind: "line", cd: Number(m[1]) };
    const q = new URLSearchParams(location.search).get("date");
    if (q) return { kind: "date", date: q };
    return { kind: "home" };
  }

  // ---- ジオメトリ (参照実装と同じ) ----
  const R = 6371, toR = (x) => (x * Math.PI) / 180;
  function havP(a, b) {
    const dLat = toR(b[0] - a[0]), dLon = toR(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  let map, line, track, cum, TOTAL, stMarkers = [], avatar, sPos = [], trip;
  let baseLayers = {};
  let linesCache = null, genES = null, genSettled = false, shareCtx = null;

  async function boot() {
    // 生成バックエンド (ローカル Node) があれば 🚃 を有効化する。静的ホストでは無効。
    await detectCapabilities();
    initChrome();
    const route = parseRoute();
    try {
      if (route.kind === "home") { showView("home"); await renderHome(); }
      else if (route.kind === "date") { showView("trip"); await loadStatic(`/trips/${route.date}.json`); }
      else if (route.kind === "line") { showView("trip"); await loadLine(route.cd); }
    } catch {
      $("loading").classList.remove("hidden");
      $("loading").textContent = "読み込みに失敗しました。";
    }
  }

  // トップ (全国マップ) と 個別ビューア を切り替える
  function showView(which) {
    $("homeView").classList.toggle("hidden", which !== "home");
    $("app").classList.toggle("hidden", which !== "trip");
  }

  // ---- トップ: 日本全国カバレッジマップ ----
  async function renderHome() {
    document.title = "分身の旅日記 — 日本全国の旅";
    shareCtx = {
      url: location.origin + "/",
      text: "分身の旅日記 — 分身が日本の実在の鉄道を旅して、毎朝あなたに日記を届ける",
    };
    let ov;
    try { ov = await fetchJson("/trips/overview.json"); }
    catch { ov = { stats: { trips: 0, lines: 0, km: 0 }, trips: [] }; }

    const hmap = L.map("homeMap", { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors (ODbL) / 駅位置: 駅データ.jp", maxZoom: 18,
    }).addTo(hmap);

    const layers = [], live = [];
    for (const t of ov.trips) {
      if (!t.track || t.track.length < 2) continue;
      // 白いケーシング(ふち)を敷いてから紫の本線 → OSMの赤系(道路/鉄道)と紛れず、
      // 明るい土地でも暗い地物の上でも浮いて見える。
      // 本線は薄く敷いておき、分身が通った区間だけを濃い線で上書きする (尾を引く)。
      L.polyline(t.track, { color: "#ffffff", weight: 6, opacity: 0.9 }).addTo(hmap);
      const pl = L.polyline(t.track, { color: "#6d28d9", weight: 3.5, opacity: 0.32 }).addTo(hmap);
      const trail = L.polyline([], { color: "#6d28d9", weight: 3.5, opacity: 1 }).addTo(hmap);
      const emoji = t.persona ? t.persona.emoji : "🚃";
      pl.bindTooltip(`<span class="home-line-tip">${emoji} <b>${t.line.name}</b><br>${t.date}</span>`, { sticky: true });
      pl.on("click", () => { location.href = t.url; });
      layers.push(pl);
      live.push({ t, trail, emoji });
    }
    let bounds = null;
    if (layers.length) {
      bounds = L.featureGroup(layers).getBounds();
      hmap.fitBounds(bounds, { padding: [30, 30] });
      requestAnimationFrame(() => { hmap.invalidateSize(); hmap.fitBounds(bounds, { padding: [30, 30] }); });
    } else {
      hmap.setView([37.5, 137.5], 5); // 日本全体
    }
    startHomeLive(hmap, live);
    setupHomeFullscreen(hmap, bounds);

    $("homeStats").innerHTML =
      `<div class="stat"><div class="num">${ov.stats.trips}<small>本</small></div><div class="lbl">旅の記録</div></div>` +
      `<div class="stat"><div class="num">${ov.stats.lines}<small>路線</small></div><div class="lbl">踏破した路線</div></div>` +
      `<div class="stat"><div class="num">${Math.round(ov.stats.km)}<small>km</small></div><div class="lbl">累計の距離</div></div>` +
      `<div class="cov">日本の鉄道 約610路線を、分身が少しずつ旅していきます</div>`;

    const t0 = ov.trips[0];
    if (t0 && t0.teaser) {
      const tz = $("homeTeaser");
      tz.href = t0.url;
      tz.innerHTML =
        `<span class="tq">「</span>${t0.teaser}<span class="tq">」</span>` +
        `<span class="tmore">${t0.persona ? t0.persona.emoji + " " : ""}今朝の便を読む →</span>`;
      tz.classList.remove("hidden");
    }

    if (t0) $("todayBtn").href = t0.url;
    else $("todayBtn").classList.add("hidden");

    const ul = $("homeList");
    ul.innerHTML = "";
    for (const t of ov.trips) {
      const li = document.createElement("li");
      li.innerHTML =
        `<a href="${t.url}"><span class="h-date">${t.date}</span>` +
        `<span class="h-emoji">${t.persona ? t.persona.emoji : "🚃"}</span>` +
        `<span><span class="h-line">${t.line.name}</span> <span class="h-co">${t.line.company}</span></span></a>`;
      ul.appendChild(li);
    }
    if (canGenerate) $("homePickBtn").classList.remove("hidden");
    $("homePickBtn").onclick = openPicker;

    $("loading").classList.add("hidden");
  }

  // ---- トップの全国マップを"生きている"状態にする ----
  // 厳密なリアルタイムではなく仮想ダイヤ。壁時計を CYCLE 秒で割った位相から位置を決めるので、
  // サーバに状態を持たなくても「誰がいつ開いても同じ絵」「開くたびに違う場所にいる」が両立する。
  const LIVE = {
    CYCLE: 300,  // 1周 = 5分。全便がこの周期のなかを往復する。
                 // 長くすると国スケールでは動きが見えなくなる (40kmの路線は全国表示で10px弱しかない)
    RUN: 0.40,   // 片道にかける割合。残り (0.5 - RUN) は終点/始点での小休止 (= 吹き出しを出す時間)
    MAX: 40,     // 同時に動かす分身の上限。超えた便は線だけ (DOMマーカーが増えると重くなる)
    GAP_X: 205,  // 吹き出し同士の最小間隔 (px)。吹き出しの幅(最大200px)より広くとる
    GAP_Y: 100,  // 上下にずれていれば横が近くても重ならない (45字は実測で高さ90px)
    FLIP: 110,   // 地図の上端からこの距離より近い分身は、吹き出しを下向きに出す (高さ90px + 余白)
    CHARS: 45,   // 吹き出しに載せる字数。30字だと一節の面白い後半が毎回落ちていた
    BUBBLES: 2,  // 同時に出す吹き出しの数
    BOB: 2.6,    // 待機中の揺れの周期(秒)。style.css の avatar-bob と揃える
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

  // 位相(0..1) → 進捗(0..1)。往復させるので、周回の切れ目で始点に瞬間移動しない。
  // 折り返しで止まっている間 (rest) に、その便の日記の一節を吹き出しで出す。
  // 終点だけだと全便あわせても喋っていない時間が6割を占めるので、始点でも喋らせる。
  // rest はどちら側で止まっているかを返す。居る場所と喋る内容を合わせるため。
  function shuttle(phase) {
    const r = LIVE.RUN;
    if (phase < r) return { u: easeInOut(phase / r), rest: null };
    if (phase < 0.5) return { u: 1, rest: "end" };            // 終点で一息
    if (phase < 0.5 + r) return { u: easeInOut(1 - (phase - 0.5) / r), rest: null };
    return { u: 0, rest: "start" };                           // 始点に戻ってまた一息
  }

  // 便ごとの発車位相。等間隔だと機械的に見えるので、日付+路線から決定的に少し揺らす。
  function phaseOffset(t, i, n) {
    const key = `${t.date}/${t.line.line_cd}`;
    let h = 2166136261;
    for (let k = 0; k < key.length; k++) { h ^= key.charCodeAt(k); h = Math.imul(h, 16777619); }
    return (i / n + ((h >>> 0) / 4294967296) * (0.8 / n)) % 1;
  }

  // 弧長テーブルと弧長→座標の補間 (個別ビューアの cum / latLngAt をトップ用に切り出したもの)
  function arcTable(track) {
    const cum = [0];
    for (let i = 1; i < track.length; i++) cum[i] = cum[i - 1] + havP(track[i - 1], track[i]);
    return cum;
  }
  function arcPoint(track, cum, s) {
    s = Math.max(0, Math.min(cum[cum.length - 1], s));
    let lo = 0, hi = track.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo] || 1e-12, u = (s - cum[lo]) / seg;
    return [track[lo][0] + (track[hi][0] - track[lo][0]) * u, track[lo][1] + (track[hi][1] - track[lo][1]) * u];
  }
  // 始点から現在地までの経路 (尾)
  function arcUpTo(track, cum, s, here) {
    const out = [];
    for (let i = 0; i < track.length && cum[i] <= s; i++) out.push(track[i]);
    out.push(here);
    return out;
  }

  function startHomeLive(hmap, live) {
    if (!live.length) return;
    const movers = live.slice(0, LIVE.MAX);
    const n = movers.length;

    for (let i = 0; i < n; i++) {
      const m = movers[i];
      m.cum = arcTable(m.t.track);
      m.total = m.cum[m.cum.length - 1];
      m.off = phaseOffset(m.t, i, n);
      m.shown = false;
      const who = m.t.persona ? `${m.t.persona.name} — ` : "";
      m.marker = L.marker(m.t.track[0], {
        icon: L.divIcon({
          html: `<div title="${esc(who + m.t.line.name)}">${m.emoji}</div>`,
          className: "home-avatar", iconSize: [26, 26], iconAnchor: [13, 13],
        }),
        zIndexOffset: 1000, keyboard: false,
      }).addTo(hmap);
      m.marker.on("click", () => { location.href = m.t.url; });
      // 待機中の揺れが全員そろうと不自然なので、発車位相ぶんだけずらす
      const bob = m.marker.getElement() && m.marker.getElement().firstChild;
      if (bob) bob.style.animationDelay = `${-(m.off * LIVE.BOB).toFixed(2)}s`;
      // 始点では出発の一節、終点では終着の一節。日記の1件目は必ず「出発点の紹介」なので、
      // 終点にいるのに出発の話をしていると噛み合わない。
      const say = (t) => (t ? `${m.emoji}「${esc(clip(t, LIVE.CHARS))}」` : null);
      const start = say(m.t.teaser), end = say(m.t.teaserEnd);
      if (start || end) {
        // 片方しか持たない overview (旧データ) は、両端で同じ一節を出す
        m.says = { start: start || end, end: end || start };
        m.side = null;
        m.bubble = L.tooltip({
          permanent: true, direction: "top", offset: [0, -15],
          className: "home-bubble", interactive: false,
        });
      }
    }

    // 引いているときは絵文字を小さく (国スケールで団子にならないように)
    const zoomClass = () => hmap.getContainer().classList.toggle("z-far", hmap.getZoom() < 8);
    hmap.on("zoomend", zoomClass);
    zoomClass();

    // 動きを減らす設定なら、走破済みの静止画にして以降は何もしない。
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const m of movers) {
        m.trail.setLatLngs(m.t.track);
        m.marker.setLatLng(m.t.track[m.t.track.length - 1]);
      }
      return;
    }

    function frame() {
      const now = Date.now() / 1000;
      for (const m of movers) {
        const phase = ((now / LIVE.CYCLE + m.off) % 1 + 1) % 1;
        const st = shuttle(phase);
        m.pt = arcPoint(m.t.track, m.cum, st.u * m.total);
        m.rest = st.rest;
        m.marker.setLatLng(m.pt);
        m.trail.setLatLngs(arcUpTo(m.t.track, m.cum, st.u * m.total, m.pt));
      }
      // 吹き出しは重なると読めないので、間隔をあけて数を絞る。
      // 既に出ているものを先に処理して、点滅しないようにする。
      const open = [];
      for (const pass of [1, 2]) {
        for (const m of movers) {
          if (!m.bubble) continue;
          if (pass === 1 ? !m.shown : m.shown) continue;
          if (m.rest && open.length < LIVE.BUBBLES) {
            const cp = hmap.latLngToContainerPoint(m.pt);
            // 吹き出しは分身の真上に出る横長の矩形なので、距離ではなく重なりで判定する
            const clear = open.every((p) =>
              Math.abs(p.x - cp.x) > LIVE.GAP_X || Math.abs(p.y - cp.y) > LIVE.GAP_Y);
            if (clear) {
              // 地図の上端に近いと吹き出しが枠で切れるので、その便だけ下向きに出す
              const down = cp.y < LIVE.FLIP;
              m.bubble.options.direction = down ? "bottom" : "top";
              m.bubble.options.offset = down ? [0, 15] : [0, -15];
              if (m.side !== m.rest) { m.bubble.setContent(m.says[m.rest]); m.side = m.rest; }
              m.bubble.setLatLng(m.pt);
              if (!m.shown) { m.bubble.addTo(hmap); m.shown = true; }
              open.push(cp);
              continue;
            }
          }
          if (m.shown) { hmap.removeLayer(m.bubble); m.shown = false; }
        }
      }
    }

    // 地図が画面に入っていて、タブも見えている間だけ動かす。
    // (トップの主役は「今朝の便を読む」なので、ヒーローを見ている間は静かにしておく)
    let raf = null, visible = false, awake = !document.hidden;
    const tick = () => { frame(); raf = requestAnimationFrame(tick); };
    const sync = () => {
      const on = visible && awake;
      if (on && raf === null) raf = requestAnimationFrame(tick);
      else if (!on && raf !== null) { cancelAnimationFrame(raf); raf = null; }
    };
    frame(); // 初期位置は最初から時計に合わせておく
    document.addEventListener("visibilitychange", () => { awake = !document.hidden; sync(); });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(
        (es) => { visible = es[0].isIntersecting; sync(); },
        { threshold: 0.15 }
      ).observe($("homeMap"));
    } else { visible = true; sync(); }
  }

  // 全画面表示。専用ページではなく同じ地図を広げるだけなので、データもルートも増えない。
  function setupHomeFullscreen(hmap, bounds) {
    const sec = $("coverage"), btn = $("mapFullBtn");
    if (!sec || !btn) return;
    const set = (on) => {
      sec.classList.toggle("is-full", on);
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = on ? "✕ 閉じる" : "⤢ 全画面で見る";
      // 器の大きさが変わるので、地図の再計測と日本全体への再フィットをやり直す
      const refit = () => {
        hmap.invalidateSize();
        if (bounds) hmap.fitBounds(bounds, { padding: [30, 30] });
      };
      refit();
      setTimeout(refit, 250);
    };
    btn.addEventListener("click", () => set(!sec.classList.contains("is-full")));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sec.classList.contains("is-full")) set(false);
    });
  }

  // データは静的ファイル (trips/*.json) を直読み。ローカル Node でも静的ホストでも同じパス。
  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.json();
  }
  async function loadStatic(url) {
    const data = await fetchJson(url);
    setTrip(data.trip || data);
    $("loading").classList.add("hidden");
  }
  async function loadLine(cd) {
    try {
      await loadStatic(`/trips/lines/${cd}.json`);
    } catch {
      // 未生成: ローカル(生成可)ならその場で巡らせる。静的ホストなら案内を出す。
      if (canGenerate) { $("loading").classList.add("hidden"); startGeneration(cd); }
      else {
        $("loading").classList.remove("hidden");
        $("loading").innerHTML = 'この路線の旅はまだありません。<br><a href="/" style="color:inherit">最新の便を見る</a>';
      }
    }
  }

  let canGenerate = false;
  async function detectCapabilities() {
    try {
      const r = await fetch("/api/capabilities");
      if (r.ok) canGenerate = !!(await r.json()).generate;
    } catch { canGenerate = false; }
    if (canGenerate) $("pickBtn").classList.remove("hidden");
  }

  // trip を受け取り、URL を正規化して描画する
  function setTrip(t) {
    trip = t;
    const want = trip.meta && trip.meta.on_demand ? `/l/${trip.line.line_cd}` : `/trips/${trip.date}`;
    if (location.pathname !== want) history.replaceState(null, "", want);
    shareCtx = {
      url: location.origin + want,
      text: `${trip.persona.emoji} 分身${trip.persona.name}の旅日記 — ${trip.line.name}`,
    };
    render();
  }

  function render() {
    track = trip.track;
    // 累積距離
    cum = [0];
    for (let i = 1; i < track.length; i++) cum[i] = cum[i - 1] + havP(track[i - 1], track[i]);
    TOTAL = cum[cum.length - 1];

    setupMap();
    setupStations();
    setupHeader();
    resetFeed();
    wireControls();
  }

  // ---- 地図 ----
  function setupMap() {
    if (map) { map.remove(); stMarkers = []; }
    map = L.map("map", { zoomControl: true });
    const credit = "&copy; OpenStreetMap contributors (ODbL) / 駅位置: 駅データ.jp";
    baseLayers.osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: credit, maxZoom: 19,
    });
    // 地理院タイル 航空写真 (キー不要)
    baseLayers.photo = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", {
      attribution: credit + " / 地理院タイル", maxZoom: 18,
    });
    baseLayers.osm.addTo(map);

    line = L.polyline(track, { color: "#2c3a47", weight: 4, opacity: 0.7 }).addTo(map);
    fitLine();
    // フレックスレイアウト確定前だとコンテナ寸法が読めず fitBounds がずれるため、
    // 描画確定後にサイズを再計算してもう一度フィットする。
    requestAnimationFrame(() => { map.invalidateSize(); fitLine(); });

    addTileToggle();
  }

  function fitLine() {
    if (line) map.fitBounds(line.getBounds(), { padding: [30, 30] });
  }

  function addTileToggle() {
    const Ctrl = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const div = L.DomUtil.create("div", "tile-toggle");
        div.innerHTML =
          '<button data-l="osm" class="on">地図</button><button data-l="photo">航空写真</button>';
        L.DomEvent.disableClickPropagation(div);
        div.addEventListener("click", (e) => {
          const b = e.target.closest("button");
          if (!b) return;
          const which = b.dataset.l;
          for (const k of Object.keys(baseLayers)) map.removeLayer(baseLayers[k]);
          baseLayers[which].addTo(map);
          line.bringToFront();
          div.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.l === which));
        });
        return div;
      },
    });
    map.addControl(new Ctrl());
  }

  // 駅を線形上に射影して弧長位置を得る (参照 project)
  function project(st) {
    const cosLat = Math.cos(toR(st.lat));
    let bestD = Infinity, bestS = 0;
    for (let i = 0; i < track.length - 1; i++) {
      const ax = track[i][1] * cosLat, ay = track[i][0];
      const bx = track[i + 1][1] * cosLat, by = track[i + 1][0];
      const px = st.lon * cosLat, py = st.lat;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
      let u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
      if (d < bestD) { bestD = d; bestS = cum[i] + u * (cum[i + 1] - cum[i]); }
    }
    return bestS;
  }
  // 弧長 → 座標 (参照 latLngAt)
  function latLngAt(s) {
    s = Math.max(0, Math.min(TOTAL, s));
    let lo = 0, hi = track.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo] || 1e-12, u = (s - cum[lo]) / seg;
    return [track[lo][0] + (track[hi][0] - track[lo][0]) * u, track[lo][1] + (track[hi][1] - track[lo][1]) * u];
  }

  function setupStations() {
    sPos = trip.stations.map(project);
    stMarkers = trip.stations.map((s, i) =>
      L.circleMarker(latLngAt(sPos[i]), {
        radius: 5, color: "#2c3a47", weight: 2, fillColor: "#fff", fillOpacity: 1,
      }).addTo(map).bindTooltip(s.name)
    );
    const icon = L.divIcon({
      html: `<div>${trip.persona.emoji}</div>`,
      className: "avatar-icon", iconSize: [30, 30], iconAnchor: [15, 15],
    });
    avatar = L.marker(latLngAt(sPos[diaryStart()]), { icon, zIndexOffset: 1000 }).addTo(map);
  }

  function diaryStart() {
    return trip.diary.length ? trip.diary[0].st : 0;
  }

  // ---- ヘッダ ----
  function setupHeader() {
    const p = trip.persona;
    document.title = `${p.emoji} ${p.name}の旅日記 — ${trip.line.name}`;
    $("title").textContent = `${p.emoji} 分身${p.name}の旅日記`;
    const first = trip.stations[0].name;
    const last = trip.stations[trip.stations.length - 1].name;
    const d = fmtDate(trip.date);
    $("sub").innerHTML =
      `${trip.line.name} (${trip.line.company}) ${first} → ${last} 約${trip.line.km ?? "?"}km<br>` +
      `${d}${trip.weather ? " " + trip.weather : ""} / ${p.traits}`;
    $("credit").textContent = "駅位置: 駅データ.jp / 線形: © OpenStreetMap contributors (ODbL) / 航空写真: 地理院タイル";
    $("fin").textContent = `— この便はここまで。${p.name}はまた次の路線へ —`;
  }

  function fmtDate(s) {
    const [y, m, d] = s.split("-").map(Number);
    const wd = ["日", "月", "火", "水", "木", "金", "土"][new Date(y, m - 1, d).getDay()];
    return `${y}年${m}月${d}日 (${wd})`;
  }

  // ---- 日記カード ----
  function makeCard(e, i) {
    const div = document.createElement("div");
    div.className = "card " + e.type;
    div.dataset.i = i;
    const stName = trip.stations[e.st].name;
    const stLink =
      `<a href="https://ja.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(stName + "駅")}" ` +
      `target="_blank" rel="noopener" onclick="event.stopPropagation()">${stName}</a>`;
    div.innerHTML =
      `<div class="meta"><span class="time">${e.t || ""}</span><span class="st">${stLink}</span>` +
      `<span class="tag">${e.type === "stop" ? "途中下車" : "車窓から"}</span></div><p>${e.text}</p>`;
    div.onclick = () => focusEntry(i);
    return div;
  }

  function highlight(i) {
    document.querySelectorAll(".card").forEach((c) => c.classList.toggle("active", +c.dataset.i === i));
    const e = trip.diary[i];
    stMarkers[e.st].setStyle({ fillColor: e.type === "stop" ? "#e8657c" : "#c8d1c0" });
  }

  // ---- 再生制御 ----
  let shownCount = 0, playing = false, animId = null, curArc = 0;

  function resetFeed() {
    shownCount = 0; playing = false;
    if (animId) cancelAnimationFrame(animId);
    curArc = sPos[diaryStart()];
    $("diary").innerHTML = "";
    $("fin").style.display = "none";
    $("playBtn").textContent = "▶ 旅を再生";
    stMarkers.forEach((m) => m.setStyle({ fillColor: "#fff" }));
    if (avatar) avatar.setLatLng(latLngAt(curArc));
  }

  function focusEntry(i) {
    stopPlay();
    curArc = sPos[trip.diary[i].st];
    const pt = latLngAt(curArc);
    avatar.setLatLng(pt); map.panTo(pt);
    highlight(i);
  }

  function moveAvatarTo(targetArc, done) {
    const startArc = curArc, delta = targetArc - startArc;
    const dur = Math.min(3000, 500 + Math.abs(delta) * 400);
    const t0 = performance.now();
    function step(now) {
      const u = Math.min(1, (now - t0) / dur);
      const ease = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      const pt = latLngAt(startArc + delta * ease);
      avatar.setLatLng(pt); map.panTo(pt, { animate: false });
      if (u < 1 && playing) animId = requestAnimationFrame(step);
      else { curArc = targetArc; if (playing) done(); }
    }
    animId = requestAnimationFrame(step);
  }

  function playNext() {
    if (shownCount >= trip.diary.length) { finish(); return; }
    const i = shownCount, e = trip.diary[i];
    moveAvatarTo(sPos[e.st], () => {
      const card = makeCard(e, i);
      $("diary").appendChild(card);
      requestAnimationFrame(() => card.classList.add("shown"));
      // scrollIntoView はスクロール可能な祖先をすべて動かすので、スマホでページごと
      // 引っ張られる。新着カードは常に最下端なので、#diary の中だけを送る。
      const feed = $("diary");
      feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
      highlight(i);
      shownCount++;
      setTimeout(() => { if (playing) playNext(); }, e.type === "stop" ? 3200 : 1600);
    });
  }

  function finish() {
    stopPlay();
    $("fin").style.display = "block";
    $("playBtn").textContent = "↺ 最初から";
    shownCount = 0;
  }
  function stopPlay() {
    playing = false;
    if (animId) cancelAnimationFrame(animId);
    $("playBtn").textContent = shownCount === 0 ? "▶ 旅を再生" : "▶ 続きを再生";
  }

  function wireControls() {
    $("playBtn").onclick = () => {
      if (playing) { stopPlay(); return; }
      if (shownCount === 0) {
        $("diary").innerHTML = ""; $("fin").style.display = "none";
        stMarkers.forEach((m) => m.setStyle({ fillColor: "#fff" }));
        curArc = sPos[diaryStart()];
        avatar.setLatLng(latLngAt(curArc));
        map.setZoom(Math.max(map.getZoom(), 13));
      }
      playing = true;
      $("playBtn").textContent = "⏸ ひと休み";
      playNext();
    };
    $("allBtn").onclick = () => {
      stopPlay();
      $("diary").innerHTML = "";
      trip.diary.forEach((e, i) => {
        const card = makeCard(e, i);
        $("diary").appendChild(card);
        requestAnimationFrame(() => card.classList.add("shown"));
        stMarkers[e.st].setStyle({ fillColor: e.type === "stop" ? "#e8657c" : "#c8d1c0" });
      });
      $("fin").style.display = "block";
      $("playBtn").textContent = "↺ 最初から";
      shownCount = 0;
      map.fitBounds(line.getBounds(), { padding: [30, 30] });
      $("diary").scrollTop = 0;
    };
    $("shareBtn").onclick = openShareSheet;
  }

  function shareTarget() {
    return shareCtx || { url: location.origin + "/", text: "分身の旅日記 — 分身が日本の鉄道を旅する" };
  }
  function openShareSheet() { $("shareSheet").classList.remove("hidden"); }
  function closeShareSheet() { $("shareSheet").classList.add("hidden"); }
  function openShareNet(net) {
    const { url, text } = shareTarget();
    const u = encodeURIComponent(url), t = encodeURIComponent(text);
    let href = null;
    if (net === "x") href = `https://twitter.com/intent/tweet?text=${t}&url=${u}`;
    else if (net === "line") href = `https://social-plugins.line.me/lineit/share?url=${u}`;
    else if (net === "fb") href = `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    if (href) {
      window.open(href, "_blank", "noopener,noreferrer,width=600,height=640");
      closeShareSheet();
      return;
    }
    if (net === "copy") copyLink(url);
  }
  async function copyLink(url) {
    try { await navigator.clipboard.writeText(url); toast("リンクをコピーしました"); }
    catch { prompt("このリンクを共有:", url); }
    closeShareSheet();
  }
  let _toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
  }


  // ---- 路線ピッカー + オンデマンド生成 ----
  // 常時ある UI (ピッカー・生成オーバーレイ) を一度だけ配線する。
  function initChrome() {
    $("pickBtn").onclick = openPicker;
    $("pickClose").onclick = closePicker;
    $("pickSheet").onclick = (e) => { if (e.target.id === "pickSheet") closePicker(); };
    $("pickInput").oninput = () => renderPickList($("pickInput").value.trim());
    $("genCancel").onclick = closeGen;
    // 共有シート
    $("homeShareBtn").onclick = openShareSheet;
    $("shareClose").onclick = closeShareSheet;
    $("shareSheet").onclick = (e) => { if (e.target.id === "shareSheet") closeShareSheet(); };
    document.querySelectorAll(".share-btn").forEach((b) => { b.onclick = () => openShareNet(b.dataset.net); });
  }

  async function openPicker() {
    $("pickSheet").classList.remove("hidden");
    if (!linesCache) {
      $("pickList").innerHTML = '<li class="pick-msg">読み込み中…</li>';
      try { linesCache = await (await fetch("/api/lines")).json(); }
      catch { linesCache = []; }
    }
    renderPickList($("pickInput").value.trim());
    $("pickInput").focus();
  }
  function closePicker() { $("pickSheet").classList.add("hidden"); }

  function renderPickList(filter) {
    const ul = $("pickList");
    let items = linesCache || [];
    if (filter) items = items.filter((l) => l.name.includes(filter) || l.company.includes(filter));
    const shown = items.slice(0, 300);
    ul.innerHTML = "";
    if (!shown.length) { ul.innerHTML = '<li class="pick-msg">該当する路線がありません</li>'; return; }
    for (const l of shown) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.innerHTML =
        `<span class="p-line">${l.name}</span> <span class="p-co">${l.company}</span>` +
        `<span class="p-n">${l.stationCount}駅</span>`;
      b.onclick = () => { closePicker(); startGeneration(l.line_cd, l); };
      li.appendChild(b);
      ul.appendChild(li);
    }
    if (items.length > shown.length) {
      const li = document.createElement("li");
      li.className = "pick-msg";
      li.textContent = `ほか ${items.length - shown.length} 件… 絞り込んでください`;
      ul.appendChild(li);
    }
  }

  // 路線を巡って生成する (SSE で進捗を受け取り、完成したら描画)
  function startGeneration(cd, meta) {
    genSettled = false;
    const ov = $("genOverlay");
    ov.classList.remove("hidden");
    $("genEmoji").textContent = "🚃";
    $("genLine").textContent = meta ? `${meta.name} (${meta.company})` : `路線 ${cd}`;
    $("genMsg").textContent = "準備しています…";
    $("genSteps").innerHTML = "";

    if (genES) genES.close();
    genES = new EventSource(`/api/lines/${cd}/generate`);

    genES.addEventListener("progress", (e) => {
      const d = JSON.parse(e.data);
      $("genMsg").textContent = d.msg;
      addStep(d.msg);
    });
    genES.addEventListener("done", (e) => {
      if (genSettled) return;
      genSettled = true;
      const d = JSON.parse(e.data);
      genES.close(); genES = null;
      closeGen();
      setTrip(d.trip);
    });
    // SSE の error: サーバ送信の named error (data あり) と接続断 (data なし) の両方が来る
    genES.addEventListener("error", (e) => {
      if (genSettled) return;
      if (e && e.data) {
        let msg = "生成に失敗しました。";
        try { msg = JSON.parse(e.data).error || msg; } catch { /* ignore */ }
        failGen(msg);
      } else if (genES && genES.readyState === 2) {
        failGen("接続が切れました。時間をおいて再度お試しください。");
      }
    });
  }

  function failGen(msg) {
    if (genSettled) return;
    genSettled = true;
    if (genES) { genES.close(); genES = null; }
    $("genEmoji").textContent = "⚠️";
    $("genMsg").textContent = "";
    addStep(msg, true);
  }
  function addStep(msg, err) {
    const div = document.createElement("div");
    if (err) div.className = "err";
    div.textContent = (err ? "" : "• ") + msg;
    $("genSteps").appendChild(div);
    $("genSteps").scrollTop = $("genSteps").scrollHeight;
  }
  function closeGen() {
    $("genOverlay").classList.add("hidden");
    if (genES) { genES.close(); genES = null; }
  }

  // ---- Service Worker は廃止 (v1) ----
  // 以前登録された SW がナビゲーションを壊すため、登録はせず、残っていれば解除する。
  // (壊れて真っ白になったブラウザは sw.js のキルスイッチ側でも自動回復する)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister()))
      .catch(() => {});
  }

  boot();
})();
