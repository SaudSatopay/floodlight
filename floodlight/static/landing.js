/* FLOODLIGHT landing — no framework, no build step.
   The hero replays the real 08 July 2026 rain/tide curve over Hindmata's
   real street geometry (served by /api/landing), with a simplified visual
   hydrology: streets swell, the blocked drain gets caught, alerts pop.
   The LIVE NOW grid is the real /api/region feed — the same numbers the
   instrument shows. */

const $ = (id) => document.getElementById(id);
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------- scroll choreography */

(() => {
  const rise = $("rise");
  let ticking = false;
  addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      rise.style.width = `${max > 0 ? (h.scrollTop / max) * 100 : 0}%`;
      ticking = false;
    });
  }, { passive: true });

  // reveal-on-scroll for band children; hero copy reveals on load
  const stagger = (els) => els.forEach((el, i) => {
    el.classList.add("rv");
    el.style.transitionDelay = `${Math.min(i * 80, 400)}ms`;
  });
  document.querySelectorAll(".band").forEach((band) =>
    stagger([...band.children]));
  const heroKids = [...document.querySelector(".hero-copy").children,
                    document.querySelector(".hero-stats")];
  stagger(heroKids);

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
      if (e.target.classList.contains("cause-grid")) {
        e.target.querySelectorAll(".cb-fill").forEach((f) =>
          (f.style.width = `${f.dataset.w}%`));
      }
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  document.querySelectorAll(".rv").forEach((el) => io.observe(el));
  requestAnimationFrame(() => heroKids.forEach((el) => el.classList.add("in")));
})();

/* ------------------------------------------------------ hero ward sim */

const COL = { ok: "#45577d", watch: "#ffb43b", alert: "#ff5546", blocked: "#ffb43b" };
const CASING = "#040711";
const BLOCKED_ID = "parel-tank-rd";
const WINDOW_S = 2.35;      // real seconds per 15-min storm window
const HOLD_S = 3.2;         // linger on the outcome
const FADE_S = 1.7;         // ease back to calm, then loop

const sim = {
  canvas: null, ctx: null, chipLayer: null,
  W: 0, H: 0, dpr: 1,
  segs: [], drains: [], storm: null,
  t: 0, last: 0, flash: 0, flashedAt: -1,
  drops: [[], []],
  running: true,
};

// On a wide stage the N–S corridor is a thin vertical noodle lost in dark
// space — so lay it DIAGONALLY (rotate, then fit) and seat it in a faint
// brass instrument bezel. The north tick on the bezel shows the rotation
// honestly; the geometry itself stays real.
const HERO_ROT = -0.99;                       // ~-57°, landscape stages only

function project(features, drains, W, H) {
  let latMin = 90, latMax = -90, lngMin = 180, lngMax = -180;
  const eat = (lat, lng) => {
    latMin = Math.min(latMin, lat); latMax = Math.max(latMax, lat);
    lngMin = Math.min(lngMin, lng); lngMax = Math.max(lngMax, lng);
  };
  for (const f of features) for (const [lng, lat] of f.geometry.coordinates) eat(lat, lng);
  for (const d of drains) eat(d.lat, d.lng);
  const kx = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  const rot = W / H >= 1.05 ? HERO_ROT : 0;
  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const raw = (lat, lng) => {
    const x = (lng - lngMin) * kx, y = (latMax - lat);
    return [x * cosR - y * sinR, x * sinR + y * cosR];
  };
  // bbox of the rotated shape
  let xMin = 1e9, xMax = -1e9, yMin = 1e9, yMax = -1e9;
  const eat2 = ([x, y]) => {
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
  };
  for (const f of features) for (const [lng, lat] of f.geometry.coordinates) eat2(raw(lat, lng));
  for (const d of drains) eat2(raw(d.lat, d.lng));
  const mx = (xMin + xMax) / 2, my = (yMin + yMax) / 2;
  // seat the ward inside the bezel: centre right-of-middle (the stage's
  // left edge fades under the headline), ring sized to the free space
  const cx = rot ? W * 0.585 : W * 0.5, cy = H * 0.5;
  const ringR = Math.min(cx, W - cx, cy, H - cy) * 0.94;
  const s = (ringR - 26) / (0.5 * Math.hypot(xMax - xMin, yMax - yMin));
  sim.bezel = { cx, cy, r: ringR, north: -Math.PI / 2 + rot };
  return (lat, lng) => {
    const [x, y] = raw(lat, lng);
    return [cx + (x - mx) * s, cy + (y - my) * s];
  };
}

function drawBezel(ctx) {
  const b = sim.bezel;
  if (!b) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(138, 106, 44, 0.4)";               // outer, brass
  ctx.beginPath(); ctx.arc(b.cx, b.cy, b.r, 0, 2 * Math.PI); ctx.stroke();
  ctx.strokeStyle = "rgba(43, 61, 99, 0.55)";                // inner, hairline
  ctx.beginPath(); ctx.arc(b.cx, b.cy, b.r * 0.9, 0, 2 * Math.PI); ctx.stroke();
  for (let i = 0; i < 24; i++) {                             // tick marks
    const a = (i * Math.PI) / 12;
    const major = i % 3 === 0;
    const r1 = b.r - (major ? 11 : 6);
    ctx.strokeStyle = `rgba(138, 106, 44, ${major ? 0.45 : 0.28})`;
    ctx.beginPath();
    ctx.moveTo(b.cx + Math.cos(a) * r1, b.cy + Math.sin(a) * r1);
    ctx.lineTo(b.cx + Math.cos(a) * b.r, b.cy + Math.sin(a) * b.r);
    ctx.stroke();
  }
  // honest north: the tick leans exactly as far as the map was rotated
  ctx.strokeStyle = "rgba(217, 169, 78, 0.75)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(b.cx + Math.cos(b.north) * (b.r - 16), b.cy + Math.sin(b.north) * (b.r - 16));
  ctx.lineTo(b.cx + Math.cos(b.north) * (b.r + 4), b.cy + Math.sin(b.north) * (b.r + 4));
  ctx.stroke();
  ctx.fillStyle = "rgba(217, 169, 78, 0.85)";
  ctx.font = '700 11px "Space Mono", monospace';
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("N", b.cx + Math.cos(b.north) * (b.r - 28), b.cy + Math.sin(b.north) * (b.r - 28));
  ctx.restore();
}

function buildSim(data) {
  sim.storm = data.storm;
  const W = sim.W, H = sim.H;
  const p = project(data.geojson.features, data.drains, W, H);
  sim.segs = data.geojson.features.map((f) => {
    const pts = f.geometry.coordinates.map(([lng, lat]) => p(lat, lng));
    const pr = f.properties;
    return {
      id: pr.id, name: pr.name, bowl: pr.bowl, subs: pr.subscribers,
      pts, mid: pts[Math.floor(pts.length / 2)],
      blocked: pr.id === BLOCKED_ID,
      depth: 0, state: "ok", flagged: false, alerted: false,
    };
  });
  sim.drains = data.drains.map((d) => ({ ...d, xy: p(d.lat, d.lng) }));
}

function sizeCanvas() {
  const c = sim.canvas;
  sim.dpr = Math.min(2, devicePixelRatio || 1);
  sim.W = c.clientWidth; sim.H = c.clientHeight;
  c.width = Math.round(sim.W * sim.dpr);
  c.height = Math.round(sim.H * sim.dpr);
  sim.ctx.setTransform(sim.dpr, 0, 0, sim.dpr, 0, 0);
}

const lerp = (a, b, k) => a + (b - a) * k;

function stormAt(t) {
  const rain = sim.storm.rain_mm, tide = sim.storm.tide_m;
  const n = rain.length;
  const wf = Math.min(n - 0.001, t / WINDOW_S);
  const i = Math.floor(wf), k = wf - i;
  return {
    i,
    rain: lerp(rain[i], rain[Math.min(n - 1, i + 1)], k),
    rainLabel: rain[Math.min(n - 1, Math.round(wf))],
    tide: lerp(tide[i], tide[Math.min(n - 1, i + 1)], k),
    minute: Math.min(n * 15, (t / WINDOW_S) * 15),
  };
}

function stepDepths(w, dt) {
  const lock = Math.max(0, Math.min(1, (w.tide - 3.0) / 1.5));
  for (const s of sim.segs) {
    const cap = s.blocked ? 3 : 20 * (1 - 0.5 * lock);
    // bowl^2.2 staggers the reds: deep bowls drown early, shallow streets
    // hold at watch — the map reads as judgement, not blanket panic
    const gain = s.blocked ? 0.55 : 0.16 * Math.pow(s.bowl, 1.2);
    const inflow = Math.max(0, w.rain - cap) * s.bowl * gain;
    const outflow = (s.blocked ? 0.9 : 1.6) * (1 - 0.75 * lock);
    s.depth = Math.max(0, s.depth + (inflow - outflow) * dt);
    if (s.blocked) {
      if (!s.flagged && s.depth >= 8) { s.flagged = true; dropChip(s, "amber",
        "D-07 · CREW DISPATCHED", "CAUSE B · EVIDENCE ATTACHED"); }
      s.state = s.flagged ? "blocked" : s.depth >= 8 ? "watch" : "ok";
    } else {
      if (!s.alerted && s.depth >= 15 && s.bowl >= 1.15) { s.alerted = true;
        dropChip(s, "red", `⚠ ${shortName(s.name)}`, `T−30 MIN · ${s.subs} PHONES BUZZ`); }
      s.state = s.depth >= 15 ? "alert" : s.depth >= 8 ? "watch" : "ok";
    }
  }
}

function shortName(n) {
  const cut = n.split(" · ");
  return (cut[1] || cut[0]).toUpperCase().slice(0, 22);
}

const chipSpots = [];
function dropChip(seg, tone, main, small) {
  const el = document.createElement("span");
  el.className = `chip ${tone === "amber" ? "amber" : ""}`;
  el.innerHTML = `${main}<small>${small}</small>`;
  // anchor at the street's midpoint, clamped inside the stage, dodging
  // chips already on screen (the Hindmata cluster sits very tight)
  const x = Math.max(90, Math.min(sim.W - 110, seg.mid[0]));
  const yBase = Math.max(56, Math.min(sim.H - 56, seg.mid[1]));
  const cands = [[x, yBase, "up"], [x, yBase, "dn"],
                 [x, yBase - 52, "up"], [x, yBase + 52, "dn"],
                 [x, yBase - 104, "up"], [x, yBase + 104, "dn"]];
  let best = cands[0], bestScore = -1;
  for (const c of cands) {
    const cy = c[2] === "up" ? c[1] - 30 : c[1] + 30;
    let dmin = 1e9;
    for (const s of chipSpots) dmin = Math.min(dmin, Math.hypot(c[0] - s[0], cy - s[1]));
    if (dmin > bestScore) { bestScore = dmin; best = c; }
    if (dmin > 120) { best = c; break; }
  }
  const cy = best[2] === "up" ? best[1] - 30 : best[1] + 30;
  chipSpots.push([best[0], cy]);
  el.style.left = `${(best[0] / sim.W) * 100}%`;
  el.style.top = `${(best[1] / sim.H) * 100}%`;
  if (best[2] === "dn") el.style.transform = "translate(-50%, 30%)";
  sim.chipLayer.appendChild(el);
}
function clearChips() { sim.chipLayer.innerHTML = ""; chipSpots.length = 0; }

function drawFrame(fade) {
  const { ctx, W, H } = sim;
  ctx.clearRect(0, 0, W, H);
  const now = performance.now();
  drawBezel(ctx);

  // streets: casing under, state colour over, marching dashes where water flows
  for (const s of sim.segs) {
    ctx.lineCap = ctx.lineJoin = "round";
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(s.pts[0][0], s.pts[0][1]);
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i][0], s.pts[i][1]);
    };
    const swell = Math.min(2.2, s.depth / 14);
    path();
    ctx.strokeStyle = CASING; ctx.globalAlpha = 0.9;
    ctx.lineWidth = 5.2 + swell; ctx.setLineDash([]); ctx.stroke();

    const col = COL[s.state];
    path();
    ctx.globalAlpha = fade;
    ctx.strokeStyle = s.state === "ok" ? COL.ok : col;
    ctx.lineWidth = (s.state === "ok" ? 2.9 : 3.6) + swell;
    if (s.state === "blocked") { ctx.setLineDash([7, 6]); ctx.lineDashOffset = -(now / 55) % 26; }
    else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (fade > 0.25 && (s.state === "alert" || s.state === "blocked")) {
      path();
      ctx.globalAlpha = 0.75 * fade;
      ctx.strokeStyle = "#dcf3fa";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 11]);
      ctx.lineDashOffset = -(now / 26) % 28;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  // drains — quiet dots; D-07 goes hot when flagged
  const blockedSeg = sim.segs.find((s) => s.blocked);
  for (const d of sim.drains) {
    const hot = d.id === "D-07" && blockedSeg && blockedSeg.flagged;
    ctx.beginPath();
    ctx.arc(d.xy[0], d.xy[1], hot ? 4.5 : 2.6, 0, Math.PI * 2);
    ctx.fillStyle = "#070b16";
    ctx.fill();
    ctx.lineWidth = hot ? 2 : 1.2;
    ctx.strokeStyle = hot ? COL.watch : "#41527a";
    ctx.stroke();
    if (hot) {
      const r = 7 + ((now / 900) % 1) * 16;
      ctx.beginPath();
      ctx.arc(d.xy[0], d.xy[1], r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 180, 59, ${0.5 * (1 - ((now / 900) % 1)) * fade})`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }
}

function drawRain(intensity, dt) {
  const { ctx, W, H } = sim;
  const k = Math.max(0.6, W / 900);          // drop density follows the stage
  const layers = [
    { arr: sim.drops[0], want: intensity * 2.6 * k, spd: 9,  len: 11, a: 0.28, w: 1.1 },
    { arr: sim.drops[1], want: intensity * 2.2 * k, spd: 15, len: 18, a: 0.5,  w: 1.6 },
  ];
  for (const L of layers) {
    while (L.arr.length < L.want) L.arr.push({
      x: Math.random() * (W + 120) - 60, y: Math.random() * -H, j: 0.8 + Math.random() * 0.4 });
    if (L.arr.length > L.want) L.arr.length = Math.floor(L.want);
    if (!L.arr.length) continue;
    ctx.strokeStyle = `rgba(168, 214, 228, ${L.a})`;
    ctx.lineWidth = L.w;
    ctx.beginPath();
    for (const d of L.arr) {
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - L.len * 0.3 * d.j, d.y + L.len * d.j);
      d.x -= L.spd * 0.3 * d.j * dt * 60; d.y += L.spd * d.j * dt * 60;
      if (d.y > H) { d.y = -16 - Math.random() * 60; d.x = Math.random() * (W + 120) - 60; }
    }
    ctx.stroke();
  }
}

function heroLoop(ts) {
  if (!sim.running) { sim.last = 0; return; }
  requestAnimationFrame(heroLoop);
  if (!sim.last) { sim.last = ts; return; }
  const dt = Math.min(0.05, (ts - sim.last) / 1000);
  sim.last = ts;
  sim.t += dt;

  const N = sim.storm.rain_mm.length;
  const RUN = N * WINDOW_S;
  const DUR = RUN + HOLD_S + FADE_S;
  if (sim.t >= DUR) {           // loop
    sim.t = 0;
    for (const s of sim.segs) { s.depth = 0; s.state = "ok"; s.flagged = s.alerted = false; }
    clearChips();
    sim.flashedAt = -1;
    $("chip-layer").style.opacity = 1;
  }

  const running = sim.t < RUN;
  const fading = sim.t >= RUN + HOLD_S;
  const fade = fading ? Math.max(0, 1 - (sim.t - RUN - HOLD_S) / FADE_S) : 1;
  const w = stormAt(Math.min(sim.t, RUN - 0.001));

  if (running) stepDepths(w, dt);
  else for (const s of sim.segs) s.depth = Math.max(0, s.depth - 1.2 * dt);

  // HUD
  const min = running ? w.minute : N * 15;
  const hh = 14 + Math.floor(min / 60), mm = Math.floor(min % 60);
  $("hud-clock").textContent = `${hh}:${String(mm).padStart(2, "0")}`;
  $("hud-rain").textContent = running ? w.rainLabel : sim.storm.rain_mm[N - 1];
  $("hud-tide").textContent = w.tide.toFixed(1);

  drawFrame(fade);
  drawRain(running ? Math.min(30, w.rain * 0.75) * fade : 0, dt);
  if (fading) $("chip-layer").style.opacity = fade;

  // lightning at the cloudburst peak window
  const peakW = sim.storm.rain_mm.indexOf(Math.max(...sim.storm.rain_mm));
  if (running && w.i === peakW && sim.flashedAt !== peakW) {
    sim.flashedAt = peakW; sim.flash = 0.5;
  }
  if (sim.flash > 0.01) {
    sim.ctx.fillStyle = `rgba(244, 236, 221, ${sim.flash * 0.45})`;
    sim.ctx.fillRect(0, 0, sim.W, sim.H);
    sim.flash *= Math.random() < 0.14 ? 1.5 : 0.78;
    if (sim.flash > 0.85) sim.flash = 0.85;
  }
}

async function initHero() {
  sim.canvas = $("ward-canvas");
  sim.chipLayer = $("chip-layer");
  if (!sim.canvas) return;
  sim.ctx = sim.canvas.getContext("2d");
  let data;
  try {
    data = await (await fetch("/api/landing")).json();
  } catch { return; }        // hero degrades to type-only — still a page
  sizeCanvas();
  buildSim(data);

  let rsz;
  addEventListener("resize", () => {
    clearTimeout(rsz);
    rsz = setTimeout(() => { sizeCanvas(); buildSim(data);
      for (const s of sim.segs) s.depth = 0; clearChips(); sim.t = 0; }, 180);
  });

  if (REDUCED) {
    // one honest still: peak of the storm, chips shown, nothing moves
    let t = 0;
    while (t < 7 * WINDOW_S) { stepDepths(stormAt(t), 1 / 30); t += 1 / 30; }
    $("hud-clock").textContent = "15:45";
    $("hud-rain").textContent = sim.storm.rain_mm[6];
    $("hud-tide").textContent = sim.storm.tide_m[6].toFixed(1);
    drawFrame(1);
    return;
  }

  // only animate while the hero is on screen
  const vis = new IntersectionObserver(([e]) => {
    const on = e.isIntersecting && !document.hidden;
    if (on && !sim.running) { sim.running = true; sim.last = 0; requestAnimationFrame(heroLoop); }
    else if (!on) sim.running = false;
  }, { threshold: 0.05 });
  vis.observe(sim.canvas);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) sim.running = false;
    else { sim.running = true; sim.last = 0; requestAnimationFrame(heroLoop); }
  });
  requestAnimationFrame(heroLoop);
}

/* ---------------------------------------------------- LIVE NOW section */

const CORRIDORS = [
  ["hindmata", "Hindmata"], ["andheri-milan", "Milan Subway"],
  ["kings-circle", "King's Circle"], ["kurla", "Kurla"],
  ["mulund", "Mulund"], ["borivali", "Borivali–Dahisar"],
  ["thane", "Thane"], ["mira-road", "Mira Road"],
];

function liveCell(a) {
  const el = document.createElement("a");
  if (!a) { el.className = "lv pending"; el.innerHTML =
    `<span class="lv-risk">—</span><span class="lv-name"></span>
     <span class="lv-sub">CONTACTING FEED…</span>`; return el; }
  const rising = (a.risk_next_pct || 0) - a.risk_pct >= 8;
  el.className = `lv ${a.tier.toLowerCase()}`;
  el.href = `/app?area=${a.id}&live=1`;
  el.innerHTML = `
    <span class="lv-risk">${a.risk_pct}%${rising ? `<span class="lv-next">▲${a.risk_next_pct}%</span>` : ""}</span>
    <span class="lv-name">${a.label.split(" · ")[0]}</span>
    <span class="lv-sub">RAIN ${a.rain_now.toFixed(1)} MM · 3H ${a.past_3h.toFixed(1)} MM${
      a.cloud != null ? ` · CLOUD ${a.cloud}%` : ""}${rising ? ` · +${a.next6_mm} MM FC` : ""}</span>`;
  el.title = `open ${a.label} in LIVE CITY`;
  return el;
}

let liveTries = 0;
async function hydrateLive() {
  const grid = $("live-grid");
  if (!grid) return;
  if (!grid.childElementCount) {
    for (const [, label] of CORRIDORS) {
      const el = liveCell(null);
      el.querySelector(".lv-name").textContent = label;
      grid.appendChild(el);
    }
  }
  try {
    const r = await (await fetch("/api/region")).json();
    if (!r.areas || !r.areas.length) throw new Error("empty");
    grid.innerHTML = "";
    for (const a of [...r.areas].sort((x, y) => y.risk_pct - x.risk_pct))
      grid.appendChild(liveCell(a));
    $("live-stamp").textContent = r.degraded
      ? "LIVE FEED DEGRADED — SHOWING THE ZERO-RAIN BASELINE, NOT LIVE VALUES"
      : `LIVE · UPDATED ${r.updated} IST · TIDE EST ${r.tide_est.toFixed(1)} M · OPEN-METEO, 15-MINUTELY`;
    setTimeout(hydrateLive, 120000);
  } catch {
    liveTries += 1;
    $("live-stamp").textContent = liveTries < 4
      ? "warming up the live feed… (free-tier cold start can take a minute)"
      : "live feed unreachable right now — the instrument shows the same grid inside";
    if (liveTries < 8) setTimeout(hydrateLive, 20000);
  }
}

/* RIGHT NOW ON EARTH — the storm-watch teaser under the live grid */
async function hydrateEarth() {
  const strip = $("earth-strip");
  if (!strip) return;
  let w;
  try {
    w = await (await fetch("/api/stormwatch")).json();
  } catch { setTimeout(hydrateEarth, 30000); return; }
  if (w.degraded || !w.cities || !w.cities.length) { setTimeout(hydrateEarth, 45000); return; }
  const wet = w.cities.filter((c) => c.rain_now >= 0.3);
  const top = (wet.length ? wet : w.cities).slice(0, 3);
  $("earth-cities").innerHTML = top.map((c) =>
    `<b>${c.city}</b> ${c.rain_now >= 0.2 ? `${c.rain_now.toFixed(1)} mm now` : `${c.risk_next_pct}% by +6 h`}`
  ).join(" · ") + ` · scanned ${w.cities.length} cities ${w.updated} IST`;
  strip.hidden = false;
  setTimeout(hydrateEarth, 600000);
}

initHero();
hydrateLive();
hydrateEarth();
