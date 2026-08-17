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
  let linesCache = null, genES = null, genSettled = false;

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
    let ov;
    try { ov = await fetchJson("/trips/overview.json"); }
    catch { ov = { stats: { trips: 0, lines: 0, km: 0 }, trips: [] }; }

    const hmap = L.map("homeMap", { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors (ODbL) / 駅位置: 駅データ.jp", maxZoom: 18,
    }).addTo(hmap);

    const layers = [];
    for (const t of ov.trips) {
      if (!t.track || t.track.length < 2) continue;
      // 白いケーシング(ふち)を敷いてから濃い紫の本線 → OSMの赤系(道路/鉄道)と紛れず、
      // 明るい土地でも暗い地物の上でも浮いて見える。
      L.polyline(t.track, { color: "#ffffff", weight: 6, opacity: 0.9 }).addTo(hmap);
      const pl = L.polyline(t.track, { color: "#6d28d9", weight: 3.5, opacity: 1 }).addTo(hmap);
      const emoji = t.persona ? t.persona.emoji : "🚃";
      pl.bindTooltip(`<span class="home-line-tip">${emoji} <b>${t.line.name}</b><br>${t.date}</span>`, { sticky: true });
      pl.on("click", () => { location.href = t.url; });
      layers.push(pl);
    }
    if (layers.length) {
      const grp = L.featureGroup(layers);
      hmap.fitBounds(grp.getBounds(), { padding: [30, 30] });
      requestAnimationFrame(() => { hmap.invalidateSize(); hmap.fitBounds(grp.getBounds(), { padding: [30, 30] }); });
    } else {
      hmap.setView([37.5, 137.5], 5); // 日本全体
    }

    $("homeStats").innerHTML =
      `<div class="stat"><div class="num">${ov.stats.trips}</div><div class="lbl">便</div></div>` +
      `<div class="stat"><div class="num">${ov.stats.lines}</div><div class="lbl">路線</div></div>` +
      `<div class="stat"><div class="num">${Math.round(ov.stats.km)}</div><div class="lbl">累計km</div></div>` +
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
    $("homeCredit").textContent = "駅位置: 駅データ.jp / 線形: © OpenStreetMap contributors (ODbL)";

    if (canGenerate) $("homePickBtn").classList.remove("hidden");
    $("homePickBtn").onclick = openPicker;

    $("loading").classList.add("hidden");
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
    setupArchive();
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
      card.scrollIntoView({ behavior: "smooth", block: "end" });
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
    $("archiveBtn").onclick = () => $("archiveSheet").classList.remove("hidden");
    $("archiveClose").onclick = () => $("archiveSheet").classList.add("hidden");
    $("archiveSheet").onclick = (e) => { if (e.target.id === "archiveSheet") $("archiveSheet").classList.add("hidden"); };
  }

  function shareTarget() {
    const path = trip.meta && trip.meta.on_demand ? `/l/${trip.line.line_cd}` : `/trips/${trip.date}`;
    return {
      url: location.origin + path,
      text: `${trip.persona.emoji} 分身${trip.persona.name}の旅日記 — ${trip.line.name}`,
    };
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

  // ---- アーカイブ (連載一覧) ----
  async function setupArchive() {
    let idx = [];
    try { idx = await (await fetch("/trips/index.json")).json(); } catch { /* ignore */ }
    const ul = $("archiveList");
    ul.innerHTML = "";
    for (const it of idx) {
      const li = document.createElement("li");
      const cur = it.date === trip.date ? " current" : "";
      li.innerHTML =
        `<a href="/trips/${it.date}" class="acard${cur}">` +
        `<span class="a-date">${it.date}</span>` +
        `<span class="a-emoji">${it.persona ? it.persona.emoji : "🚃"}</span>` +
        `<span><span class="a-line">${it.line || ""}</span> ` +
        `<span class="a-co">${it.company || ""}</span></span></a>`;
      ul.appendChild(li);
    }
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
