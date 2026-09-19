/* FLOODLIGHT ward instrument — client.
   One SSE stream in, one render pass out. No framework, no build step.
   Modes: REPLAY (storm library over any pilot area) and LIVE CITY
   (real 15-minutely rainfall via Open-Meteo, same hydrology).
   Weather is drawn, not just numbered: rain particles over the map,
   flow-lines on flooding streets. */

const state = {
  meta: null,
  snap: null,
  live: null,                   // /api/live payload
  mode: "replay",               // "replay" | "live"
  lang: "mr",
  running: false,
  focusSeg: null,
  layers: {},                   // segment id → {under, core, flow}
  drainMarkers: {},
  sensorMarker: null,
  renderedFeed: new Set(),
  feedUnseen: 0,
  activeTab: "status",
  hintsOn: true,
  mapHintDone: false,
  liveTimer: null,
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- map */

const map = L.map("map", {
  zoomControl: false, attributionControl: true, minZoom: 13, maxZoom: 18,
}).setView([19.0135, 72.8447], 15);

L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  className: "dark-tiles",
  maxZoom: 19,
}).addTo(map);

function fixMapSize() { map.invalidateSize({ animate: false }); }
window.addEventListener("resize", fixMapSize);
window.addEventListener("load", () => { fixMapSize(); setTimeout(fixMapSize, 250); setTimeout(fixMapSize, 900); });
setTimeout(fixMapSize, 60);

const SEG_STYLES = {
  ok:      { core: ["#3e4a52", 0.9, 3.0] },
  watch:   { core: ["#e0a83c", 1.0, 4.5] },
  alert:   { core: ["#e4574c", 1.0, 5.0] },
  blocked: { core: ["#e0a83c", 1.0, 4.5], dash: "7 6", cls: "seg-blocked" },
};
const CASING = { color: "#04060a", opacity: 0.85 };

function applySegStyle(id, row) {
  const trio = state.layers[id];
  if (!trio) return;
  const st = SEG_STYLES[row ? row.state : "ok"];
  const depth = row ? Math.max(row.expected_cm || 0, row.observed_cm || 0) : 0;
  const swell = Math.min(1.6, depth / 22);
  const w = st.core[2] + swell;
  trio.under.setStyle({ color: CASING.color, opacity: CASING.opacity, weight: w + 3.5 });
  trio.core.setStyle({ color: st.core[0], opacity: st.core[1], weight: w, dashArray: st.dash || null });
  const flowing = row && (row.state === "watch" || row.state === "alert" || row.state === "blocked");
  trio.flow.setStyle({ opacity: flowing ? 0.55 : 0 });
  const el = trio.core.getElement();
  if (el) el.setAttribute("class", `leaflet-interactive segcore ${st.cls || ""}`);
  const fe = trio.flow.getElement();
  if (fe) fe.setAttribute("class", "leaflet-interactive flowline");
}

function segRows() {
  if (state.mode === "live" && state.live) return state.live.segments;
  return state.snap ? state.snap.segments : [];
}
function currentRow(id) { return segRows().find((s) => s.id === id) || null; }

function focusSegment(id, pan = false) {
  state.focusSeg = id;
  state.mapHintDone = true;
  $("map-hint").hidden = true;
  $("engine-card").hidden = false;
  if (pan && state.layers[id]) map.panTo(state.layers[id].core.getBounds().getCenter());
  renderEngineCard();
}
window.__focus = (id) => focusSegment(id, true);

/* -------------------------------------------------- area (re)build */

function clearMapLayers() {
  for (const t of Object.values(state.layers)) {
    map.removeLayer(t.under); map.removeLayer(t.core); map.removeLayer(t.flow);
  }
  for (const m of Object.values(state.drainMarkers)) map.removeLayer(m);
  if (state.sensorMarker) map.removeLayer(state.sensorMarker);
  state.layers = {}; state.drainMarkers = {}; state.sensorMarker = null;
}

function buildArea(meta) {
  clearMapLayers();
  if (!map.getPane("glow")) {
    map.createPane("glow");
    map.getPane("glow").style.zIndex = 398;
  }
  for (const f of meta.segments_geojson.features) {
    const id = f.properties.id;
    const latlngs = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const under = L.polyline(latlngs, {
      pane: "glow", color: CASING.color, opacity: CASING.opacity, weight: 6.5,
      lineCap: "round", lineJoin: "round", interactive: false,
    }).addTo(map);
    const core = L.polyline(latlngs, {
      color: "#3e4a52", opacity: 0.9, weight: 3,
      lineCap: "round", lineJoin: "round", className: "segcore",
    }).addTo(map);
    const flow = L.polyline(latlngs, {
      color: "#dff6fb", opacity: 0, weight: 1.5, dashArray: "2 12",
      lineCap: "round", lineJoin: "round", className: "flowline", interactive: false,
    }).addTo(map);
    state.layers[id] = { under, core, flow };
    core.on("click", () => focusSegment(id));
  }
  for (const d of meta.drains) {
    state.drainMarkers[d.id] = L.circleMarker([d.lat, d.lng], {
      radius: 3.5, color: "#5c666b", fillColor: "#0b0d0f", fillOpacity: 1, weight: 1.5,
    }).addTo(map).bindTooltip(`${d.id} · ${d.name}`, { direction: "top" });
  }
  const sf = meta.segments_geojson.features.find((f) => f.properties.id === meta.area.sensor_seg);
  if (sf) {
    const mid = sf.geometry.coordinates[Math.floor(sf.geometry.coordinates.length / 2)];
    state.sensorMarker = L.circleMarker([mid[1], mid[0]], {
      radius: 4.5, color: "#4fc1d4", fillColor: "#4fc1d4", fillOpacity: 0.8, weight: 1.5,
      className: "sensor-dot",
    }).addTo(map).bindTooltip("water-level sensor", { direction: "top" });
  }
  map.setView(meta.area.center, meta.area.zoom);
  $("brand-area").textContent = `WARD INSTRUMENT · ${meta.area.label.toUpperCase()}`;

  const sel = $("rep-seg");
  sel.innerHTML = "";
  for (const f of meta.segments_geojson.features) {
    const o = document.createElement("option");
    o.value = f.properties.id;
    o.textContent = f.properties.name;
    sel.appendChild(o);
  }
}

async function refreshMeta() {
  const meta = await (await fetch("/api/meta")).json();
  state.meta = meta;
  $("storm-name").textContent = meta.storm.name;
  buildArea(meta);

  const fill = (el, items, active) => {
    el.innerHTML = "";
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.id; o.textContent = it.label;
      if (it.id === active) o.selected = true;
      el.appendChild(o);
    }
  };
  fill($("storm-sel"), meta.storms, meta.active_storm);
  fill($("area-sel"), meta.areas, meta.active_area);
}

/* ------------------------------------------------------- rain particles */

const fx = { canvas: null, ctx: null, drops: [], splashes: [], intensity: 0, last: 0 };

function fxIntensity() {
  const mm = state.mode === "live"
    ? (state.live ? state.live.rain_now * 4 : 0)   // live mm/15min are small — scale for visibility
    : (state.snap && state.running !== false ? state.snap.rain_now : (state.snap ? state.snap.rain_now : 0));
  return Math.max(0, Math.min(48, mm));
}

function fxLoop(ts) {
  const c = fx.canvas, ctx = fx.ctx;
  if (!c) return;
  if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
    c.width = c.clientWidth; c.height = c.clientHeight;
  }
  const target = fxIntensity();
  fx.intensity += (target - fx.intensity) * 0.04;         // ease toward real value
  const want = Math.round(fx.intensity * 9);              // drops on screen

  while (fx.drops.length < want) {
    fx.drops.push({
      x: Math.random() * (c.width + 120) - 60,
      y: Math.random() * -c.height,
      len: 9 + Math.random() * 13,
      spd: 9 + Math.random() * 7,
    });
  }
  if (fx.drops.length > want) fx.drops.length = want;

  ctx.clearRect(0, 0, c.width, c.height);
  if (fx.drops.length) {
    ctx.strokeStyle = "rgba(160, 208, 222, 0.5)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const d of fx.drops) {
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.len * 0.28, d.y + d.len);
      d.x -= d.spd * 0.28; d.y += d.spd;
      if (d.y > c.height) {
        if (Math.random() < 0.3) fx.splashes.push({ x: d.x, y: c.height - 2, r: 1, a: 0.5 });
        d.y = -12 - Math.random() * 60;
        d.x = Math.random() * (c.width + 120) - 30;
      }
    }
    ctx.stroke();
    for (let i = fx.splashes.length - 1; i >= 0; i--) {
      const s = fx.splashes[i];
      ctx.strokeStyle = `rgba(155, 200, 214, ${s.a})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, Math.PI, 2 * Math.PI); ctx.stroke();
      s.r += 0.7; s.a -= 0.045;
      if (s.a <= 0) fx.splashes.splice(i, 1);
    }
  }
  requestAnimationFrame(fxLoop);
}

/* ------------------------------------------------------------- renders */

function setHint(text) { if (state.hintsOn) $("hint-text").textContent = text; }

function renderTop() {
  const s = state.snap;
  if (!s) return;
  if (s.running !== undefined && s.running !== state.running) {
    state.running = s.running;
    $("btn-play").textContent = s.running ? "❚❚ Pause" : "▶ Run storm";
  }
  $("clock").textContent = s.clock;
  $("clock-sub").textContent = s.finished ? "replay complete"
    : state.running ? `replay · minute ${s.minute}` : "replay paused";
  $("rain-now").textContent = s.rain_now;
  $("tide-now").textContent = s.tide_now.toFixed(1);
  $("tide-lock-bar").style.width = `${s.tide_lock * 100}%`;
  $("tide-lock-label").textContent =
    s.tide_lock >= 0.85 ? "OUTFALLS SEALED" : s.tide_lock > 0.3 ? "OUTFALLS CHOKING" : "OUTFALLS OPEN";

  $("sb-window").textContent = `WINDOW ${String(Math.max(0, s.step + 1)).padStart(2, "0")}/${s.rain_full.length} · MIN ${s.minute}`;
  $("sb-live").textContent = state.mode === "live" ? "LIVE CITY"
    : s.finished ? "COMPLETE" : state.running ? "RUNNING" : "STANDBY";
  $("storm-name").textContent = `${s.area_label} · ${s.storm_name}`;
  $("sb-outbox").textContent = `WA OUTBOX · ${s.outbox.mode.toUpperCase()} · ${s.outbox.sent}`;

  $("k-alerts").textContent = s.kpis.alerts_sent;
  $("k-people").textContent = s.kpis.people_warned.toLocaleString("en-IN");
  $("k-lead").innerHTML = `${s.kpis.avg_lead_min}<small> min</small>`;
  $("k-drains").textContent = s.kpis.drains_flagged;

  const badge = $("node-badge");
  badge.textContent = s.node_live ? "LIVE HARDWARE" : "SIMULATED";
  badge.className = `nodechip ${s.node_live ? "hot" : "sim"}`;

  renderSummary();
  renderHints();
}

function worstSegment() {
  let best = null, bestDepth = -1;
  for (const row of segRows()) {
    const d = Math.max(row.expected_cm || 0, row.observed_cm || 0);
    if (d > bestDepth) { bestDepth = d; best = row; }
  }
  return bestDepth >= 6 ? { row: best, depth: bestDepth } : null;
}

function renderSummary() {
  const s = state.snap;
  const line = $("summary-line"), sub = $("summary-sub");
  const flooding = s.segments.filter((x) => x.state === "alert").length;
  const blocked = s.segments.filter((x) => x.state === "blocked").length;
  const quiet = s.storm_id === "quiet";

  if (s.step < 0) {
    line.textContent = "Ward is quiet.";
    sub.textContent = `${s.area_label}. Pick a storm and press ▶ Run storm — or open Live city for real rainfall right now.`;
  } else if (!s.finished) {
    if (flooding === 0 && blocked === 0) {
      line.textContent = "Raining — streets holding.";
      sub.textContent = "The model expects the drains to cope. No alerts needed yet.";
    } else {
      line.textContent = `${flooding} street${flooding === 1 ? "" : "s"} flooding${blocked ? ` · ${blocked} blocked drain caught` : ""}.`;
      sub.textContent = "Red streets already got their WhatsApp warning. Tap any street to see why it flooded.";
    }
  } else if (quiet) {
    line.textContent = s.kpis.alerts_sent === 0
      ? "A normal rainy day: zero alerts sent."
      : "Quiet day: only the blocked street needed anyone.";
    sub.textContent = "No healthy street buzzed a single phone — and the choked drain still got caught and dispatched.";
  } else {
    line.textContent = `Storm over: ${s.kpis.alerts_sent} streets warned early.`;
    sub.textContent = `${s.kpis.people_warned.toLocaleString("en-IN")} people got an average ${s.kpis.avg_lead_min}-minute head start before the water. Reset to run it again.`;
  }

  const worst = worstSegment();
  const row = $("worst-row");
  if (worst && !s.finished && state.mode === "replay") {
    row.hidden = false;
    $("worst-name").textContent = `${worst.row.name} · ~${Math.round(worst.depth)} cm`;
    row.onclick = () => focusSegment(worst.row.id, true);
  } else {
    row.hidden = true;
  }
}

function renderHints() {
  const s = state.snap;
  if (state.mode === "live") { setHint("LIVE CITY: real rainfall over this ward, updated every 15 minutes. Streets shade from today's actual rain."); return; }
  if (s.step < 0) setHint("Pick an AREA and a STORM — 26 July 2005 is in the library. Or open Live city for real weather.");
  else if (!s.finished && !state.mapHintDone) setHint("Watch the map change colour — then tap any street to see WHY it floods.");
  else if (!s.finished) setHint("Amber dashes = a blocked drain the engine diagnosed. Open Feed for the dispatch order.");
  else setHint(s.storm_id === "quiet"
    ? "Zero false alarms today. Now try 26 July 2005 — same ward, very different afternoon."
    : "Storm done. Try another area, another storm — or the quiet day, where silence is the win.");
}

function renderMap() {
  for (const row of segRows()) applySegStyle(row.id, row);
  if (state.mode === "replay" && state.snap) {
    for (const d of state.snap.drains) {
      const m = state.drainMarkers[d.id];
      if (!m) continue;
      const hot = d.dispatched || d.health < 60;
      m.setStyle({
        color: hot ? "#e0a83c" : "#5c666b",
        fillColor: hot ? "#1c1508" : "#0b0d0f",
        weight: hot ? 2 : 1.5,
        radius: hot ? 5 : 3.5,
      });
    }
  }
}

function renderEngineCard() {
  if (!state.focusSeg) return;
  const row = currentRow(state.focusSeg);
  if (!row) return;
  const exp = row.expected_cm || 0, obs = row.observed_cm ?? null;
  const scale = 45;
  $("engine-seg-name").textContent = row.name;
  $("bar-expected").style.width = `${Math.min(100, (exp / scale) * 100)}%`;
  $("bar-observed").style.width = obs == null ? "0%" : `${Math.min(100, (obs / scale) * 100)}%`;
  $("val-expected").textContent = `${exp.toFixed(1)} cm`;
  $("val-observed").textContent = obs == null ? "— cm" : `${obs.toFixed(1)} cm`;

  const delta = obs == null ? 0 : obs - exp;
  $("delta-val").textContent = delta.toFixed(1);
  const badge = $("verdict-badge");
  const plain = $("engine-plain");
  badge.className = "badge";
  if (row.state === "blocked") {
    badge.classList.add("causeB");
    badge.textContent = "CAUSE B · BLOCKED DRAIN";
    plain.textContent = "Far more water than this rain can explain — something is choked underground. A crew has been dispatched to this street's drain.";
  } else if (Math.max(exp, obs || 0) >= 8) {
    badge.classList.add("causeA");
    badge.textContent = "CAUSE A · RAIN OVERLOAD";
    plain.textContent = state.mode === "live"
      ? "Today's real rain alone would put water here — the model flags it before anyone reports it."
      : "The water matches what the rain model predicts — the sky simply beat the drain. People here were warned before it crossed the doorstep.";
  } else {
    badge.textContent = "NO SIGNIFICANT WATER";
    plain.textContent = "Expected and observed both near zero. This street is fine.";
  }
}

function renderChart() {
  const s = state.snap;
  if (!s) return;
  const cv = $("rain-chart");
  if (!cv.clientWidth) return;
  const ctx = cv.getContext("2d");
  const W = (cv.width = cv.clientWidth * 2);
  const H = (cv.height = 260);
  ctx.clearRect(0, 0, W, H);
  const n = s.rain_full.length;
  const bw = W / n;
  const maxRain = Math.max(...s.rain_full, 1);

  s.rain_full.forEach((mm, i) => {
    const h = Math.max(3, (mm / maxRain) * (H - 66));
    const past = i <= s.step;
    ctx.fillStyle = past ? (i === s.step ? "#4fc1d4" : "#2e6e7e") : "#161b1e";
    ctx.fillRect(i * bw + 7, H - 34 - h, bw - 14, h);
    ctx.fillStyle = past ? "#9aa3a7" : "#3d4549";
    ctx.font = "500 18px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText(String(mm), i * bw + bw / 2, H - 12);
  });

  ctx.strokeStyle = "#e0a83c";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath();
  (s.tide_full || []).slice(0, n).forEach((t, i) => {
    const y = H - 40 - ((t - 1.5) / 3.5) * (H - 80);
    const x = i * bw + bw / 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

/* ----------------------------------------------------------- live city */

async function pollLive() {
  try {
    state.live = await (await fetch("/api/live")).json();
  } catch { return; }
  if (state.mode !== "live") return;
  const l = state.live;
  $("live-rain").innerHTML = `${l.rain_now.toFixed(1)}<small> mm / 15 min</small>`;
  $("live-area").textContent = l.area_label;
  $("live-under").textContent = l.degraded
    ? "live feed unreachable — showing zero-rain baseline (DEGRADED)"
    : l.rain_now >= 4 ? `heavy rain over ${l.area_label} right now`
    : l.rain_now > 0.2 ? `raining over ${l.area_label} right now`
    : `dry over ${l.area_label} right now`;
  $("live-3h").textContent = l.past_3h_total.toFixed(1);
  $("live-next").textContent = l.next.reduce((a, b) => a + b, 0).toFixed(1);
  $("live-tide").textContent = l.tide_est.toFixed(1);

  const cv = $("live-chart");
  if (cv.clientWidth) {
    const ctx = cv.getContext("2d");
    const W = (cv.width = cv.clientWidth * 2), H = (cv.height = 220);
    ctx.clearRect(0, 0, W, H);
    const series = [...l.past, l.rain_now, ...l.next];
    const nowIdx = l.past.length;
    const bw = W / series.length;
    const mx = Math.max(...series, 1);
    series.forEach((mm, i) => {
      const h = Math.max(2, (mm / mx) * (H - 50));
      ctx.fillStyle = i === nowIdx ? "#4fc1d4" : i < nowIdx ? "#2e6e7e" : "#20444d";
      ctx.fillRect(i * bw + 3, H - 26 - h, bw - 6, h);
    });
    ctx.fillStyle = "#5c666b";
    ctx.font = "500 16px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText("−3h", bw * 1.2, H - 8);
    ctx.fillText("now", (nowIdx + 0.5) * bw, H - 8);
    ctx.fillText("+2h", W - bw * 1.2, H - 8);
  }

  const list = $("live-risk-list");
  list.innerHTML = "";
  const rows = [...l.segments].sort((a, b) => b.expected_cm - a.expected_cm).slice(0, 4);
  for (const r of rows) {
    const div = document.createElement("div");
    div.className = `live-seg ${r.state}`;
    div.innerHTML = `<span class="ls-state">${r.state.toUpperCase()}</span>
      <span class="ls-name">${r.name}</span>
      <span class="ls-cm">${r.expected_cm.toFixed(1)} cm</span>`;
    div.onclick = () => focusSegment(r.id, true);
    list.appendChild(div);
  }
  renderMap();
  renderEngineCard();
}

function enterLive() {
  state.mode = "live";
  $("live-dot").hidden = false;
  pollLive();
  if (!state.liveTimer) state.liveTimer = setInterval(pollLive, 60000);
  renderMap();
  renderHints();
  $("sb-live").textContent = "LIVE CITY";
}

function exitLive() {
  state.mode = "replay";
  renderMap();
  if (state.snap) renderTop();
}

/* ---------------------------------------------------------------- feed */

function feedCard(kind, head, bodyHtml) {
  const div = document.createElement("div");
  div.className = `card ${kind}`;
  div.innerHTML = `<div class="head">${head}</div><div class="body">${bodyHtml}</div>`;
  return div;
}

function bumpFeedBadge() {
  if (state.activeTab === "feed") return;
  state.feedUnseen += 1;
  const b = $("feed-badge");
  b.hidden = false;
  b.textContent = state.feedUnseen;
}

function renderFeed() {
  const s = state.snap;
  if (!s) return;
  const feed = $("feed");
  const items = [];

  for (const r of s.reports) {
    items.push({
      minute: r.minute, key: `r-${r.minute}-${r.segment}-${r.depth_cm}`,
      make: () => {
        const seg = currentRow(r.segment);
        const photo = r.photo ? `<img src="/static/${r.photo}" alt="citizen photo report" loading="lazy" />` : "";
        const cv = r.cv && r.cv.band && r.cv.depth_cm > 0
          ? `<span class="tag cv">[ CV: ${r.cv.band} · ~${Math.round(r.cv.depth_cm)} cm · ${Math.round(r.cv.confidence * 100)}% ]</span>` : "";
        return feedCard("report",
          `CITIZEN REPORT · ${r.source.toUpperCase()} · min ${r.minute}`,
          `<b>${seg ? seg.name : r.segment}</b> · ~${r.depth_cm} cm<br>
           <span class="native">${r.name ? r.name + ": " : ""}${r.text}</span>${cv ? "<br>" + cv : ""}${photo}`);
      },
    });
  }
  for (const a of s.alerts) {
    items.push({
      minute: a.minute, key: `a-${a.id}`,
      make: () => {
        if (a.kind === "dispatch") {
          const ev = a.meta && a.meta.drain_id ? a.meta.drain_id : "";
          return feedCard("dispatch", `WARD DISPATCH · min ${a.minute}`,
            `${a.text.en}<br><span class="tag dispatched">[ CREW DISPATCHED → ${ev} ]</span>`);
        }
        const t = a.text[state.lang] || a.text.en || a.text.mr;
        const head = a.kind === "street"
          ? `STREET ALERT · ${a.subscribers} SUBSCRIBERS · ${a.meta.channel} · min ${a.minute}`
          : `WATCH · min ${a.minute}`;
        const lead = a.kind === "street" && a.lead_min > 0
          ? `<span class="tag lead">[ T−${a.lead_min} MIN HEAD START ]</span>` : "";
        return feedCard(a.kind, head, `${t}${lead ? "<br>" + lead : ""}`);
      },
    });
  }

  items.sort((x, y) => x.minute - y.minute);
  for (const it of items) {
    if (state.renderedFeed.has(it.key)) continue;
    state.renderedFeed.add(it.key);
    feed.appendChild(it.make());
    bumpFeedBadge();
  }
  feed.scrollTop = feed.scrollHeight;
}

function renderAll() {
  if (!state.snap || !state.meta) return;
  renderTop();
  if (state.mode === "replay") renderMap();
  renderEngineCard();
  renderChart();
  renderFeed();
}

/* -------------------------------------------------------------- stream */

function connect() {
  const es = new EventSource("/stream");
  es.onmessage = (ev) => {
    state.snap = JSON.parse(ev.data);
    renderAll();
  };
  es.onerror = () => setTimeout(() => { es.close(); connect(); }, 1500);
}

/* ------------------------------------------------------------ controls */

async function control(body) {
  const res = await (await fetch("/api/control", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  state.running = res.running;
  $("btn-play").textContent = state.running ? "❚❚ Pause" : "▶ Run storm";
}

function clearLocalRun() {
  state.renderedFeed.clear();
  state.feedUnseen = 0;
  $("feed-badge").hidden = true;
  $("feed").innerHTML = "";
  $("engine-card").hidden = true;
  state.focusSeg = null;
}

$("btn-play").onclick = () => control({ action: state.running ? "pause" : "start" });
$("btn-reset").onclick = async () => { clearLocalRun(); await control({ action: "reset" }); };
$("storm-sel").onchange = async (e) => { clearLocalRun(); await control({ action: "load", storm: e.target.value }); };
$("area-sel").onchange = async (e) => {
  clearLocalRun();
  await control({ action: "load", area: e.target.value });
  await refreshMeta();
  if (state.mode === "live") pollLive();
};

document.querySelectorAll(".spd").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".spd").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    control({ action: "speed", speed: Number(b.dataset.speed) });
  };
});
document.querySelectorAll(".lng").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".lng").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.lang = b.dataset.lang;
    state.renderedFeed.clear();
    $("feed").innerHTML = "";
    renderFeed();
  };
});

document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    const tab = b.dataset.tab;
    state.activeTab = tab;
    $(`pane-${tab}`).classList.add("active");
    if (tab === "feed") { state.feedUnseen = 0; $("feed-badge").hidden = true; }
    if (tab === "rain") renderChart();
    if (tab === "live") enterLive(); else if (state.mode === "live") exitLive();
  };
});

$("legend-toggle").onclick = () => { $("legend").hidden = !$("legend").hidden; };
$("engine-x").onclick = () => { $("engine-card").hidden = true; state.focusSeg = null; };
$("composer-toggle").onclick = () => {
  const body = $("composer-body");
  body.hidden = !body.hidden;
  $("composer-toggle").textContent = body.hidden ? "＋ File a citizen report" : "－ Close report form";
};
$("hint-x").onclick = () => { state.hintsOn = false; $("hintbar").style.display = "none"; };

const depthInput = $("rep-depth");
depthInput.oninput = () => ($("rep-depth-val").textContent = `${depthInput.value} cm`);
$("rep-send").onclick = async () => {
  await fetch("/api/report", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      segment: $("rep-seg").value,
      depth_cm: Number(depthInput.value),
      text: "(filed live from the dashboard)",
    }),
  });
  const btn = $("rep-send");
  btn.textContent = "Queued ✓";
  setTimeout(() => (btn.textContent = "Send"), 1400);
};

/* ---------------------------------------------------------------- boot */

refreshMeta().then(() => {
  connect();
  fetch("/api/state").then((r) => r.json()).then((s) => { state.snap = s; renderAll(); });
  fx.canvas = $("rain-fx");
  fx.ctx = fx.canvas.getContext("2d");
  requestAnimationFrame(fxLoop);
  pollLive();                                  // warm the live cache early
});
