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
  heatOn: true,
  heatMode: "now",              // live heat: "now" | "fc" (next 6 h) | "off"
  outlookSel: -1,               // tapped hour in the 12-h outlook strip
  heatLayer: null,
  riskPin: null,
  region: null,
  regionMarkers: [],
  regionTimer: null,
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
  trio.flow.setStyle({ opacity: flowing ? 0.85 : 0, weight: flowing && row.state !== "watch" ? 2.2 : 1.7 });
  const el = trio.core.getElement();
  if (el) el.setAttribute("class", `leaflet-interactive segcore ${st.cls || ""}`);
  const fe = trio.flow.getElement();
  if (fe) {
    fe.setAttribute("class", "leaflet-interactive flowline");
    fe.style.animationDuration = row && row.state === "alert" ? "0.65s"
      : row && row.state === "blocked" ? "0.9s" : "1.3s";
  }
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
  // probability for the tapped street, from the same tap-anywhere engine
  const trio = state.layers[id];
  if (trio) {
    const mid = trio.core.getLatLngs()[Math.floor(trio.core.getLatLngs().length / 2)];
    fetch(`/api/risk?lat=${mid.lat.toFixed(6)}&lng=${mid.lng.toFixed(6)}&mode=${state.mode}`)
      .then((r) => r.json())
      .then((r) => {
        if (state.focusSeg !== id) return;
        const col = r.tier === "HIGH" ? "#e4574c" : r.tier === "MODERATE" ? "#e0a83c" : "#4fc1d4";
        $("engine-prob").hidden = false;
        $("engine-prob-val").textContent = `${Math.round(r.probability * 100)}% · ${r.tier}`;
        $("engine-prob-val").style.color = col;
      }).catch(() => {});
  }
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
      bubblingMouseEvents: false,
    }).addTo(map);
    const flow = L.polyline(latlngs, {
      color: "#eafbff", opacity: 0, weight: 1.7, dashArray: "3 11",
      lineCap: "round", lineJoin: "round", className: "flowline", interactive: false,
    }).addTo(map);
    state.layers[id] = { under, core, flow };
    core.on("click", () => focusSegment(id));
  }
  for (const d of meta.drains) {
    state.drainMarkers[d.id] = L.circleMarker([d.lat, d.lng], {
      radius: 3.5, color: "#5c666b", fillColor: "#0b0d0f", fillOpacity: 1, weight: 1.5,
      bubblingMouseEvents: false,
    }).addTo(map)
      .bindTooltip(`${d.id} · ${d.name}`, { direction: "top" })
      .bindPopup(() => {
        const live = state.snap && state.snap.drains.find((x) => x.id === d.id);
        const health = live ? live.health : 95;
        const col = health < 40 ? "#e4574c" : health < 60 ? "#e0a83c" : "#4fc1d4";
        return `<div class="pop-name">${d.id} · ${d.name}</div>
          <div class="pop-row">design capacity <b>${d.capacity_mm} mm / 15 min</b></div>
          <div class="pop-row">health belief <b style="color:${col}">${health}%</b>
          ${live && live.dispatched ? " · <b style=\"color:#e0a83c\">CREW DISPATCHED</b>" : ""}</div>
          <div class="pop-row">${health < 60 ? "surprising water upstream — likely choked" : "behaving as designed"}</div>`;
      });
  }
  const sf = meta.segments_geojson.features.find((f) => f.properties.id === meta.area.sensor_seg);
  if (sf) {
    const mid = sf.geometry.coordinates[Math.floor(sf.geometry.coordinates.length / 2)];
    state.sensorMarker = L.circleMarker([mid[1], mid[0]], {
      radius: 4.5, color: "#4fc1d4", fillColor: "#4fc1d4", fillOpacity: 0.8, weight: 1.5,
      className: "sensor-dot", bubblingMouseEvents: false,
    }).addTo(map)
      .bindTooltip("water-level sensor", { direction: "top" })
      .bindPopup(() => {
        const row = currentRow(meta.area.sensor_seg);
        const cm = row && row.observed_cm != null ? `${row.observed_cm.toFixed(1)} cm` : "no fresh reading";
        return `<div class="pop-name">Ultrasonic level node</div>
          <div class="pop-row">street <b>${row ? row.name : meta.area.sensor_seg}</b></div>
          <div class="pop-row">latest depth <b>${cm}</b></div>
          <div class="pop-row">₹2k ESP32 build — see /hardware in the repo</div>`;
      });
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

/* --------------------------------------------------- weather FX engine */
/* Three parallax rain layers, splash arcs, lightning on cloudburst
   windows, ripple rings on flooded streets, a radar ring on the sensor.
   Intensity is DATA-DRIVEN (replay rain_now, or real live rain); the
   FX PREVIEW button cranks visuals only, clearly labelled. */

const fx = {
  canvas: null, ctx: null, intensity: 0,
  layers: [
    { drops: [], mult: 5, spd: 7,  len: 8,  alpha: 0.22, w: 1.0, drift: 0.22 },   // far
    { drops: [], mult: 6, spd: 11, len: 13, alpha: 0.42, w: 1.4, drift: 0.28 },   // mid
    { drops: [], mult: 5, spd: 16, len: 20, alpha: 0.62, w: 1.9, drift: 0.34 },   // near
  ],
  splashes: [], ripples: [], flash: 0, previewUntil: 0,
  lastRipple: 0, lastSensor: 0,
  cloud: 0, blobs: [],          // overcast deck (0–100, eased)
};

function fxIntensity() {
  let mm = state.mode === "live"
    ? (state.live ? state.live.rain_now * 4 : 0)
    : (state.snap ? state.snap.rain_now : 0);
  if (Date.now() < fx.previewUntil) {
    const left = (fx.previewUntil - Date.now()) / 1000;
    mm = Math.max(mm, left > 16 ? (20 - left) * 11 : left > 5 ? 44 : left * 8);
  }
  return Math.max(0, Math.min(48, mm));
}

function fxCloudTarget() {
  // in LIVE mode the deck is the REAL sky; in replay it thickens with rain
  let c = 0;
  if (state.mode === "live" && state.live && state.live.sky) c = state.live.sky.cloud_now;
  else c = Math.min(85, fx.intensity * 2.4);
  if (Date.now() < fx.previewUntil) c = Math.max(c, 90);
  return c;
}

function drawClouds(ctx, W, H) {
  fx.cloud += (fxCloudTarget() - fx.cloud) * 0.02;
  if (fx.cloud < 3) return;
  if (!fx.blobs.length) {
    for (let i = 0; i < 7; i++) {
      fx.blobs.push({ x: Math.random(), y: 0.02 + Math.random() * 0.16,
                      r: 0.16 + Math.random() * 0.2, s: 0.05 + Math.random() * 0.1,
                      o: 0.55 + Math.random() * 0.45 });
    }
  }
  const k = fx.cloud / 100;
  // a soft ceiling — the whole frame dims a touch under heavy cloud
  const dim = ctx.createLinearGradient(0, 0, 0, H * 0.55);
  dim.addColorStop(0, `rgba(7, 10, 13, ${0.34 * k})`);
  dim.addColorStop(1, "rgba(7, 10, 13, 0)");
  ctx.fillStyle = dim;
  ctx.fillRect(0, 0, W, H * 0.55);
  // drifting cloud bellies along the top edge
  for (const b of fx.blobs) {
    b.x += (b.s * k) / W * 60;
    if (b.x * W - b.r * W > W) b.x = -b.r;
    const cx = b.x * W, cy = b.y * H, cr = b.r * W;
    const g = ctx.createRadialGradient(cx, cy, cr * 0.15, cx, cy, cr);
    g.addColorStop(0, `rgba(30, 38, 45, ${0.30 * k * b.o})`);
    g.addColorStop(0.7, `rgba(22, 28, 34, ${0.16 * k * b.o})`);
    g.addColorStop(1, "rgba(22, 28, 34, 0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, 2 * Math.PI); ctx.fill();
  }
}

function spawnRipple(x, y, color, max = 26) {
  fx.ripples.push({ x, y, r: 2, a: 0.55, color, max });
}

function floodedContainerPoints() {
  const pts = [];
  for (const row of segRows()) {
    if (row.state === "alert" || row.state === "blocked" || row.state === "watch") {
      const trio = state.layers[row.id];
      if (!trio) continue;
      const ll = trio.core.getLatLngs();
      pts.push({ ll: ll[Math.floor(Math.random() * ll.length)], hot: row.state !== "watch" });
    }
  }
  return pts;
}

function fxLoop() {
  const c = fx.canvas, ctx = fx.ctx;
  if (!c) return;
  if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
    c.width = c.clientWidth; c.height = c.clientHeight;
  }
  const target = fxIntensity();
  fx.intensity += (target - fx.intensity) * 0.05;
  ctx.clearRect(0, 0, c.width, c.height);
  const now = Date.now();

  // overcast deck first — the sky sits behind the rain
  drawClouds(ctx, c.width, c.height);

  // rain — three parallax layers
  for (const L of fx.layers) {
    const want = Math.round(fx.intensity * L.mult);
    while (L.drops.length < want) {
      L.drops.push({ x: Math.random() * (c.width + 160) - 80, y: Math.random() * -c.height,
                     j: 0.75 + Math.random() * 0.5 });
    }
    if (L.drops.length > want) L.drops.length = want;
    if (!L.drops.length) continue;
    ctx.strokeStyle = `rgba(168, 214, 228, ${L.alpha})`;
    ctx.lineWidth = L.w;
    ctx.beginPath();
    for (const d of L.drops) {
      const len = L.len * d.j, spd = L.spd * d.j;
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - len * L.drift, d.y + len);
      d.x -= spd * L.drift; d.y += spd;
      if (d.y > c.height) {
        if (L.spd >= 14 && Math.random() < 0.5)
          fx.splashes.push({ x: d.x, y: c.height - 2 - Math.random() * 24, r: 1, a: 0.5 });
        d.y = -14 - Math.random() * 80;
        d.x = Math.random() * (c.width + 160) - 40;
      }
    }
    ctx.stroke();
  }

  // splash arcs
  for (let i = fx.splashes.length - 1; i >= 0; i--) {
    const s = fx.splashes[i];
    ctx.strokeStyle = `rgba(168, 214, 228, ${s.a})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, Math.PI, 2 * Math.PI); ctx.stroke();
    s.r += 0.8; s.a -= 0.05;
    if (s.a <= 0) fx.splashes.splice(i, 1);
  }

  // ripple rings on flooded streets (water breathing)
  if (now - fx.lastRipple > 620) {
    fx.lastRipple = now;
    const pts = floodedContainerPoints();
    if (pts.length) {
      const p = pts[Math.floor(Math.random() * pts.length)];
      const cp = map.latLngToContainerPoint(p.ll);
      spawnRipple(cp.x, cp.y, p.hot ? "228, 122, 108" : "224, 168, 60");
    }
  }
  // radar ring on the sensor — the instrument is alive even when dry
  if (state.sensorMarker && now - fx.lastSensor > 2600) {
    fx.lastSensor = now;
    const cp = map.latLngToContainerPoint(state.sensorMarker.getLatLng());
    spawnRipple(cp.x, cp.y, "79, 193, 212", 34);
  }
  for (let i = fx.ripples.length - 1; i >= 0; i--) {
    const r = fx.ripples[i];
    ctx.strokeStyle = `rgba(${r.color}, ${r.a})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 2 * Math.PI); ctx.stroke();
    r.r += r.max > 30 ? 0.55 : 0.8; r.a -= r.max > 30 ? 0.012 : 0.02;
    if (r.a <= 0 || r.r > r.max) fx.ripples.splice(i, 1);
  }

  // lightning during cloudburst windows
  if (fx.intensity >= 26 && Math.random() < 0.004) fx.flash = 0.5 + Math.random() * 0.3;
  if (fx.flash > 0.01) {
    ctx.fillStyle = `rgba(222, 238, 248, ${fx.flash * 0.55})`;
    ctx.fillRect(0, 0, c.width, c.height);
    fx.flash *= Math.random() < 0.12 ? 1.6 : 0.8;      // occasional double-strike
    if (fx.flash > 0.9) fx.flash = 0.9;
  } else fx.flash = 0;

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

  const setKpi = (id, html) => {
    const el = $(id);
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
    }
  };
  setKpi("k-alerts", String(s.kpis.alerts_sent));
  setKpi("k-people", s.kpis.people_warned.toLocaleString("en-IN"));
  setKpi("k-lead", `${s.kpis.avg_lead_min}<small> min</small>`);
  setKpi("k-drains", String(s.kpis.drains_flagged));

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

/* ------------------------------------------------------------- heatmap */

function updateHeat() {
  if (!window.L || !L.heatLayer) return;
  if (!state.heatLayer) {
    state.heatLayer = L.heatLayer([], {
      radius: 34, blur: 26, maxZoom: 17, max: 1.0,
      gradient: { 0.15: "#12333c", 0.4: "#2e6e7e", 0.6: "#4fc1d4", 0.8: "#e0a83c", 1.0: "#e4574c" },
    }).addTo(map);
  }
  if (!state.heatOn) { state.heatLayer.setLatLngs([]); return; }

  const pts = [];
  if (state.mode === "live" && state.live && state.live.heat) {
    // real rain across Greater Mumbai (Open-Meteo grid) — NOW shows mm/15min,
    // FORECAST shows the next-6-h total, so the map lights up BEFORE the storm
    for (const h of state.live.heat) {
      if (state.heatMode === "fc") {
        if ((h.next6 || 0) > 0.2) pts.push([h.lat, h.lng, Math.min(1, h.next6 / 22)]);
      } else if (h.mm > 0.05) pts.push([h.lat, h.lng, Math.min(1, h.mm / 6)]);
    }
  } else if (state.snap) {
    // waterlogging heat: depth along every street segment
    for (const row of state.snap.segments) {
      const depth = Math.max(row.expected_cm || 0, row.observed_cm || 0);
      if (depth < 4) continue;
      const trio = state.layers[row.id];
      if (!trio) continue;
      const w = Math.min(1, depth / 40);
      for (const ll of trio.core.getLatLngs()) pts.push([ll.lat, ll.lng, w]);
    }
  }
  state.heatLayer.setLatLngs(pts);
}

/* ---------------------------------------------------- tap-anywhere risk */

function riskPopupHtml(r) {
  const col = r.tier === "HIGH" ? "#e4574c" : r.tier === "MODERATE" ? "#e0a83c" : "#4fc1d4";
  const pct = Math.round(r.probability * 100);
  const bar = (label, frac, val) => `
    <div class="rp-driver"><span>${label}</span>
      <div class="rp-track"><i style="width:${Math.round(Math.min(1, frac) * 100)}%"></i></div>
      <b>${val}</b></div>`;
  return `<div class="risk-pop">
    <div class="rp-head">WATERLOGGING PROBABILITY</div>
    <div class="rp-line"><span class="rp-big" style="color:${col}">${pct}%</span>
      <span class="rp-tier" style="color:${col};border-color:${col}">${r.tier}</span></div>
    <div class="rp-sub">nearest street: <b>${r.segment}</b> · ${r.distance_m} m away</div>
    ${bar("projected peak", r.projected_peak_cm / 45, r.projected_peak_cm + " cm")}
    ${bar("rain next hour", r.rain_next_hour_mm / 60, r.rain_next_hour_mm + " mm")}
    ${bar("drain risk", (100 - r.drain_health) / 100, r.drain_health + "% health")}
    ${bar("tide lock", r.tide_lock, Math.round(r.tide_lock * 100) + "%")}
    ${r.forecast && r.mode === "live" && r.forecast.next6_mm >= 0.5
      ? `<div class="rp-fc">▲ FORECAST · ${r.forecast.next6_mm} mm in the next 6 h — ${r.forecast.headline.toLowerCase()}</div>` : ""}
    <div class="rp-note">${r.mode === "live" ? "computed from today's REAL rain" : "computed from the running storm"} · low-lying factor ×${r.bowl}</div>
  </div>`;
}

async function riskAt(latlng) {
  let r;
  try {
    r = await (await fetch(`/api/risk?lat=${latlng.lat.toFixed(6)}&lng=${latlng.lng.toFixed(6)}&mode=${state.mode}`)).json();
  } catch { return; }
  if (state.riskPin) map.removeLayer(state.riskPin);
  const col = r.tier === "HIGH" ? "#e4574c" : r.tier === "MODERATE" ? "#e0a83c" : "#4fc1d4";
  state.riskPin = L.circleMarker(latlng, {
    radius: 6, color: col, fillColor: col, fillOpacity: 0.35, weight: 2,
    bubblingMouseEvents: false,
  }).addTo(map);
  state.riskPin.bindPopup(riskPopupHtml(r), { maxWidth: 290 }).openPopup();
}

map.on("click", (e) => riskAt(e.latlng));

function renderMap() {
  for (const row of segRows()) applySegStyle(row.id, row);
  updateHeat();
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

/* ------------------------------------------------------ sky + outlook */

const CLOUD_D = "M12 26a7 7 0 0 1 0-14 10 10 0 0 1 19-3 8 8 0 0 1 5 17z";
const WMO_TXT = (c) => ({ 0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 80: "rain showers",
  81: "heavy showers", 82: "violent showers", 95: "thunderstorm",
  96: "thunderstorm + hail", 99: "thunderstorm + hail" }[c] || "rain");

function skyIconSvg(level) {
  const cloud = (cls, dx, dy, sc) =>
    `<path class="${cls}" transform="translate(${dx},${dy}) scale(${sc})" d="${CLOUD_D}"/>`;
  const drops = (n, heavy) => Array.from({ length: n }, (_, i) =>
    `<line class="sk-drop${heavy ? " heavy" : ""}" style="animation-delay:${(i * 0.38).toFixed(2)}s" x1="${17 + i * 8}" y1="28" x2="${15 + i * 8}" y2="35"/>`).join("");
  const bolt = `<path class="sk-bolt" d="M26 22l-6 9h4.4l-3 8 9.4-11h-4.6l4.4-6z"/>`;
  const sun = `<g class="sk-sun"><circle cx="24" cy="16" r="6"/>${Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return `<line x1="${(24 + Math.cos(a) * 9).toFixed(1)}" y1="${(16 + Math.sin(a) * 9).toFixed(1)}" x2="${(24 + Math.cos(a) * 12.5).toFixed(1)}" y2="${(16 + Math.sin(a) * 12.5).toFixed(1)}"/>`;
  }).join("")}</g>`;
  let body;
  if (level === "clear") body = sun;
  else if (level === "cloudy") body = sun + cloud("sk-c1", 12, 6, 0.72);
  else if (level === "overcast") body = cloud("sk-c2", 17, 4, 0.6) + cloud("sk-c1", 2, 6, 0.85);
  else if (level === "rain-soon") body = cloud("sk-c1", 4, 3, 0.85) + drops(2);
  else if (level === "storm-inbound") body = cloud("sk-c2", 17, 2, 0.58) + cloud("sk-c1", 2, 3, 0.85) + bolt;
  else if (level === "storm-now") body = cloud("sk-c1", 2, 3, 0.9) + drops(3, true) + bolt;
  else body = cloud("sk-c1", 2, 3, 0.9) + drops(3);          // raining
  return `<svg viewBox="0 0 48 42" width="46" height="38" aria-hidden="true">${body}</svg>`;
}

function renderSky() {
  const l = state.live;
  const strip = $("sky-strip");
  if (!l || !strip) return;
  if (l.degraded || !l.outlook) {
    strip.className = "sky-degraded";
    $("sky-head").textContent = "SKY DATA UNAVAILABLE";
    $("sky-sub").textContent = "forecast feed unreachable — showing rain gauges only";
    $("sky-icon").innerHTML = skyIconSvg("overcast");
    $("sky-eta").hidden = true;
    return;
  }
  const s = l.outlook.summary, sky = l.sky || {};
  strip.className = `sky-${s.level}`;
  $("sky-icon").innerHTML = skyIconSvg(s.level);
  $("sky-head").textContent = s.headline;
  $("sky-sub").textContent = s.detail;
  const eta = $("sky-eta");
  if (s.eta_h >= 0 && (s.level === "storm-inbound" || s.level === "rain-soon")) {
    eta.hidden = false;
    eta.textContent = s.eta_txt.toUpperCase();
  } else eta.hidden = true;

  // statusbar chip — the sky verdict follows you to every tab
  const sb = $("sb-sky");
  if (state.mode === "live") {
    sb.hidden = false;
    sb.className = `sky-chip sky-${s.level}`;
    sb.textContent = s.next6_mm >= 0.5
      ? `SKY ${sky.cloud_now ?? 0}% · +${s.next6_mm.toFixed(1)}MM/6H`
      : `SKY ${sky.cloud_now ?? 0}% · DRY 6H`;
  }
}

const OL_COL = (mm) => (mm >= 5 ? "#e4574c" : mm >= 1.5 ? "#e0a83c" : "#4fc1d4");

function renderOutlook() {
  const l = state.live, strip = $("outlook-strip");
  if (!l || !strip) return;
  const hours = (l.outlook && l.outlook.hours) || [];
  $("outlook").hidden = !hours.length;
  if (!hours.length) return;
  const key = JSON.stringify(hours);
  if (strip.dataset.key === key) return;                     // unchanged — don't re-animate
  strip.dataset.key = key;
  state.outlookSel = -1;
  const mx = Math.max(...hours.map((h) => h.mm), 2);         // floor keeps drizzle small
  strip.innerHTML = "";
  hours.forEach((h, i) => {
    const cell = document.createElement("button");
    cell.className = "oh";
    cell.title = `${h.t} · ${h.mm.toFixed(1)} mm · ${h.prob}%`;
    cell.innerHTML = `
      <i class="oh-cloud" style="opacity:${((h.cloud / 100) * 0.85).toFixed(2)}"></i>
      <span class="oh-barwrap"><i class="oh-bar" style="height:${Math.max(2, Math.round((h.mm / mx) * 46))}px;background:${OL_COL(h.mm)};animation-delay:${i * 45}ms"></i></span>
      <span class="oh-prob">${h.prob >= 25 ? h.prob : "·"}</span>
      <span class="oh-hr">${h.t.slice(0, 2)}</span>`;
    cell.onclick = () => {
      state.outlookSel = i;
      strip.querySelectorAll(".oh").forEach((x, j) => x.classList.toggle("sel", j === i));
      $("outlook-detail").innerHTML =
        `<b>${h.t}</b> — ${h.mm.toFixed(1)} mm expected · ${h.prob}% chance · ${h.cloud}% cloud · ${WMO_TXT(h.code)}`;
    };
    strip.appendChild(cell);
  });
  $("outlook-detail").textContent = "tap an hour for the exact numbers";
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
  const sum = l.outlook && l.outlook.summary;
  $("live-under").textContent = l.degraded
    ? "live feed unreachable — showing zero-rain baseline (DEGRADED)"
    : l.rain_now >= 4 ? `heavy rain over ${l.area_label} right now`
    : l.rain_now > 0.2 ? `raining over ${l.area_label} right now`
    : sum && (sum.level === "storm-inbound" || sum.level === "rain-soon")
      ? `dry over ${l.area_label} — but rain is on the way (see forecast)`
    : sum && sum.level === "overcast" ? `dry over ${l.area_label} — heavy cloud overhead`
    : `dry over ${l.area_label} right now`;
  $("live-3h").textContent = l.past_3h_total.toFixed(1);
  $("live-next").textContent = l.next.reduce((a, b) => a + b, 0).toFixed(1);
  $("live-tide").textContent = l.tide_est.toFixed(1);
  renderSky();
  renderOutlook();

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

const TIER_COL = { HIGH: "#e4574c", MODERATE: "#e0a83c", LOW: "#4fc1d4" };

async function pollRegion() {
  try {
    state.region = await (await fetch("/api/region")).json();
  } catch { return; }
  const list = $("region-list");
  if (!list) return;
  $("region-upd").textContent = state.region.degraded ? "feed degraded" : `updated ${state.region.updated}`;
  list.innerHTML = "";
  const rows = [...state.region.areas].sort((a, b) => b.risk_pct - a.risk_pct);
  for (const a of rows) {
    const div = document.createElement("div");
    div.className = "region-row";
    const rising = (a.risk_next_pct || 0) - a.risk_pct >= 8;
    const fc = (a.next6_mm || 0) >= 0.5 ? ` · <b class="rr-fc">+${a.next6_mm.toFixed(1)} fc</b>` : "";
    div.innerHTML = `<span class="rr-risk" style="color:${TIER_COL[a.tier]}">${a.risk_pct}%</span>
      ${rising ? `<span class="rr-next" style="color:${TIER_COL[a.tier_next]}">▲${a.risk_next_pct}%</span>` : ""}
      <span class="rr-name">${a.label}</span>
      <span class="rr-rain">${a.rain_now.toFixed(1)} mm · 3h ${a.past_3h.toFixed(1)}${fc}</span>`;
    if (rising) div.title = `forecast: risk climbs to ${a.risk_next_pct}% within 6 h (${a.next6_mm} mm expected)`;
    div.onclick = async () => {
      clearLocalRun();
      await control({ action: "load", area: a.id });
      await refreshMeta();
      pollLive();
      map.setView(a.center, 15);
    };
    list.appendChild(div);
  }

  // region markers on the map (live mode only)
  for (const m of state.regionMarkers) map.removeLayer(m);
  state.regionMarkers = [];
  if (state.mode !== "live") return;
  for (const a of state.region.areas) {
    const col = TIER_COL[a.tier];
    const m = L.circleMarker(a.center, {
      radius: 6 + a.risk_pct / 14, color: col, weight: 2,
      fillColor: col, fillOpacity: 0.25, bubblingMouseEvents: false,
    }).addTo(map)
      .bindTooltip(`${a.label} — ${a.risk_pct}%${(a.risk_next_pct || 0) - a.risk_pct >= 8 ? ` ▲${a.risk_next_pct}% by +6h` : ""} · ${a.rain_now.toFixed(1)} mm now${(a.next6_mm || 0) >= 0.5 ? ` · +${a.next6_mm} mm fc` : ""}`, { direction: "top" });
    m.on("click", async () => {
      clearLocalRun();
      await control({ action: "load", area: a.id });
      await refreshMeta();
      pollLive();
      map.setView(a.center, 15);
    });
    state.regionMarkers.push(m);
  }
}

function enterLive() {
  state.mode = "live";
  $("live-dot").hidden = false;
  heatPill();
  if (state.live) { renderSky(); renderOutlook(); }   // instant paint from cache
  pollLive();
  pollRegion();
  if (!state.liveTimer) state.liveTimer = setInterval(pollLive, 60000);
  if (!state.regionTimer) state.regionTimer = setInterval(pollRegion, 120000);
  // pull back to the whole Mumbai Metropolitan Region
  map.setMinZoom(10);
  if (state.region && state.region.areas.length) {
    map.fitBounds(L.latLngBounds(state.region.areas.map((a) => a.center)).pad(0.18));
  } else {
    map.setView([19.16, 72.92], 11);
  }
  renderMap();
  renderHints();
  $("sb-live").textContent = "LIVE CITY";
}

function exitLive() {
  state.mode = "replay";
  $("sb-sky").hidden = true;
  heatPill();
  for (const m of state.regionMarkers) map.removeLayer(m);
  state.regionMarkers = [];
  if (state.regionTimer) { clearInterval(state.regionTimer); state.regionTimer = null; }
  map.setMinZoom(13);
  if (state.meta) map.setView(state.meta.area.center, state.meta.area.zoom);
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

function heatPill() {
  const el = $("heat-toggle");
  el.textContent = state.mode === "live"
    ? { now: "Heat · rain now", fc: "Heat · next 6 h", off: "Heat · off" }[state.heatMode]
    : `Heatmap · ${state.heatMode === "off" ? "off" : "on"}`;
  el.classList.toggle("on", state.heatMode !== "off");
  el.classList.toggle("fc", state.mode === "live" && state.heatMode === "fc");
}

$("heat-toggle").onclick = () => {
  // in LIVE the pill cycles now → forecast → off; in replay it just toggles
  state.heatMode = state.mode === "live"
    ? (state.heatMode === "now" ? "fc" : state.heatMode === "fc" ? "off" : "now")
    : (state.heatMode === "off" ? "now" : "off");
  state.heatOn = state.heatMode !== "off";
  heatPill();
  updateHeat();
};
// KPI tiles are doors, not decorations
document.querySelectorAll("#kpis .kpi")[0].onclick = () => document.querySelector('[data-tab="feed"]').click();
document.querySelectorAll("#kpis .kpi")[1].onclick = () => document.querySelector('[data-tab="feed"]').click();
document.querySelectorAll("#kpis .kpi")[2].onclick = () => document.querySelector('[data-tab="rain"]').click();
document.querySelectorAll("#kpis .kpi")[3].onclick = () => {
  const blocked = segRows().find((s) => s.state === "blocked");
  if (blocked) focusSegment(blocked.id, true);
};
$("engine-x").onclick = () => { $("engine-card").hidden = true; $("engine-prob").hidden = true; state.focusSeg = null; };
$("composer-toggle").onclick = () => {
  const body = $("composer-body");
  body.hidden = !body.hidden;
  $("composer-toggle").textContent = body.hidden ? "＋ File a citizen report" : "－ Close report form";
};
$("hint-x").onclick = () => { state.hintsOn = false; $("hintbar").style.display = "none"; };
$("fx-preview").onclick = () => {
  fx.previewUntil = Date.now() + 20000;
  $("fx-preview").textContent = "Downpour FX running… (visuals only)";
  setTimeout(() => ($("fx-preview").textContent = "☔ Preview downpour FX (visuals only)"), 20500);
};

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
