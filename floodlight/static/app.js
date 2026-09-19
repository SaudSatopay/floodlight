/* FLOODLIGHT ward war room — client.
   One SSE stream in, one render pass out. No framework, no build step. */

const COLORS = {
  ok: "#33406f", watch: "#ffb020", alert: "#ff6262",
  blocked: "#ffb020", cyan: "#3fd0ff", lav: "#e2afff",
};

const state = {
  meta: null,
  snap: null,
  lang: "mr",
  running: false,
  focusSeg: "amb-02",           // Hindmata by default — the star of the show
  layers: {},                    // segment id → leaflet polyline
  drainMarkers: {},
  renderedFeed: new Set(),
};

/* ---------------------------------------------------------------- map */

const map = L.map("map", {
  zoomControl: false, attributionControl: true, minZoom: 14, maxZoom: 18,
}).setView([19.0135, 72.8447], 15);

L.control.zoom({ position: "bottomright" }).addTo(map);

// Standard OSM tiles, inverted to night mode in CSS (`.dark-tiles`) —
// keyless, so the demo runs anywhere.
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  className: "dark-tiles",
  maxZoom: 19,
}).addTo(map);

/* Cased cartographic strokes — professional GIS rendering, not neon:
   a dark casing under a solid colour fill. Colour is semantics only. */
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
  const swell = Math.min(1.6, depth / 22);          // streets thicken as water rises
  const w = st.core[2] + swell;
  pair.under.setStyle({ color: CASING.color, opacity: CASING.opacity, weight: w + 3.5 });
  pair.core.setStyle({
    color: st.core[0], opacity: st.core[1], weight: w,
    dashArray: st.dash || null,
  });
  const el = pair.core.getElement();
  if (el) el.setAttribute("class", `leaflet-interactive segcore ${st.cls}`);
}

// Leaflet measures its container at construction; flex layout can settle
// later. Re-measure aggressively so the map always fills its pane.
function fixMapSize() { map.invalidateSize({ animate: false }); }
window.addEventListener("resize", fixMapSize);
window.addEventListener("load", () => { fixMapSize(); setTimeout(fixMapSize, 250); setTimeout(fixMapSize, 900); });
setTimeout(fixMapSize, 60);

function popupHtml(row) {
  const obs = row.observed_cm == null ? "—" : row.observed_cm + " cm";
  return `<div class="pop-name">${row.name}</div>
    <div class="pop-row">expected <b>${row.expected_cm} cm</b> · observed <b>${obs}</b></div>
    <div class="pop-row">drain <b>${row.drain}</b> · subscribers <b>${row.subscribers}</b></div>
    <div class="pop-row">state <b>${row.state.toUpperCase()}</b></div>`;
}

async function initMeta() {
  const meta = await (await fetch("/api/meta")).json();
  state.meta = meta;
  document.getElementById("storm-name").textContent = meta.storm.name;

  // Under-glows first (their own pane, beneath every core stroke).
  map.createPane("glow");
  map.getPane("glow").style.zIndex = 398;

  for (const f of meta.segments_geojson.features) {
    const id = f.properties.id;
    const latlngs = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const under = L.polyline(latlngs, {
      pane: "glow", color: "#04060a", opacity: 0.85, weight: 6.5,
      lineCap: "round", lineJoin: "round", interactive: false,
    }).addTo(map);
    const core = L.polyline(latlngs, {
      color: "#3e4a52", opacity: 0.9, weight: 3,
      lineCap: "round", lineJoin: "round", className: "segcore seg-ok",
    }).addTo(map);
    state.layers[id] = { under, core };
    core.on("click", () => { state.focusSeg = id; renderEngineCard(); });
    core.bindPopup(() => {
      const row = currentRow(id);
      return row ? popupHtml(row) : f.properties.name;
    });
  }

  for (const d of meta.drains) {
    state.drainMarkers[d.id] = L.circleMarker([d.lat, d.lng], {
      radius: 3.5, color: "#5c666b", fillColor: "#0b0d0f", fillOpacity: 1, weight: 1.5,
    }).addTo(map).bindTooltip(`${d.id} · ${d.name}`, { direction: "top" });
  }

  // The optional ₹2k ultrasonic node at Hindmata Junction — slow radar pulse.
  L.circleMarker([19.0154, 72.84465], {
    radius: 4.5, color: "#4fc1d4", fillColor: "#4fc1d4", fillOpacity: 0.8, weight: 1.5,
    className: "sensor-dot",
  }).addTo(map).bindTooltip("ultrasonic level sensor · Hindmata Jn", { direction: "top" });

  const sel = document.getElementById("rep-seg");
  for (const f of meta.segments_geojson.features) {
    const o = document.createElement("option");
    o.value = f.properties.id;
    o.textContent = f.properties.name;
    if (f.properties.id === "hindmata-mkt") o.selected = true;
    sel.appendChild(o);
  }
}

/* ------------------------------------------------------------- renders */

function currentRow(id) {
  return state.snap ? state.snap.segments.find((s) => s.id === id) : null;
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

function renderTop() {
  const s = state.snap;
  if (s.running !== undefined && s.running !== state.running) {
    state.running = s.running;
    document.getElementById("btn-play").textContent = s.running ? "❚❚ Pause" : "▶ Run storm";
  }
  document.getElementById("clock").textContent = s.clock;
  document.getElementById("clock-sub").textContent = s.finished
    ? "replay complete"
    : state.running ? `replay · minute ${s.minute}` : "replay paused";
  document.getElementById("rain-now").textContent = s.rain_now;
  document.getElementById("tide-now").textContent = s.tide_now.toFixed(1);
  document.getElementById("tide-lock-bar").style.width = `${s.tide_lock * 100}%`;
  document.getElementById("tide-lock-label").textContent =
    s.tide_lock >= 0.85 ? "OUTFALLS SEALED" : s.tide_lock > 0.3 ? "OUTFALLS CHOKING" : "OUTFALLS OPEN";
  document.getElementById("sb-window").textContent =
    `WINDOW ${String(Math.max(0, s.step + 1)).padStart(2, "0")}/12 · MIN ${s.minute}`;
  document.getElementById("sb-live").textContent =
    s.finished ? "COMPLETE" : state.running ? "RUNNING" : "STANDBY";

  document.getElementById("k-alerts").textContent = s.kpis.alerts_sent;
  document.getElementById("k-people").textContent = s.kpis.people_warned.toLocaleString("en-IN");
  document.getElementById("k-lead").innerHTML = `${s.kpis.avg_lead_min}<small> min</small>`;
  document.getElementById("k-drains").textContent = s.kpis.drains_flagged;
}

function renderEngineCard() {
  const row = currentRow(state.focusSeg);
  if (!row) return;
  const exp = row.expected_cm, obs = row.observed_cm;
  const scale = 45; // cm that fills the bar
  document.getElementById("engine-seg-name").textContent = row.name;
  document.getElementById("bar-expected").style.width = `${Math.min(100, (exp / scale) * 100)}%`;
  document.getElementById("bar-observed").style.width = obs == null ? "0%" : `${Math.min(100, (obs / scale) * 100)}%`;
  document.getElementById("val-expected").textContent = `${exp.toFixed(1)} cm`;
  document.getElementById("val-observed").textContent = obs == null ? "— cm" : `${obs.toFixed(1)} cm`;

  const delta = obs == null ? 0 : obs - exp;
  document.getElementById("delta-val").textContent = delta.toFixed(1);
  const badge = document.getElementById("verdict-badge");
  badge.className = "badge";
  if (row.state === "blocked") {
    badge.classList.add("causeB");
    badge.textContent = "CAUSE B · BLOCKED DRAIN";
  } else if (Math.max(exp, obs || 0) >= 8) {
    badge.classList.add("causeA");
    badge.textContent = "CAUSE A · RAIN OVERLOAD";
  } else {
    badge.textContent = "NO SIGNIFICANT WATER";
  }
}

function renderChart() {
  const s = state.snap;
  const cv = document.getElementById("rain-chart");
  const ctx = cv.getContext("2d");
  const W = (cv.width = cv.clientWidth * 2);
  const H = (cv.height = 260);
  ctx.clearRect(0, 0, W, H);
  const n = s.rain_full.length;
  const bw = W / n;
  const maxRain = Math.max(...s.rain_full);

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

  // Tide polyline over the bars (right axis, 1.5–5 m).
  ctx.strokeStyle = "#e0a83c";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath();
  state.meta.storm.tide_m.forEach((t, i) => {
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

function renderFeed() {
  const s = state.snap;
  const feed = document.getElementById("feed");
  const items = [];

  for (const r of s.reports) {
    items.push({
      minute: r.minute, key: `r-${r.minute}-${r.segment}-${r.depth_cm}`,
      make: () => {
        const seg = currentRow(r.segment);
        const photo = r.photo ? `<img src="/static/${r.photo}" alt="citizen photo report" />` : "";
        return feedCard("report",
          `CITIZEN REPORT · ${r.source.toUpperCase()} · min ${r.minute}`,
          `<b>${seg ? seg.name : r.segment}</b> · ~${r.depth_cm} cm<br>
           <span class="native">${r.name ? r.name + ": " : ""}${r.text}</span>${photo}`);
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
  const btn = document.getElementById("btn-play");
  btn.textContent = state.running ? "❚❚ Pause" : "▶ Run storm";
}

document.getElementById("btn-play").onclick = () =>
  control({ action: state.running ? "pause" : "start" });
document.getElementById("btn-reset").onclick = async () => {
  state.renderedFeed.clear();
  document.getElementById("feed").innerHTML = "";
  await control({ action: "reset" });
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
    // Re-render alert texts in the new language.
    state.renderedFeed.clear();
    document.getElementById("feed").innerHTML = "";
    renderFeed();
  };
});

const depthInput = document.getElementById("rep-depth");
depthInput.oninput = () =>
  (document.getElementById("rep-depth-val").textContent = `${depthInput.value} cm`);
document.getElementById("rep-send").onclick = async () => {
  await fetch("/api/report", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      segment: document.getElementById("rep-seg").value,
      depth_cm: Number(depthInput.value),
      text: "(filed live from the war-room demo)",
    }),
  });
  const btn = document.getElementById("rep-send");
  btn.textContent = "QUEUED ✓";
  setTimeout(() => (btn.textContent = "SEND"), 1400);
};

/* ---------------------------------------------------------------- boot */

initMeta().then(() => {
  connect();
  fetch("/api/state").then((r) => r.json()).then((s) => { state.snap = s; renderAll(); });
});
