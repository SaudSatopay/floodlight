/* FLOODLIGHT ward instrument — client.
   One SSE stream in, one render pass out. No framework, no build step.
   Modes: REPLAY (storm library over any pilot area) and LIVE CITY
   (real 15-minutely rainfall via Open-Meteo, same hydrology).
   Weather is drawn, not just numbered: rain particles over the map,
   flow-lines on flooding streets. */

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  cloudMode: "sat",             // live clouds: "sat" (full imagery) | "subtle" | "off"
  cloudLayer: null,             // fallback veil (Open-Meteo cloud-cover grid)
  satLayer: null,               // the REAL clouds: Meteosat IR via EUMETSAT WMS
  satDead: false, satErr: 0,    // tile-error fallback bookkeeping
  satBucket: 0,                 // 10-min bucket → forces fresh frames
  riskPin: null,
  region: null,
  regionMarkers: [],
  regionTimer: null,
  watch: null,                  // /api/stormwatch payload
  watchTimer: null,
  watchMarkers: [],
  watchSel: null,               // selected world city id
  watchRain: 0, watchCloud: 0,  // drive the FX while visiting a city
  pendingWatch: null,           // ?watch=… deep link waiting for data
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- map */

const map = L.map("map", {
  zoomControl: false, attributionControl: true, minZoom: 13, maxZoom: 18,
}).setView([19.0135, 72.8447], 15);

L.control.zoom({ position: "bottomright" }).addTo(map);
window.__map = map;                 // demo/scripting handle

const baseTiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  className: "dark-tiles",
  maxZoom: 19,
}).addTo(map);

function fixMapSize() { map.invalidateSize({ animate: false }); }
window.addEventListener("resize", fixMapSize);
window.addEventListener("load", () => { fixMapSize(); setTimeout(fixMapSize, 250); setTimeout(fixMapSize, 900); });
setTimeout(fixMapSize, 60);

const SEG_STYLES = {
  ok:      { core: ["#3c4c6e", 0.9, 3.0] },
  watch:   { core: ["#ffb43b", 1.0, 4.5] },
  alert:   { core: ["#ff5546", 1.0, 5.0] },
  blocked: { core: ["#ffb43b", 1.0, 4.5], dash: "7 6", cls: "seg-blocked" },
};
const CASING = { color: "#040711", opacity: 0.85 };

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
        const col = r.tier === "HIGH" ? "#ff5546" : r.tier === "MODERATE" ? "#ffb43b" : "#8fb4c4";
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
      color: "#3c4c6e", opacity: 0.9, weight: 3,
      lineCap: "round", lineJoin: "round", className: "segcore",
      bubblingMouseEvents: false,
    }).addTo(map);
    const flow = L.polyline(latlngs, {
      color: "#dcf3fa", opacity: 0, weight: 1.7, dashArray: "3 11",
      lineCap: "round", lineJoin: "round", className: "flowline", interactive: false,
    }).addTo(map);
    state.layers[id] = { under, core, flow };
    core.on("click", () => focusSegment(id));
  }
  for (const d of meta.drains) {
    state.drainMarkers[d.id] = L.circleMarker([d.lat, d.lng], {
      radius: 3.5, color: "#41527a", fillColor: "#070b16", fillOpacity: 1, weight: 1.5,
      bubblingMouseEvents: false,
    }).addTo(map)
      .bindTooltip(`${d.id} · ${d.name}`, { direction: "top" })
      .bindPopup(() => {
        const live = state.snap && state.snap.drains.find((x) => x.id === d.id);
        const health = live ? live.health : 95;
        const col = health < 40 ? "#ff5546" : health < 60 ? "#ffb43b" : "#8fb4c4";
        return `<div class="pop-name">${d.id} · ${d.name}</div>
          <div class="pop-row">design capacity <b>${d.capacity_mm} mm / 15 min</b></div>
          <div class="pop-row">health belief <b style="color:${col}">${health}%</b>
          ${live && live.dispatched ? " · <b style=\"color:#ffb43b\">CREW DISPATCHED</b>" : ""}</div>
          <div class="pop-row">${health < 60 ? "surprising water upstream — likely choked" : "behaving as designed"}</div>`;
      });
  }
  const sf = meta.segments_geojson.features.find((f) => f.properties.id === meta.area.sensor_seg);
  if (sf) {
    const mid = sf.geometry.coordinates[Math.floor(sf.geometry.coordinates.length / 2)];
    state.sensorMarker = L.circleMarker([mid[1], mid[0]], {
      radius: 4.5, color: "#d9a94e", fillColor: "#d9a94e", fillOpacity: 0.8, weight: 1.5,
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

async function fetchJsonRetry(url, tries = 16, delay = 1500) {
  // Render free tier can 502 for a few seconds mid cold-start — a judge's
  // first load must survive that, not die silently with empty selects
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    if (i === 0) {
      const line = $("summary-line"), sub = $("summary-sub");
      if (line) line.textContent = "Waking the server\u2026";
      if (sub) sub.textContent = "free-tier cold start \u2014 give it a few seconds.";
    }
    await new Promise((res) => setTimeout(res, delay));
  }
  throw new Error(`unreachable: ${url}`);
}

async function refreshMeta() {
  const meta = await fetchJsonRetry("/api/meta");
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
  if (REDUCED) return 0;                 // no rain particles for reduced motion
  let mm = state.mode === "live"
    ? ((state.watchSel != null ? state.watchRain : (state.live ? state.live.rain_now : 0)) * 4)
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
  if (state.mode === "live" && state.watchSel != null) c = state.watchCloud;
  else if (state.mode === "live" && state.live && state.live.sky) c = state.live.sky.cloud_now;
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
  dim.addColorStop(0, `rgba(4, 7, 17, ${0.36 * k})`);
  dim.addColorStop(1, "rgba(4, 7, 17, 0)");
  ctx.fillStyle = dim;
  ctx.fillRect(0, 0, W, H * 0.55);
  // drifting cloud bellies along the top edge
  for (const b of fx.blobs) {
    b.x += (b.s * k) / W * 60;
    if (b.x * W - b.r * W > W) b.x = -b.r;
    const cx = b.x * W, cy = b.y * H, cr = b.r * W;
    const g = ctx.createRadialGradient(cx, cy, cr * 0.15, cx, cy, cr);
    g.addColorStop(0, `rgba(26, 35, 56, ${0.30 * k * b.o})`);
    g.addColorStop(0.7, `rgba(18, 25, 42, ${0.16 * k * b.o})`);
    g.addColorStop(1, "rgba(18, 25, 42, 0)");
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
    ctx.fillStyle = `rgba(244, 236, 221, ${fx.flash * 0.5})`;
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
  document.title = state.mode === "live" ? "LIVE · FLOODLIGHT"
    : s.finished ? `\u2713 ${s.clock} \u00b7 FLOODLIGHT`
    : state.running ? `\u25b6 ${s.clock} \u00b7 FLOODLIGHT`
    : "FLOODLIGHT \u00b7 Ward Instrument";
  $("clock-sub").textContent = s.finished ? "replay complete"
    : state.running ? `replay · minute ${s.minute}` : "replay paused";
  $("rain-now").textContent = s.rain_now;
  $("tide-now").textContent = s.tide_now.toFixed(1);
  $("tide-lock-bar").style.width = `${s.tide_lock * 100}%`;
  $("tide-lock-label").textContent =
    s.tide_lock >= 0.85 ? "OUTFALLS SEALED" : s.tide_lock > 0.3 ? "OUTFALLS CHOKING" : "OUTFALLS OPEN";
  if (s.tide_lock >= 0.85) {
    if (!snd.tideLatch) { snd.tideLatch = true; if (snd.on && state.running) sndSwell(); }
  } else if (s.tide_lock < 0.5) snd.tideLatch = false;

  $("sb-window").textContent = `WINDOW ${String(Math.max(0, s.step + 1)).padStart(2, "0")}/${s.rain_full.length} · MIN ${s.minute}`;
  $("sb-live").textContent = state.mode === "live" ? "LIVE CITY"
    : s.finished ? "COMPLETE" : state.running ? "RUNNING" : "STANDBY";
  $("storm-name").textContent = `${s.area_label} · ${s.storm_name}`;
  $("sb-outbox").textContent = `WA OUTBOX · ${s.outbox.mode.toUpperCase()} · ${s.outbox.sent}`;

  // odometer roll — the numbers physically climb as the ward reacts
  const rollKpi = (id, target, render) => {
    const el = $(id);
    const from = Number(el.dataset.v || 0);
    if (from === target) return;
    el.dataset.v = target;
    if (REDUCED) { el.innerHTML = render(target); return; }
    const t0 = performance.now();
    const dur = Math.min(700, 250 + Math.abs(target - from) * 10);
    const ease = (k) => 1 - Math.pow(1 - k, 3);
    cancelAnimationFrame(el._roll);
    const step = (ts) => {
      const k = Math.min(1, (ts - t0) / dur);
      el.innerHTML = render(Math.round(from + (target - from) * ease(k)));
      if (k < 1) el._roll = requestAnimationFrame(step);
    };
    el._roll = requestAnimationFrame(step);
    el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
  };
  rollKpi("k-alerts", s.kpis.alerts_sent, String);
  rollKpi("k-people", s.kpis.people_warned, (n) => n.toLocaleString("en-IN"));
  rollKpi("k-lead", s.kpis.avg_lead_min, (n) => `${n}<small> min</small>`);
  rollKpi("k-drains", s.kpis.drains_flagged, String);

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
      line.textContent = `${flooding} street${flooding === 1 ? "" : "s"} flooding${blocked ? ` · ${blocked} blocked drain${blocked === 1 ? "" : "s"} caught` : ""}.`;
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
  if (state.mode === "live") { setHint("LIVE CITY: real rain + real satellite clouds. STORM WATCH · EARTH (below the corridor strip, or the gold pill on the map) flies anywhere on the planet it is raining right now."); return; }
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
      gradient: { 0.15: "#16233f", 0.4: "#2e5570", 0.6: "#7fb4c9", 0.8: "#f0b84c", 1.0: "#ff5546" },
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
  updateClouds();
}

// EUMETSAT open WMS, no key. The layer is their curated GLOBAL mosaic
// ("Geostationary Ring IR 10.8 µm — Multimission"): seam-free and tonally
// balanced, unlike the raw per-satellite quicklooks whose scan segments
// arrive with mismatched stretches (hard black bands mid-frame).
const SAT_WMS = "https://view.eumetsat.int/geoserver/wms";
const SAT_LAYER = "mumi:worldcloudmap_ir108";

// subtle look — region zoom: clouds present; street zoom: streets win
const satOpacity = () => (map.getZoom() >= 13 ? 0.3 : 0.45);
// satellite mode only takes the frame over at true weather zooms — any
// closer and it yields to the subtle veil so the map always stays readable
const SAT_FULL_MAX_Z = 9;
function satZoomOpacity() { updateClouds(); }

function refreshSatClouds() {
  // bump the cache-buster every 10 min so the browser pulls fresh frames
  const bucket = Math.floor(Date.now() / 600000);
  if (state.satLayer && bucket !== state.satBucket) {
    state.satBucket = bucket;
    state.satLayer.setParams({ t: bucket });
  }
  updateClouds();
}

function updateClouds() {
  if (!window.L) return;
  const live = state.mode === "live" && state.cloudMode !== "off";
  const sat = live && !state.satDead;
  const full = state.cloudMode === "sat" && map.getZoom() <= SAT_FULL_MAX_Z;

  // 1 · satellite imagery — the actual clouds. Two looks:
  //     "sat"    — full IMD-style imagery, basemap dimmed to a ghost
  //     "subtle" — crushed + screen-blended, streets first
  if (sat) {
    if (!state.satLayer) {
      state.satBucket = Math.floor(Date.now() / 600000);
      state.satLayer = L.tileLayer.wms(SAT_WMS, {
        layers: SAT_LAYER, format: "image/png", transparent: true,
        version: "1.1.1", opacity: satOpacity(), className: "sat-clouds",
        keepBuffer: 4, updateWhenZooming: false, maxNativeZoom: 11,
        attribution: 'clouds © <a href="https://view.eumetsat.int">EUMETSAT</a> IR mosaic',
        t: state.satBucket,
      }).addTo(map);
      map.on("zoomend", satZoomOpacity);
      state.satErr = 0;
      state.satLayer.on("tileerror", () => {
        // a run of failures = feed down → fall back to the data veil
        if (++state.satErr >= 6 && !state.satDead) {
          state.satDead = true;
          updateClouds();
        }
      });
      state.satLayer.on("tileload", () => { state.satErr = 0; });
    }
    if (state.satLayer._container)
      state.satLayer._container.classList.toggle("sat-full", full);
    state.satLayer.setOpacity(full ? 0.85 : satOpacity());
    baseTiles.setOpacity(full ? 0.45 : 1);
    $("cloud-toggle").title = "real clouds · geostationary-ring infrared mosaic (10.8 µm) · EUMETSAT"
      + (state.cloudMode === "sat" ? " · full imagery when zoomed out, subtle over streets" : "");
  } else {
    if (state.satLayer) {
      map.off("zoomend", satZoomOpacity);
      map.removeLayer(state.satLayer);
      state.satLayer = null;
    }
    baseTiles.setOpacity(1);
  }

  // 2 · fallback veil from the 42-pt cloud-cover grid — only when the
  //     satellite feed is unreachable (still real data, just interpolated)
  if (!L.heatLayer) return;
  if (!state.cloudLayer) {
    state.cloudLayer = L.heatLayer([], {
      radius: 90, blur: 70, maxZoom: 12, max: 1.0,
      gradient: { 0.1: "#1b2740", 0.45: "#4a5b78", 0.75: "#93a5b8", 1.0: "#e8eef4" },
    }).addTo(map);
    if (state.cloudLayer._canvas) state.cloudLayer._canvas.classList.add("cloud-canvas");
    // rain heat must stay ABOVE the cloud veil — re-append its canvas last
    if (state.heatLayer && state.heatLayer._canvas)
      map.getPanes().overlayPane.appendChild(state.heatLayer._canvas);
  }
  const pts = [];
  if (live && !sat && state.live && state.live.heat) {
    for (const h of state.live.heat) {
      if ((h.cloud || 0) >= 12) pts.push([h.lat, h.lng, h.cloud / 100]);
    }
  }
  state.cloudLayer.setLatLngs(pts);
}

/* ---------------------------------------------------- tap-anywhere risk */

const fmtDist = (m) => (m >= 1500 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

function riskPopupHtml(r) {
  if (r.covered === false) {
    return `<div class="risk-pop">
      <div class="rp-head">${r.water ? "OPEN WATER" : "OUTSIDE MONITORED STREETS"}</div>
      <div class="rp-nc">${r.water ? "Seas, creeks and lakes don't waterlog — no percentage here."
        : "Nothing here to waterlog."} Nearest monitored street:
        <b>${r.segment}</b>${r.area_label ? ` (${r.area_label})` : ""} · <b>${fmtDist(r.distance_m)}</b>.</div>
      <div class="rp-note">FLOODLIGHT scores streets & drains — it never invents a percentage
        for water.</div>
    </div>`;
  }
  const col = r.tier === "HIGH" ? "#ff5546" : r.tier === "MODERATE" ? "#ffb43b" : "#8fb4c4";
  const pct = Math.round(r.probability * 100);
  const bar = (label, frac, val) => `
    <div class="rp-driver"><span>${label}</span>
      <div class="rp-track"><i style="width:${Math.round(Math.min(1, frac) * 100)}%"></i></div>
      <b>${val}</b></div>`;
  if (r.grade === "estimate") {
    return `<div class="risk-pop">
      <div class="rp-head">WATERLOGGING PROBABILITY <span class="rp-est">AREA ESTIMATE</span></div>
      <div class="rp-line"><span class="rp-big" style="color:${col}">${pct}%</span>
        <span class="rp-tier" style="color:${col};border-color:${col}">${r.tier}</span></div>
      <div class="rp-sub">no instrumented street here — scored from the real rain at
        <b>this exact spot</b> + a typical dense-city street profile${r.elevation_m != null ? ` · ground ~${r.elevation_m} m` : ""}</div>
      ${bar("projected peak", r.projected_peak_cm / 45, r.projected_peak_cm + " cm")}
      ${bar("rain next hour", r.rain_next_hour_mm / 60, r.rain_next_hour_mm + " mm")}
      ${r.tide_note
        ? `<div class="rp-sub">tide — not modelled outside the MMR · scored neutral</div>`
        : bar("tide lock", r.tide_lock, Math.round(r.tide_lock * 100) + "%")}
      <div class="rp-sub">nearest instrumented street: <b>${r.nearest.segment}</b>
        (${r.nearest.area_label}) · ${fmtDist(r.nearest.distance_m)}</div>
      <div class="rp-note">computed from today's REAL rain · corridor-grade answers need a
        mapped corridor — that's onboarding, not modelling</div>
    </div>`;
  }
  return `<div class="risk-pop">
    <div class="rp-head">WATERLOGGING PROBABILITY</div>
    <div class="rp-line"><span class="rp-big" style="color:${col}">${pct}%</span>
      <span class="rp-tier" style="color:${col};border-color:${col}">${r.tier}</span></div>
    <div class="rp-sub">nearest street: <b>${r.segment}</b> · ${r.distance_m} m away${r.area_label ? ` · ${r.area_label}` : ""}</div>
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
  const col = r.covered === false ? "#6b7a99"
    : r.tier === "HIGH" ? "#ff5546" : r.tier === "MODERATE" ? "#ffb43b" : "#8fb4c4";
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
        color: hot ? "#ffb43b" : "#41527a",
        fillColor: hot ? "#1a1408" : "#070b16",
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

/* Storm-profile chart — two stacked lanes on a shared clock (never a
   dual axis): RAIN bars, single ice hue with certainty encoded (past
   solid, current bright, future outlined), and the TIDE lane with the
   ~3 m outfall-seal threshold drawn and the locked stretch tinted. */

const CH = {
  bar: "#3e6e8c", barNow: "#a8d8e8", barFuture: "#17273f", barFutureLine: "#2b4a66",
  tide: "#c9c1ad", lock: "#ffb43b", grid: "#1c2a47", label: "#837f6e",
  value: "#f4ecdd", hover: "#f4ecdd",
};

function barTop(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, [r, r, 0, 0]);
  else ctx.rect(x, y, w, h);
}

const chartTip = {
  el: null,
  show(host, cx, html) {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "chart-tip";
      document.body.appendChild(this.el);
    }
    const r = host.getBoundingClientRect();
    this.el.innerHTML = html;
    this.el.hidden = false;
    const w = this.el.offsetWidth;
    this.el.style.left = `${Math.min(Math.max(r.left + cx - w / 2, 8), innerWidth - w - 8)}px`;
    this.el.style.top = `${r.top - this.el.offsetHeight - 8}px`;
  },
  hide() { if (this.el) this.el.hidden = true; },
};

function clockAt(s, i) {
  const start = (state.meta ? state.meta.storm.start_clock : "14:00").split(":").map(Number);
  const min = start[0] * 60 + start[1] + i * 15;
  return `${Math.floor(min / 60) % 24}:${String(min % 60).padStart(2, "0")}`;
}

function renderChart(hoverIdx = null) {
  const s = state.snap;
  if (!s) return;
  const cv = $("rain-chart");
  if (!cv.clientWidth) return;
  const ctx = cv.getContext("2d");
  const W = (cv.width = cv.clientWidth * 2);
  const H = (cv.height = 430);
  ctx.clearRect(0, 0, W, H);
  const n = s.rain_full.length;
  const padL = 10, padR = 10;
  const bw = (W - padL - padR) / n;
  const top = 26, rainH = 188, laneGap = 46, tideH = 108;
  const tideTop = top + rainH + laneGap;
  const niceMax = Math.max(10, Math.ceil(Math.max(...s.rain_full, 1) / 10) * 10);
  const peakIdx = s.rain_full.indexOf(Math.max(...s.rain_full));

  ctx.font = '700 15px "Space Mono", monospace';
  ctx.textAlign = "left";
  ctx.fillStyle = CH.label;
  ctx.fillText("RAIN · MM / 15 MIN", padL, 16);
  ctx.fillText("TIDE · M", padL, tideTop - 12);

  // recessive grid: baseline + faint mid rule
  ctx.strokeStyle = CH.grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, top + rainH + 0.5); ctx.lineTo(W - padR, top + rainH + 0.5); ctx.stroke();
  ctx.setLineDash([2, 6]);
  ctx.beginPath(); ctx.moveTo(padL, top + rainH / 2 + 0.5); ctx.lineTo(W - padR, top + rainH / 2 + 0.5); ctx.stroke();
  ctx.setLineDash([]);

  // rain bars — one hue, certainty encoded
  s.rain_full.forEach((mm, i) => {
    const h = Math.max(4, (mm / niceMax) * rainH);
    const x = padL + i * bw + 5, w = Math.max(6, bw - 10);
    const y = top + rainH - h;
    if (i > s.step) {                       // future: outlined, barely inked
      ctx.fillStyle = CH.barFuture;
      barTop(ctx, x, y, w, h, 4); ctx.fill();
      ctx.strokeStyle = CH.barFutureLine; ctx.lineWidth = 1.5;
      barTop(ctx, x, y, w, h, 4); ctx.stroke();
    } else {
      ctx.fillStyle = i === s.step ? CH.barNow : CH.bar;
      barTop(ctx, x, y, w, h, 4); ctx.fill();
    }
    if (i === hoverIdx) {
      ctx.strokeStyle = CH.hover; ctx.lineWidth = 2;
      barTop(ctx, x - 2, y - 2, w + 4, h + 2, 5); ctx.stroke();
    }
  });
  // selective labels: the peak and the live window only
  ctx.font = '700 17px "Space Mono", monospace';
  ctx.textAlign = "center";
  const label = (i, col) => {
    const mm = s.rain_full[i];
    const y = top + rainH - Math.max(4, (mm / niceMax) * rainH) - 8;
    ctx.fillStyle = col;
    ctx.fillText(String(mm), padL + i * bw + bw / 2, y);
  };
  if (peakIdx <= s.step || true) label(peakIdx, CH.value);
  if (s.step >= 0 && s.step !== peakIdx) label(s.step, CH.barNow);

  // tide lane — the ~3 m seal threshold, locked stretch tinted
  const tMin = 1.2, tMax = 4.9;
  const ty = (v) => tideTop + tideH - ((v - tMin) / (tMax - tMin)) * tideH;
  const tide = (s.tide_full || []).slice(0, n);
  const tx = (i) => padL + i * bw + bw / 2;
  const yLock = ty(3.0);
  // locked area first (under the curve, above the threshold)
  ctx.beginPath();
  let inLock = false;
  tide.forEach((v, i) => {
    const x = tx(i), y = Math.min(ty(v), yLock);
    if (!inLock) { ctx.moveTo(x, yLock); inLock = true; }
    ctx.lineTo(x, y);
  });
  if (inLock) {
    ctx.lineTo(tx(n - 1), yLock); ctx.closePath();
    ctx.fillStyle = "rgba(255, 180, 59, 0.16)";
    ctx.fill();
  }
  // threshold rule
  ctx.strokeStyle = CH.lock; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(padL, yLock + 0.5); ctx.lineTo(W - padR, yLock + 0.5); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '700 14px "Space Mono", monospace';
  ctx.textAlign = "right";
  ctx.fillStyle = CH.lock;
  ctx.fillText("OUTFALLS SEAL ~3 M", W - padR, yLock - 7);
  // the tide line itself
  ctx.strokeStyle = CH.tide; ctx.lineWidth = 2.5;
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.beginPath();
  tide.forEach((v, i) => (i === 0 ? ctx.moveTo(tx(i), ty(v)) : ctx.lineTo(tx(i), ty(v))));
  ctx.stroke();

  // shared clock axis
  ctx.font = '400 15px "Space Mono", monospace';
  ctx.textAlign = "center";
  ctx.fillStyle = CH.label;
  for (let i = 0; i < n; i++) {
    const clock = clockAt(s, i);
    if (clock.endsWith(":00")) ctx.fillText(clock, padL + i * bw + bw / 2, H - 8);
  }

  // live cursor through both lanes
  if (s.step >= 0 && !s.finished) {
    const x = padL + s.step * bw + bw / 2;
    ctx.strokeStyle = "rgba(168, 216, 232, 0.4)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top - 6); ctx.lineTo(x, tideTop + tideH); ctx.stroke();
  }
  // hover crosshair
  if (hoverIdx != null) {
    const x = padL + hoverIdx * bw + bw / 2;
    ctx.strokeStyle = "rgba(244, 236, 221, 0.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top - 6); ctx.lineTo(x, tideTop + tideH); ctx.stroke();
  }
}

function bindRainHover() {
  const cv = $("rain-chart");
  if (cv.dataset.hover) return;
  cv.dataset.hover = "1";
  cv.addEventListener("mousemove", (e) => {
    const s = state.snap;
    if (!s) return;
    const n = s.rain_full.length;
    const rect = cv.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(n - 1, Math.floor(frac * n)));
    renderChart(i);
    const tideV = (s.tide_full || [])[i];
    chartTip.show(cv, (i + 0.5) * (rect.width / n),
      `<b>${clockAt(s, i)}</b> · ${s.rain_full[i]} mm${tideV != null ? ` · tide ${tideV.toFixed(1)} m${tideV >= 3 ? " · SEALED" : ""}` : ""}${i > s.step ? " · ahead" : ""}`);
  });
  cv.addEventListener("mouseleave", () => { chartTip.hide(); renderChart(); });
  // the chart is a scrubber: click a window, the replay jumps there
  cv.style.cursor = "pointer";
  cv.addEventListener("click", async (e) => {
    const s = state.snap;
    if (!s || state.mode === "live" || tour.on) return;
    const rect = cv.getBoundingClientRect();
    const i = Math.max(0, Math.min(s.rain_full.length - 1,
      Math.floor(((e.clientX - rect.left) / rect.width) * s.rain_full.length)));
    clearLocalRun();
    await control({ action: "seek", step: i });
  });
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

const OL_COL = (mm) => (mm >= 5 ? "#ff5546" : mm >= 1.5 ? "#ffb43b" : "#7fb4c9");

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
  const sum = l.outlook && l.outlook.summary;
  const fbNote = l.fallback === "metno" ? " · met.no fallback (hourly forecast, no past rain)" : "";
  $("live-under").textContent = (l.stale_min
    ? `last good reading · ${l.stale_min} min old — live feed retrying`
    : l.degraded
    ? "live feed unreachable — showing zero-rain baseline (DEGRADED)"
    : l.rain_now >= 4 ? `heavy rain over ${l.area_label} right now`
    : l.rain_now > 0.2 ? `raining over ${l.area_label} right now`
    : sum && (sum.level === "storm-inbound" || sum.level === "rain-soon")
      ? `dry over ${l.area_label} — but rain is on the way (see forecast)`
    : sum && sum.level === "overcast" ? `dry over ${l.area_label} — heavy cloud overhead`
    : `dry over ${l.area_label} right now`) + fbNote;
  $("live-3h").textContent = l.past_3h_total.toFixed(1);
  $("live-next").textContent = l.next.reduce((a, b) => a + b, 0).toFixed(1);
  $("live-tide").textContent = l.tide_est.toFixed(1);
  renderSky();
  renderOutlook();
  refreshSatClouds();

  renderLiveChart();

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

/* live-city mini chart — same single-hue language: real past solid,
   the live window bright, the forecast outlined (not yet real) */
function renderLiveChart(hoverIdx = null) {
  const l = state.live;
  const cv = $("live-chart");
  if (!l || !cv || !cv.clientWidth) return;
  const ctx = cv.getContext("2d");
  const W = (cv.width = cv.clientWidth * 2), H = (cv.height = 220);
  ctx.clearRect(0, 0, W, H);
  const series = [...l.past, l.rain_now, ...l.next];
  const nowIdx = l.past.length;
  const bw = W / series.length;
  const mx = Math.max(...series, 0.8);
  ctx.strokeStyle = CH.grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - 26.5); ctx.lineTo(W, H - 26.5); ctx.stroke();
  series.forEach((mm, i) => {
    const h = Math.max(3, (mm / mx) * (H - 58));
    const x = i * bw + 4, w = Math.max(4, bw - 8), y = H - 26 - h;
    if (i > nowIdx) {
      ctx.fillStyle = CH.barFuture;
      barTop(ctx, x, y, w, h, 3); ctx.fill();
      ctx.strokeStyle = CH.barFutureLine; ctx.lineWidth = 1.5;
      barTop(ctx, x, y, w, h, 3); ctx.stroke();
    } else {
      ctx.fillStyle = i === nowIdx ? CH.barNow : CH.bar;
      barTop(ctx, x, y, w, h, 3); ctx.fill();
    }
    if (i === hoverIdx) {
      ctx.strokeStyle = CH.hover; ctx.lineWidth = 2;
      barTop(ctx, x - 2, y - 2, w + 4, h + 2, 4); ctx.stroke();
    }
  });
  ctx.fillStyle = CH.label;
  ctx.font = '400 15px "Space Mono", monospace';
  ctx.textAlign = "center";
  ctx.fillText("−3H", bw * 1.4, H - 8);
  ctx.fillStyle = CH.barNow;
  ctx.fillText("NOW", (nowIdx + 0.5) * bw, H - 8);
  ctx.fillStyle = CH.label;
  ctx.fillText("+2H · FC", W - bw * 2, H - 8);
}

function bindLiveHover() {
  const cv = $("live-chart");
  if (cv.dataset.hover) return;
  cv.dataset.hover = "1";
  cv.addEventListener("mousemove", (e) => {
    const l = state.live;
    if (!l) return;
    const series = [...l.past, l.rain_now, ...l.next];
    const nowIdx = l.past.length;
    const rect = cv.getBoundingClientRect();
    const i = Math.max(0, Math.min(series.length - 1,
      Math.floor(((e.clientX - rect.left) / rect.width) * series.length)));
    renderLiveChart(i);
    const rel = i === nowIdx ? "this 15-min window"
      : i < nowIdx ? `${(nowIdx - i) * 15} min ago` : `+${(i - nowIdx) * 15} min · forecast`;
    chartTip.show(cv, (i + 0.5) * (rect.width / series.length),
      `<b>${series[i].toFixed(1)} mm</b> · ${rel}`);
  });
  cv.addEventListener("mouseleave", () => { chartTip.hide(); renderLiveChart(); });
}

const TIER_COL = { HIGH: "#ff5546", MODERATE: "#ffb43b", LOW: "#8fb4c4" };

async function pollRegion() {
  try {
    state.region = await (await fetch("/api/region")).json();
  } catch { return; }
  const list = $("region-list");
  if (!list) return;
  $("region-upd").textContent = state.region.stale_min
    ? `last good ${state.region.updated} · retrying`
    : state.region.degraded ? "feed degraded"
    : `updated ${state.region.updated}${state.region.src === "metno" ? " · met.no" : ""}`;
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
      <span class="rr-rain">${a.cloud != null ? `${a.cloud}% CLOUD · ` : ""}${a.rain_now.toFixed(1)} mm · 3h ${a.past_3h.toFixed(1)}${fc}</span>`;
    if (rising) div.title = `forecast: risk climbs to ${a.risk_next_pct}% within 6 h (${a.next6_mm} mm expected)`;
    div.onclick = async () => {
      clearLocalRun();
      clearWatchSel();
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
      clearWatchSel();
      await control({ action: "load", area: a.id });
      await refreshMeta();
      pollLive();
      map.setView(a.center, 15);
    });
    state.regionMarkers.push(m);
  }
}

/* ------------------------------------------------ STORM WATCH · EARTH */
/* The credibility feature: it is always raining somewhere. The scanner
   ranks 32 flood-famous world cities by what the engine reads in their
   REAL rain right now; tapping one flies the map there under the real
   satellite clouds and answers with the honest area estimate. */

function clearWatchSel() { state.watchSel = null; state.watchRain = 0; state.watchCloud = 0; }

async function pollWatch() {
  try {
    state.watch = await (await fetch("/api/stormwatch")).json();
  } catch {
    // a dropped request must not strand the scanner until the next
    // 10-minute tick — retry soon while the live pane is open
    clearTimeout(state.watchFastTimer);
    if (state.mode === "live") state.watchFastTimer = setTimeout(pollWatch, 20000);
    return;
  }
  renderWatch();
  // incremental sweeps: while coverage is partial (throttled primary),
  // nudge the server every ~25 s so the table fills within minutes
  const w = state.watch;
  clearTimeout(state.watchFastTimer);
  if (state.mode === "live" && w && (w.degraded ||
      (w.coverage_total && w.coverage_n < w.coverage_total))) {
    state.watchFastTimer = setTimeout(pollWatch, 25000);
  }
  if (state.pendingWatch && state.watch && !state.watch.degraded && state.watch.cities.length) {
    const want = state.pendingWatch;
    state.pendingWatch = null;
    const c = state.watch.cities.find((x) => x.id === want) || state.watch.cities[0];
    setTimeout(() => gotoWatchCity(c), 900);
  }
}

function renderWatch() {
  const list = $("watch-list");
  if (!list || !state.watch) return;
  const w = state.watch;
  const cov = w.coverage_total && w.coverage_n < w.coverage_total
    ? ` · ${w.coverage_n}/${w.coverage_total} cities` : "";
  $("watch-upd").textContent = w.stale_min
    ? `last good scan ${w.updated} IST · retrying`
    : w.degraded ? "scanner unreachable — retrying"
    : `updated ${w.updated} IST · ${w.src === "metno" ? "met.no fallback" : "open-meteo"}${cov}`;
  const scan = $("watch-scan");
  if (scan) {
    const partial = !w.degraded && w.coverage_total && w.coverage_n < w.coverage_total;
    scan.hidden = !partial;
    if (partial) scan.firstElementChild.style.width =
      `${Math.round((100 * w.coverage_n) / w.coverage_total)}%`;
  }
  if (w.degraded || !w.cities.length) {
    list.innerHTML = `<div class="watch-wait">${w.degraded
      ? "scanner unreachable from this network — retrying shortly" : "no data yet"}</div>`;
    return;
  }
  list.innerHTML = "";
  const shown = w.cities.slice(0, 10);
  // one shared scale so the six-hour strips compare across cities
  const gmax = Math.max(1, ...shown.flatMap((c) => c.fc6 || []));
  for (const c of shown) {
    const wet = c.rain_now >= 0.2 || c.tier_next !== "LOW";
    const rising = c.risk_next_pct - c.risk_pct >= 8;
    const div = document.createElement("div");
    div.className = `watch-row${wet ? " wet" : ""}${state.watchSel === c.id ? " sel" : ""}`;
    let spark = "";
    if (c.fc6 && c.fc6.length) {
      const pk = c.fc6.indexOf(Math.max(...c.fc6));
      spark = `<span class="wr-spark" title="next 6 h · ${c.fc6.map((v) => v.toFixed(1)).join(" · ")} mm/h">${
        c.fc6.map((v, i) => `<i${i === pk && v >= 0.5 ? ' class="pk"' : ""} style="height:${
          Math.max(1, Math.round(13 * v / gmax))}px"></i>`).join("")}</span>`;
    }
    div.innerHTML = `
      <span class="wr-risk" style="color:${TIER_COL[c.tier]}">${c.risk_pct}%</span>
      ${rising ? `<span class="rr-next" style="color:${TIER_COL[c.tier_next]}">▲${c.risk_next_pct}%</span>` : ""}
      <span class="wr-city">${c.city} <i>${c.cc}</i></span>
      ${spark}
      <span class="wr-met">${c.rain_now >= 0.2 ? `<b>${c.rain_now.toFixed(1)} MM NOW</b> · ` : ""}3H ${c.past_3h.toFixed(1)} · FC6 ${c.next6_mm.toFixed(1)} · ${c.local} LOCAL${c.age_min >= 20 ? ` · ${c.age_min}M OLD` : ""}</span>`;
    div.title = `${c.city}: ${c.sky} · fly there`;
    div.onclick = () => gotoWatchCity(c);
    list.appendChild(div);
  }
  renderWatchMarkers();
}

function renderWatchMarkers() {
  for (const m of state.watchMarkers) map.removeLayer(m);
  state.watchMarkers = [];
  if (state.mode !== "live" || !state.watch || state.watch.degraded) return;
  for (const c of state.watch.cities) {
    if (c.rain_now < 0.5 && c.tier_next === "LOW") continue;      // only where weather is
    const col = TIER_COL[c.tier_next];
    const m = L.circleMarker([c.lat, c.lng], {
      radius: 5.5, color: col, weight: 2, fillColor: col, fillOpacity: 0.3,
      bubblingMouseEvents: false,
    }).addTo(map)
      .bindTooltip(`${c.city} — ${c.risk_pct}%${c.risk_next_pct - c.risk_pct >= 8 ? ` ▲${c.risk_next_pct}%` : ""} · ${c.rain_now.toFixed(1)} mm now · ${c.sky}`, { direction: "top" });
    m.on("click", () => gotoWatchCity(c));
    state.watchMarkers.push(m);
  }
}

function gotoWatchCity(c) {
  state.watchSel = c.id;
  state.watchRain = c.rain_now;
  state.watchCloud = c.cloud || 0;
  renderWatch();
  map.flyTo([c.lat, c.lng], 11, { duration: 2.4 });
  const tone = c.tier_next === "HIGH" ? "red" : c.tier_next === "MODERATE" ? "amber" : "teal";
  showLT(`STORM WATCH · ${c.city.toUpperCase()} ${c.cc} · ${c.local} LOCAL`,
    `${c.rain_now >= 0.2 ? `${c.rain_now.toFixed(1)} mm/15 min falling right now` : `${c.sky[0].toUpperCase()}${c.sky.slice(1)}`} — the same hydrology, fed this city's real rain. ${
      c.risk_next_pct >= c.risk_pct + 8 ? `${c.risk_pct}% now, ${c.risk_next_pct}% within six hours.` : `${c.risk_pct}% on a typical dense street.`}`,
    tone, 9000);
  // let the flight land, then answer at the exact centre — the honest
  // AREA ESTIMATE popup, computed from the rain at that spot
  setTimeout(() => { if (state.watchSel === c.id) riskAt(L.latLng(c.lat, c.lng)); }, 2600);
}

function enterLive() {
  state.mode = "live";
  $("live-dot").hidden = false;
  heatPill();
  cloudPill();
  $("cloud-toggle").hidden = false;
  $("earth-pill").hidden = false;
  if (state.live) { renderSky(); renderOutlook(); }   // instant paint from cache
  pollLive();
  pollRegion();
  pollWatch();
  if (!state.liveTimer) state.liveTimer = setInterval(pollLive, 60000);
  if (!state.regionTimer) state.regionTimer = setInterval(pollRegion, 120000);
  if (!state.watchTimer) state.watchTimer = setInterval(pollWatch, 600000);
  // pull back as far as the whole PLANET — storm watch flies worldwide and
  // the EUMETSAT mosaic is global, so the zoomed-out view is a live globe
  map.setMinZoom(3);
  if (state.region && state.region.areas.length) {
    map.fitBounds(L.latLngBounds(state.region.areas.map((a) => a.center)).pad(0.18));
  } else {
    map.setView([19.16, 72.92], 11);
  }
  renderMap();
  renderHints();
  syncUrl({ live: 1 });
  $("sb-live").textContent = "LIVE CITY";
}

function exitLive() {
  state.mode = "replay";
  $("sb-sky").hidden = true;
  heatPill();
  $("cloud-toggle").hidden = true;
  $("earth-pill").hidden = true;
  updateClouds();
  clearWatchSel();
  for (const m of state.regionMarkers) map.removeLayer(m);
  state.regionMarkers = [];
  for (const m of state.watchMarkers) map.removeLayer(m);
  state.watchMarkers = [];
  if (state.regionTimer) { clearInterval(state.regionTimer); state.regionTimer = null; }
  if (state.watchTimer) { clearInterval(state.watchTimer); state.watchTimer = null; }
  map.setMinZoom(13);
  if (state.meta) map.setView(state.meta.area.center, state.meta.area.zoom);
  renderMap();
  syncUrl();
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
  // a reset (ours, a deep link, another client) rewinds the storm clock —
  // drop the dedupe set or the fresh run's identical ids render nothing
  if (state.lastFeedStep !== undefined && s.step < state.lastFeedStep) {
    state.renderedFeed.clear();
    feed.innerHTML = "";
    state.feedUnseen = 0;
    $("feed-badge").hidden = true;
  }
  state.lastFeedStep = s.step;
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
      minute: a.minute, key: `a-${a.id}`, alert: a,
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
    if (it.alert) { notifyAlert(it.alert); sndForAlert(it.alert); }
  }
  feed.scrollTop = feed.scrollHeight;
}

/* ------------------------------------------------------- stage sound */
/* Opt-in (S key) — a tiny WebAudio synth, no files, works offline.
   A sonar ping per street alert, a brass thunk when the Cause B crew
   is dispatched, a low swell when the tide seals the outfalls. */

const snd = { on: false, ctx: null, master: null, lastPing: 0, tideLatch: false };

function sndInit() {
  if (snd.ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  snd.ctx = new AC();
  snd.master = snd.ctx.createGain();
  snd.master.gain.value = 0.5;
  snd.master.connect(snd.ctx.destination);
  return true;
}

function sndTone({ f0, f1, type = "sine", t = 0.6, peak = 0.2, a = 0.012 }) {
  if (!snd.on || !snd.ctx) return;
  const c = snd.ctx, t0 = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + t * 0.85);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + t);
  o.connect(g); g.connect(snd.master);
  o.start(t0); o.stop(t0 + t + 0.05);
}

function sndPing() {                          // street alert — sonar
  const now = performance.now();
  if (now - snd.lastPing < 700) return;
  snd.lastPing = now;
  sndTone({ f0: 1180, f1: 640, t: 0.55, peak: 0.18 });
  sndTone({ f0: 1770, f1: 960, t: 0.4, peak: 0.05 });
}
function sndThunk() {                         // Cause B dispatch — brass
  sndTone({ f0: 196, f1: 98, type: "triangle", t: 0.42, peak: 0.26 });
  sndTone({ f0: 392, f1: 196, type: "triangle", t: 0.3, peak: 0.08 });
}
function sndSwell() {                         // outfalls sealed — low tide
  sndTone({ f0: 82, f1: 55, t: 1.6, peak: 0.2, a: 0.5 });
  sndTone({ f0: 123, f1: 82, t: 1.3, peak: 0.08, a: 0.45 });
}

function sndToggle() {
  if (!sndInit()) { showLT("STAGE SOUND", "WebAudio unavailable in this browser.", "amber", 2600); return; }
  snd.on = !snd.on;
  if (snd.ctx.state === "suspended") snd.ctx.resume();
  $("snd-pill").hidden = !snd.on;
  showLT(`STAGE SOUND ${snd.on ? "ON" : "OFF"}`,
    snd.on ? "Alerts ping · the dispatch lands low · the tide seals with a swell."
           : "Muted.", "teal", 2400);
  if (snd.on) { snd.lastPing = 0; sndPing(); }
}

function sndForAlert(a) {
  if (!snd.on || !state.snap) return;
  if (a.minute < state.snap.minute - 15) return;   // seek / reconnect backlog stays quiet
  if (a.kind === "street") sndPing();
  else if (a.kind === "dispatch") sndThunk();
}

/* ---------------------------------------- lower-third + guided tour */
/* One cinematic caption bar over the map. Live alerts borrow it; the
   TOUR drives the whole replay with it — every line derived from real
   snapshot data, nothing scripted that the engine didn't do. */

const lt = { timer: null };

function showLT(kicker, main, tone = "teal", ms = 5200) {
  const el = $("lowerthird");
  clearTimeout(lt.timer);
  el.className = tone;
  el.hidden = false;
  el.classList.remove("out");
  $("lt-kicker").textContent = kicker;
  $("lt-main").textContent = main;
  lt.timer = setTimeout(() => {
    el.classList.add("out");
    lt.timer = setTimeout(() => { el.hidden = true; }, 500);
  }, ms);
}

const tour = { on: false, done: new Set(), holdUntil: 0, sawRun: false };

function startTour() {
  if (state.mode === "live") document.querySelector('[data-tab="status"]').click();
  tour.on = true;
  tour.done.clear();
  tour.holdUntil = 0;
  tour.sawRun = false;
  $("btn-tour").classList.add("on");
  state.mapHintDone = true;
  $("map-hint").hidden = true;
  clearLocalRun();
  document.querySelectorAll(".spd").forEach((x) => x.classList.toggle("active", x.dataset.speed === "1"));
  control({ action: "reset" })
    .then(() => control({ action: "speed", speed: 1 }))
    .then(() => control({ action: "start" }));
  const m = state.meta;
  showLT(`GUIDED RUN · ${m ? m.storm.name.toUpperCase() : "STORM REPLAY"}`,
    `${state.snap ? state.snap.area_label : "The ward"}, replayed exactly as the gauges recorded it. Watch the streets — and the one drain the rain can't explain.`,
    "teal", 7000);
  tour.done.add("intro");
  tour.holdUntil = Date.now() + 4000;
}

function endTour() {
  tour.on = false;
  $("btn-tour").classList.remove("on");
  const el = $("lowerthird");
  el.classList.add("out");
  setTimeout(() => { el.hidden = true; }, 500);
}

function segMid(segId) {
  const trio = state.layers[segId];
  if (!trio) return null;
  const ll = trio.core.getLatLngs();
  return ll[Math.floor(ll.length / 2)];
}

function tourTick() {
  const s = state.snap;
  if (!s || Date.now() < tour.holdUntil) return;
  // the first snapshots can be the PREVIOUS run (SSE greets us with stale
  // state while our reset is in flight) — wait until the fresh run ticks
  if (!tour.sawRun) {
    if (s.step >= 0 && !s.finished && s.running) tour.sawRun = true;
    else return;
  }
  const fire = (key, hold, fn) => { if (!tour.done.has(key)) { tour.done.add(key); fn(); tour.holdUntil = Date.now() + hold; return true; } return false; };

  const dispatch = s.alerts.find((a) => a.kind === "dispatch");
  if (dispatch && !tour.done.has("dispatch")) {
    return void fire("dispatch", 6500, () => {
      const drainId = dispatch.meta && dispatch.meta.drain_id;
      const drain = state.meta.drains.find((d) => d.id === drainId);
      if (drain) map.flyTo([drain.lat, drain.lng], 16, { duration: 1.4 });
      focusSegment(dispatch.segment_id, false);
      showLT(`MIN ${dispatch.minute} · CAUSE B · BLOCKED DRAIN`,
        `Far more water than this rain can explain — ${drainId || "the drain"} flagged, crew dispatched with the photo evidence attached.`,
        "amber", 7500);
    });
  }
  // showcase a street that got a genuine head start, not the blocked one
  const street = s.alerts.find((a) => a.kind === "street" && a.lead_min > 0)
    || (tour.done.has("dispatch") ? s.alerts.find((a) => a.kind === "street") : null);
  if (street && !tour.done.has("street")) {
    return void fire("street", 6500, () => {
      const row = currentRow(street.segment_id);
      const mid = segMid(street.segment_id);
      if (mid) map.flyTo(mid, 16, { duration: 1.4 });
      focusSegment(street.segment_id, false);
      showLT(`MIN ${street.minute} · CAUSE A · RAIN OVERLOAD`,
        `${row ? row.name : street.segment_id} — ${street.subscribers} phones buzz in Marathi, Hindi and English${
          street.lead_min > 0 ? `, T−${street.lead_min} minutes before the water` : ""}.`,
        "red", 7500);
    });
  }
  if (s.tide_lock >= 0.85 && !tour.done.has("tide")) {
    return void fire("tide", 5200, () => {
      map.flyTo(state.meta.area.center, state.meta.area.zoom, { duration: 1.4 });
      showLT(`TIDE ${s.tide_now.toFixed(1)} M · OUTFALLS SEALED`,
        "Spring tide seals the outfalls — the same rain now floods far worse. Mumbai's multiplier, encoded in the model.",
        "amber", 6500);
    });
  }
  if (s.finished && !tour.done.has("finish")) {
    return void fire("finish", 4000, () => {
      map.flyTo(state.meta.area.center, state.meta.area.zoom, { duration: 1.6 });
      $("engine-card").hidden = true; $("engine-prob").hidden = true; state.focusSeg = null;
      const k = s.kpis;
      showLT("REPLAY COMPLETE",
        k.alerts_sent === 0
          ? "Zero street alerts — the correct output for this day. No healthy street buzzed a phone, and the blocked drain was still caught."
          : `${k.alerts_sent} streets warned early · ${k.people_warned.toLocaleString("en-IN")} people · avg ${k.avg_lead_min}-minute head start · ${k.drains_flagged} drain${k.drains_flagged === 1 ? "" : "s"} diagnosed.`,
        "teal", 10000);
      setTimeout(endTour, 10500);
    });
  }
}

/* live alert toasts — the same lower-third, outside the tour */
function notifyAlert(a) {
  const s = state.snap;
  if (tour.on || !s || !state.running) return;
  if (a.minute < s.minute - 15) return;              // stale on reconnect
  if (a.kind === "street") {
    showLT(`STREET ALERT · T−${a.lead_min} MIN · ${a.subscribers} SUBSCRIBERS · WHATSAPP + IVR`,
      a.text[state.lang] || a.text.en, "red");
  } else if (a.kind === "dispatch") {
    showLT(`WARD DISPATCH · CAUSE B · ${a.meta && a.meta.drain_id ? a.meta.drain_id : "DRAIN"}`,
      a.text.en, "amber", 6200);
  }
}

function renderAll() {
  if (!state.snap || !state.meta) return;
  renderTop();
  if (state.mode === "replay") renderMap();
  renderEngineCard();
  renderChart();
  renderFeed();
  if (tour.on) tourTick();
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

function syncUrl(extra = {}) {
  // the address bar mirrors the loaded pairing — refresh keeps context,
  // and one-shot params (autoplay/tour/watch) never re-fire on reload
  if (!state.meta) return;
  const q = new URLSearchParams();
  q.set("area", state.meta.active_area);
  q.set("storm", extra.storm || state.meta.active_storm);
  if (extra.live) q.set("live", "1");
  history.replaceState(null, "", `/app?${q.toString()}`);
}

function clearLocalRun() {
  state.renderedFeed.clear();
  state.feedUnseen = 0;
  $("feed-badge").hidden = true;
  $("feed").innerHTML = "";
  $("engine-card").hidden = true;
  state.focusSeg = null;
}

$("btn-play").onclick = () => { if (tour.on) endTour(); control({ action: state.running ? "pause" : "start" }); };
$("btn-tour").onclick = () => (tour.on ? endTour() : startTour());
$("btn-reset").onclick = async () => { if (tour.on) endTour(); clearLocalRun(); await control({ action: "reset" }); };

// the bucket-dunk, without the bucket: D streams a rising ultrasonic
// reading through the REAL /api/sensor path while a storm runs — the
// node flips to LIVE HARDWARE and observed depth climbs on the sensor
// street. Stage insurance for the hardware moment.
let dunkBusy = false;
async function sensorDunk() {
  if (dunkBusy || !state.meta) return;
  if (state.mode !== "replay" || !state.running) {
    showLT("HARDWARE NODE", "Run a storm first — the dunk streams into the live replay.", "amber", 3600);
    return;
  }
  dunkBusy = true;
  const seg = state.meta.area.sensor_seg;
  const row = currentRow(seg);
  showLT("HARDWARE NODE · LIVE", `Ultrasonic level node reporting from ${row ? row.name : seg} — depth rising.`, "teal", 6400);
  for (const d of [4, 9, 16, 24, 31, 36]) {
    await fetch("/api/sensor", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segment: seg, depth_cm: d }),
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1100));
  }
  dunkBusy = false;
}

// stage shortcuts — hands stay off the trackpad mid-pitch
document.addEventListener("keydown", (e) => {
  if (e.target !== document.body || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " ") { e.preventDefault(); $("btn-play").click(); }
  else if (e.key === "t" || e.key === "T") $("btn-tour").click();
  else if (e.key === "r" || e.key === "R") $("btn-reset").click();
  else if (e.key === "?") $("keys-card").hidden = !$("keys-card").hidden;
  else if (e.key === "Escape") $("keys-card").hidden = true;
  else if (e.key === "d" || e.key === "D") sensorDunk();
  else if (e.key === "s" || e.key === "S") sndToggle();
  else if (e.key === "e" || e.key === "E") {
    if (state.mode !== "live") document.querySelector('[data-tab="live"]').click();
    setTimeout(() => $("earth-pill").click(), state.mode === "live" ? 0 : 700);
  }
});

$("copy-link").onclick = async () => {
  const el = $("copy-link");
  try {
    await navigator.clipboard.writeText(location.href);
    el.textContent = "✓ COPIED";
  } catch {
    el.textContent = location.host + location.pathname + location.search; // fallback: show it
  }
  el.classList.add("done");
  setTimeout(() => { el.textContent = "⧉ LINK"; el.classList.remove("done"); }, 1600);
};
$("storm-sel").onchange = async (e) => { clearLocalRun(); await control({ action: "load", storm: e.target.value }); syncUrl({ storm: e.target.value, live: state.mode === "live" ? 1 : 0 }); };
$("area-sel").onchange = async (e) => {
  clearLocalRun();
  clearWatchSel();
  await control({ action: "load", area: e.target.value });
  await refreshMeta();
  syncUrl({ live: state.mode === "live" ? 1 : 0 });
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

function cloudPill() {
  const el = $("cloud-toggle");
  el.textContent = { sat: "Clouds · satellite", subtle: "Clouds · subtle", off: "Clouds · off" }[state.cloudMode];
  el.classList.toggle("on", state.cloudMode !== "off");
}

$("earth-pill").onclick = () => {
  const sw = $("stormwatch");
  sw.scrollIntoView({ behavior: "smooth", block: "start" });
  sw.classList.remove("flash"); void sw.offsetWidth; sw.classList.add("flash");
};
$("cloud-toggle").onclick = () => {
  state.cloudMode = state.cloudMode === "sat" ? "subtle" : state.cloudMode === "subtle" ? "off" : "sat";
  cloudPill();
  updateClouds();
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
/* Deep links (the landing page speaks them):
     /app?storm=monsoon-2005&area=kurla   load a pairing
     /app?autoplay=1                      press ▶ for the visitor
     /app?live=1                          open straight into LIVE CITY
     /app?tour=1                          run the guided tour           */

(async () => {
  const q = new URLSearchParams(location.search);
  const storm = q.get("storm"), area = q.get("area");
  if (storm || area) {
    const body = { action: "load" };
    if (storm) body.storm = storm;
    if (area) body.area = area;
    await control(body).catch(() => {});
  }
  await refreshMeta();
  connect();
  const s = await fetchJsonRetry("/api/state");
  state.snap = s; renderAll();
  fx.canvas = $("rain-fx");
  fx.ctx = fx.canvas.getContext("2d");
  requestAnimationFrame(fxLoop);
  bindRainHover();
  bindLiveHover();
  pollLive();                                  // warm the live cache early
  const watchQ = q.get("watch");
  if (watchQ) {                                // ?watch=1 → wettest city on Earth
    state.pendingWatch = watchQ === "1" ? "__top__" : watchQ;
    document.querySelector('[data-tab="live"]').click();
  }
  else if (q.get("live") === "1") document.querySelector('[data-tab="live"]').click();
  else if (q.get("tour") === "1") startTour();
  else if (q.get("autoplay") === "1") {
    if (s.finished) { clearLocalRun(); await control({ action: "reset" }); }
    control({ action: "start" });
  }
  if (!watchQ) syncUrl({ live: q.get("live") === "1" ? 1 : 0 });
})();
