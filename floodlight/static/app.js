/* FLOODLIGHT ward instrument — client.
   One SSE stream in, one render pass out. No framework, no build step.
   UX principle: calm by default, detail on demand — the map answers
   "where", one tap answers "why". */

const state = {
  meta: null,
  snap: null,
  lang: "mr",
  running: false,
  focusSeg: null,               // nothing selected until the user taps
  layers: {},                   // segment id → {under, core}
  drainMarkers: {},
  renderedFeed: new Set(),
  feedUnseen: 0,
  activeTab: "status",
  hintsOn: true,
  mapHintDone: false,
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- map */

const map = L.map("map", {
  zoomControl: false, attributionControl: true, minZoom: 14, maxZoom: 18,
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

/* Cased cartographic strokes — colour is semantics only. */
const SEG_STYLES = {
  ok:      { core: ["#3e4a52", 0.9, 3.0], cls: "seg-ok" },
  watch:   { core: ["#e0a83c", 1.0, 4.5], cls: "seg-watch" },
  alert:   { core: ["#e4574c", 1.0, 5.0], cls: "seg-alert" },
  blocked: { core: ["#e0a83c", 1.0, 4.5], cls: "seg-blocked", dash: "7 6" },
};
const CASING = { color: "#04060a", opacity: 0.85 };

function applySegStyle(id, row) {
  const pair = state.layers[id];
  if (!pair) return;
  const st = SEG_STYLES[row ? row.state : "ok"];
  const depth = row ? Math.max(row.expected_cm, row.observed_cm || 0) : 0;
  const swell = Math.min(1.6, depth / 22);
  const w = st.core[2] + swell;
  pair.under.setStyle({ color: CASING.color, opacity: CASING.opacity, weight: w + 3.5 });
  pair.core.setStyle({ color: st.core[0], opacity: st.core[1], weight: w, dashArray: st.dash || null });
  const el = pair.core.getElement();
  if (el) el.setAttribute("class", `leaflet-interactive segcore ${st.cls}`);
}

function currentRow(id) {
  return state.snap ? state.snap.segments.find((s) => s.id === id) : null;
}

function focusSegment(id, pan = false) {
  state.focusSeg = id;
  state.mapHintDone = true;
  $("map-hint").hidden = true;
  $("engine-card").hidden = false;
  if (pan && state.layers[id]) map.panTo(state.layers[id].core.getBounds().getCenter());
  renderEngineCard();
}
window.__focus = (id) => focusSegment(id, true);   // demo / capture hook

async function initMeta() {
  const meta = await (await fetch("/api/meta")).json();
  state.meta = meta;
  $("storm-name").textContent = meta.storm.name;

  map.createPane("glow");
  map.getPane("glow").style.zIndex = 398;

  for (const f of meta.segments_geojson.features) {
    const id = f.properties.id;
    const latlngs = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const under = L.polyline(latlngs, {
      pane: "glow", color: CASING.color, opacity: CASING.opacity, weight: 6.5,
      lineCap: "round", lineJoin: "round", interactive: false,
    }).addTo(map);
    const core = L.polyline(latlngs, {
      color: "#3e4a52", opacity: 0.9, weight: 3,
      lineCap: "round", lineJoin: "round", className: "segcore seg-ok",
    }).addTo(map);
    state.layers[id] = { under, core };
    core.on("click", () => focusSegment(id));
  }

  for (const d of meta.drains) {
    state.drainMarkers[d.id] = L.circleMarker([d.lat, d.lng], {
      radius: 3.5, color: "#5c666b", fillColor: "#0b0d0f", fillOpacity: 1, weight: 1.5,
    }).addTo(map).bindTooltip(`${d.id} · ${d.name}`, { direction: "top" });
  }

  L.circleMarker([19.0154, 72.84465], {
    radius: 4.5, color: "#4fc1d4", fillColor: "#4fc1d4", fillOpacity: 0.8, weight: 1.5,
    className: "sensor-dot",
  }).addTo(map).bindTooltip("water-level sensor · Hindmata Jn", { direction: "top" });

  const sel = $("rep-seg");
  for (const f of meta.segments_geojson.features) {
    const o = document.createElement("option");
    o.value = f.properties.id;
    o.textContent = f.properties.name;
    if (f.properties.id === "hindmata-mkt") o.selected = true;
    sel.appendChild(o);
  }

  const ssel = $("storm-sel");
  for (const s of meta.storms) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.label;
    if (s.id === meta.active_storm) o.selected = true;
    ssel.appendChild(o);
  }
}

/* ------------------------------------------------------------- renders */

function setHint(text) {
  if (!state.hintsOn) return;
  $("hint-text").textContent = text;
}

function renderTop() {
  const s = state.snap;
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
  $("sb-live").textContent = s.finished ? "COMPLETE" : state.running ? "RUNNING" : "STANDBY";
  $("storm-name").textContent = s.storm_name || "—";
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
  const s = state.snap;
  let best = null, bestDepth = -1;
  for (const row of s.segments) {
    const d = Math.max(row.expected_cm, row.observed_cm || 0);
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
    sub.textContent = "Pick a scenario and press ▶ Run storm — everything updates every 15 storm-minutes.";
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
      : `Quiet day done · ${s.kpis.alerts_sent} alerts.`;
    sub.textContent = s.kpis.drains_flagged
      ? "Nobody's phone buzzed for nothing — and the blocked drain at Parel Tank Rd still got caught and dispatched."
      : "No false alarms on a day that didn't deserve any.";
  } else {
    line.textContent = `Storm over: ${s.kpis.alerts_sent} streets warned early.`;
    sub.textContent = `${s.kpis.people_warned.toLocaleString("en-IN")} people got an average ${s.kpis.avg_lead_min}-minute head start before the water. Reset to run it again.`;
  }

  const worst = worstSegment();
  const row = $("worst-row");
  if (worst && !s.finished) {
    row.hidden = false;
    $("worst-name").textContent = `${worst.row.name} · ~${Math.round(worst.depth)} cm`;
    row.onclick = () => focusSegment(worst.row.id, true);
  } else {
    row.hidden = true;
  }
}

function renderHints() {
  const s = state.snap;
  if (s.step < 0) setHint("Press ▶ Run storm to replay a real Mumbai cloudburst — or pick the quiet day in Scenario.");
  else if (!s.finished && !state.mapHintDone) setHint("Watch the map change colour — then tap any street to see WHY it floods.");
  else if (!s.finished) setHint("Amber dashes = a blocked drain the engine diagnosed. Open Live feed for the dispatch order.");
  else setHint(s.storm_id === "quiet"
    ? "Zero false alarms today. Switch the scenario to the cloudburst to see the loud day."
    : "Storm done. Try the Quiet Tuesday scenario — the system's job there is to stay silent.");
}

function renderMap() {
  for (const row of state.snap.segments) applySegStyle(row.id, row);
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

function renderEngineCard() {
  if (!state.focusSeg) return;
  const row = currentRow(state.focusSeg);
  if (!row) return;
  const exp = row.expected_cm, obs = row.observed_cm;
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
    plain.textContent = "The water matches what the rain model predicts — the sky simply beat the drain. People here were warned before it crossed the doorstep.";
  } else {
    badge.textContent = "NO SIGNIFICANT WATER";
    plain.textContent = "Expected and observed both near zero. This street is fine.";
  }
}

function renderChart() {
  const s = state.snap;
  const cv = $("rain-chart");
  if (!cv.clientWidth) return;                 // pane hidden — skip
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
  const tides = s.tide_full || state.meta.storm.tide_m;
  tides.slice(0, n).forEach((t, i) => {
    const y = H - 40 - ((t - 1.5) / 3.5) * (H - 80);
    const x = i * bw + bw / 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

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
  renderMap();
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

/* tabs */
document.querySelectorAll(".tab").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".pane").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.activeTab = b.dataset.tab;
    $(`pane-${b.dataset.tab}`).classList.add("active");
    if (b.dataset.tab === "feed") {
      state.feedUnseen = 0;
      $("feed-badge").hidden = true;
    }
    if (b.dataset.tab === "rain") renderChart();
  };
});

/* reveal toggles */
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

initMeta().then(() => {
  connect();
  fetch("/api/state").then((r) => r.json()).then((s) => { state.snap = s; renderAll(); });
});
