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
  // the storm owns the whole stage: seat the ward in the right zone,
  // clear of the headline scrim, scaled as large as the sheet allows
  const zx0 = rot ? W * 0.46 : W * 0.08, zx1 = W * 0.955;
  const zy0 = H * 0.14, zy1 = H * 0.84;
  const cx = (zx0 + zx1) / 2, cy = (zy0 + zy1) / 2;
  const s = 0.92 * Math.min((zx1 - zx0) / (xMax - xMin || 1),
                            (zy1 - zy0) / (yMax - yMin || 1));
  sim.focus = { cx, cy, r: Math.min(zx1 - zx0, zy1 - zy0) / 2 };
  return (lat, lng) => {
    const [x, y] = raw(lat, lng);
    return [cx + (x - mx) * s, cy + (y - my) * s];
  };
}

/* sea gauge — the tide as a slim column on the sheet's right edge,
   amber past the ~3 m outfall seal */
function drawSeaGauge(ctx) {
  const W = sim.W, H = sim.H;
  const x = W - 26, y0 = H * 0.2, y1 = H * 0.78, h = y1 - y0;
  const tide = sim.tideNow || 0;
  if (tide <= 0.5) return;
  const frac = Math.max(0, Math.min(1, (tide - 1) / 3.5));
  ctx.save();
  ctx.strokeStyle = "rgba(43, 61, 99, 0.6)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  ctx.font = '8px "Space Mono", monospace';
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let m = 1; m <= 4; m++) {
    const ty = y1 - ((m - 1) / 3.5) * h;
    ctx.strokeStyle = m === 3 ? "rgba(255, 180, 59, 0.85)" : "rgba(43, 61, 99, 0.85)";
    ctx.beginPath(); ctx.moveTo(x - (m === 3 ? 9 : 5), ty); ctx.lineTo(x + 4, ty); ctx.stroke();
    ctx.fillStyle = m === 3 ? "rgba(255, 180, 59, 0.8)" : "rgba(131, 127, 110, 0.7)";
    ctx.fillText(`${m}`, x - 13, ty);
  }
  const fy = y1 - frac * h;
  ctx.strokeStyle = tide >= 3 ? "rgba(255, 180, 59, 0.9)" : "rgba(168, 216, 232, 0.75)";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, fy); ctx.stroke();
  ctx.fillStyle = tide >= 3 ? "#ffb43b" : "#a8d8e8";
  ctx.beginPath(); ctx.arc(x, fy, 3.4, 0, 2 * Math.PI); ctx.fill();
  ctx.translate(x + 12, (y0 + y1) / 2);
  ctx.rotate(Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = tide >= 3 ? "rgba(255, 180, 59, 0.85)" : "rgba(131, 127, 110, 0.75)";
  ctx.fillText(tide >= 3 ? "S E A · O U T F A L L S   S E A L E D" : "S E A · T I D E   M", 0, 0);
  ctx.restore();
}

/* drifting monsoon cells — the weather itself as a soft moving layer */
function drawCells(ctx) {
  const b = sim.focus;
  if (!b) return;
  if (!sim.cells) sim.cells = [0, 1, 2, 3].map((i) => ({
    a: (i / 4) * 2 * Math.PI + Math.random(),
    rr: b.r * (0.22 + 0.24 * Math.random()),
    sp: (0.4 + Math.random() * 0.8) * 0.02 * (i % 2 ? 1 : -1),
    R: b.r * (0.34 + 0.18 * Math.random()),
  }));
  const rain = sim.rainNow || 0;
  const base = 0.055 + Math.min(0.115, rain * 0.0042);
  for (const cl of sim.cells) {              // weather over the whole sheet
    if (!REDUCED) cl.a += cl.sp / 60;
    const x = b.cx + Math.cos(cl.a) * cl.rr * 1.5, y = b.cy + Math.sin(cl.a) * cl.rr * 1.4;
    const g = ctx.createRadialGradient(x, y, 0, x, y, cl.R);
    g.addColorStop(0, `rgba(74, 96, 146, ${base})`);
    g.addColorStop(1, "rgba(74, 96, 146, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - cl.R, y - cl.R, cl.R * 2, cl.R * 2);
  }
}

/* the whole stage as a nautical chart sheet: contour lines of the flood
   bowls edge to edge, graticule ticks and drafted margin notes — computed
   once from the street geometry and cached offscreen */
function buildContours() {
  const b = sim.focus;
  if (!b || !sim.segs.length) { sim.contourCanvas = null; return; }
  const R = b.r * 0.9;
  const cell = Math.max(6, Math.round(R / 44));
  const x0 = -cell, y0 = -cell;
  const nx = Math.ceil((sim.W + 2 * cell) / cell) + 1;
  const ny = Math.ceil((sim.H + 2 * cell) / cell) + 1;
  const wells = sim.segs.map((s) => ({ x: s.mid[0], y: s.mid[1], w: (s.bowl - 0.92) * 2.4 }))
    .concat(sim.drains.map((d) => ({ x: d.xy[0], y: d.xy[1], w: 0.55 })));
  const f = (x, y) => {
    const dc = Math.hypot(x - b.cx, y - b.cy) / R;
    let v = dc * dc * 2.0;                       // rim high, basin low
    for (const w of wells) {
      const d2 = ((x - w.x) ** 2 + (y - w.y) ** 2) / (R * R * 0.028);
      v -= w.w * Math.exp(-d2);
    }
    return v;
  };
  const grid = [];
  for (let j = 0; j < ny; j++) {
    const row = [];
    for (let i = 0; i < nx; i++) row.push(f(x0 + i * cell, y0 + j * cell));
    grid.push(row);
  }
  let mn = Infinity, mx = -Infinity;
  for (const row of grid) for (const v of row) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const oc = document.createElement("canvas");
  oc.width = sim.canvas.width; oc.height = sim.canvas.height;
  const c2 = oc.getContext("2d");
  c2.setTransform(sim.dpr, 0, 0, sim.dpr, 0, 0);
  c2.lineCap = "round";
  const LV = 12;
  for (let l = 1; l < LV; l++) {
    const t = mn + ((mx - mn) * l) / LV;
    const major = l % 3 === 0;
    c2.strokeStyle = `rgba(63, 84, 128, ${major ? 0.36 : 0.21})`;
    c2.lineWidth = major ? 1.2 : 1;
    c2.beginPath();
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const x = x0 + i * cell, y = y0 + j * cell;
        const a = grid[j][i], bb = grid[j][i + 1], cc = grid[j + 1][i + 1], dd = grid[j + 1][i];
        let idx = (a > t ? 8 : 0) | (bb > t ? 4 : 0) | (cc > t ? 2 : 0) | (dd > t ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        if (idx > 7 && idx !== 10) idx = 15 - idx;
        const L = (p, q) => (t - p) / (q - p);
        const T = [x + cell * L(a, bb), y], Rt = [x + cell, y + cell * L(bb, cc)],
              B = [x + cell * L(dd, cc), y + cell], Lf = [x, y + cell * L(a, dd)];
        const draw = (p, q) => { c2.moveTo(p[0], p[1]); c2.lineTo(q[0], q[1]); };
        if (idx === 1) draw(Lf, B);
        else if (idx === 2) draw(B, Rt);
        else if (idx === 3) draw(Lf, Rt);
        else if (idx === 4) draw(T, Rt);
        else if (idx === 5) { draw(T, Rt); draw(Lf, B); }
        else if (idx === 6) draw(T, B);
        else if (idx === 7) draw(Lf, T);
        else if (idx === 10) { draw(Lf, T); draw(B, Rt); }
      }
    }
    c2.stroke();
  }

  // graticule — surveyor's crosses on a regular grid, whole sheet
  const g = 96;
  c2.strokeStyle = "rgba(63, 84, 128, 0.26)";
  c2.lineWidth = 1;
  c2.beginPath();
  for (let gy = g / 2; gy < sim.H; gy += g) {
    for (let gx = g / 2; gx < sim.W; gx += g) {
      c2.moveTo(gx - 4, gy); c2.lineTo(gx + 4, gy);
      c2.moveTo(gx, gy - 4); c2.lineTo(gx, gy + 4);
    }
  }
  c2.stroke();

  // drafted margin notes — the sheet says what it is (kept right of the
  // headline scrim so they stay legible)
  const nx0 = sim.W * 0.47;
  c2.fillStyle = "rgba(131, 127, 110, 0.6)";
  c2.font = '9px "Space Mono", monospace';
  c2.textAlign = "left"; c2.textBaseline = "top";
  c2.fillText("1 9 . 0 1 °  N   ·   7 2 . 8 4 °  E", nx0, 102);
  c2.fillText("M M R  C H A R T  ·  W A R D  G / N", nx0, 116);
  c2.textBaseline = "bottom";
  c2.fillText("H I N D M A T A  B A S I N  ·  B O W L  C O N T O U R S", nx0, sim.H - 118);
  sim.contourCanvas = oc;
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
  const x = Math.max(sim.W * 0.47 + 80, Math.min(sim.W - 120, seg.mid[0]));
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
  drawCells(ctx);
  if (sim.contourCanvas) ctx.drawImage(sim.contourCanvas, 0, 0, W, H);
  drawSeaGauge(ctx);

  // flood bloom — the water's heat signature under the street grid
  for (const s of sim.segs) {
    if (s.depth < 4) continue;
    const col = s.state === "alert" ? "255, 85, 70" : "255, 180, 59";
    const rad = 34 + Math.min(96, s.depth * 2.8);
    const a = 0.12 * fade * Math.min(1, s.depth / 20);
    const step = Math.max(1, Math.floor(s.pts.length / 4));
    for (let i = 0; i < s.pts.length; i += step) {
      const [x, y] = s.pts[i];
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(${col}, ${a})`);
      g.addColorStop(1, `rgba(${col}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  }

  // streets: casing under, state colour over, marching dashes where water flows
  for (const s of sim.segs) {
    ctx.lineCap = ctx.lineJoin = "round";
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(s.pts[0][0], s.pts[0][1]);
      for (let i = 1; i < s.pts.length; i++) ctx.lineTo(s.pts[i][0], s.pts[i][1]);
    };
    const swell = Math.min(3, s.depth / 11);
    path();
    ctx.strokeStyle = CASING; ctx.globalAlpha = 0.9;
    ctx.lineWidth = 7.4 + swell * 1.3; ctx.setLineDash([]); ctx.stroke();

    const col = COL[s.state];
    path();
    ctx.globalAlpha = fade;
    ctx.strokeStyle = s.state === "ok" ? COL.ok : col;
    ctx.lineWidth = (s.state === "ok" ? 4.4 : 5.4) + swell;
    if (s.state === "blocked") { ctx.setLineDash([9, 8]); ctx.lineDashOffset = -(now / 55) % 34; }
    else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (fade > 0.25 && (s.state === "alert" || s.state === "blocked")) {
      path();
      ctx.globalAlpha = 0.75 * fade;
      ctx.strokeStyle = "#dcf3fa";
      ctx.lineWidth = 1.7;
      ctx.setLineDash([4, 13]);
      ctx.lineDashOffset = -(now / 26) % 34;
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
  const k = Math.max(0.7, Math.min(2.6, W / 780));   // drop density follows the stage
  const layers = [
    { arr: sim.drops[0], want: intensity * 3.1 * k, spd: 9,  len: 13, a: 0.3,  w: 1.1 },
    { arr: sim.drops[1], want: intensity * 2.6 * k, spd: 15, len: 21, a: 0.55, w: 1.6 },
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
  if (window.__filmActive) { sim.running = false; sim.last = 0; return; }
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
  sim.tideNow = w.tide;
  sim.rainNow = running ? w.rain : 0;

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
  let data = null;
  for (let i = 0; i < 12 && !data; i++) {   // survive a free-tier cold start
    try {
      const r = await fetch("/api/landing");
      if (r.ok) data = await r.json();
    } catch {}
    if (!data) await new Promise((res) => setTimeout(res, 1500));
  }
  if (!data) return;         // hero degrades to type-only — still a page
  sizeCanvas();
  buildSim(data);
  buildContours();
  if (data.storms_all) drawSparks(data.storms_all);

  let rsz;
  addEventListener("resize", () => {
    clearTimeout(rsz);
    rsz = setTimeout(() => { sizeCanvas(); buildSim(data); buildContours();
      for (const s of sim.segs) s.depth = 0; clearChips(); sim.t = 0; }, 180);
  });

  if (REDUCED) {
    // one honest still: peak of the storm, chips shown, nothing moves
    let t = 0;
    while (t < 7 * WINDOW_S) { stepDepths(stormAt(t), 1 / 30); t += 1 / 30; }
    $("hud-clock").textContent = "15:45";
    $("hud-rain").textContent = sim.storm.rain_mm[6];
    $("hud-tide").textContent = sim.storm.tide_m[6].toFixed(1);
    sim.tideNow = sim.storm.tide_m[6];
    sim.rainNow = 0;
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
  if (a.rain_now >= 0.2) el.classList.add("raining");
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
  // the hero CTA names the live city — the planet answers on the button
  // itself; a drying planet takes the badge back off (no stale readings)
  const t0 = top[0], cta = document.querySelector(".cta.ghost");
  if (cta && t0) {
    cta.innerHTML = t0.rain_now >= 0.2
      ? `Where is it flooding right now? → <b class="cta-now">${t0.city} · ${t0.rain_now.toFixed(1)} mm</b>`
      : `Where is it flooding right now? →`;
  }
  setTimeout(hydrateEarth, 600000);
}

/* storm library sparklines — each storm's real curve, in its row */
function drawSparks(storms) {
  // one shared scale — 2005 must TOWER and the quiet day must whisper
  drawSparks.data = storms;
  const gmax = Math.max(...storms.flatMap((st) => st.rain_mm), 1);
  for (const st of storms) {
    const row = document.querySelector(`.storm-row[href*="storm=${st.id}"]`);
    if (!row || row.querySelector(".sr-spark")) continue;
    const cv = document.createElement("canvas");
    cv.className = "sr-spark";
    cv.width = 200; cv.height = 44;
    row.insertBefore(cv, row.querySelector(".sr-desc"));
    const ctx = cv.getContext("2d");
    const peak = st.rain_mm.indexOf(Math.max(...st.rain_mm));
    const bw = 200 / st.rain_mm.length;
    st.rain_mm.forEach((mm, i) => {
      const h = Math.max(1.5, (mm / gmax) * 40);
      ctx.fillStyle = i === peak ? "#ffb43b" : "#3e6e8c";
      ctx.fillRect(i * bw + 2, 42 - h, bw - 4, h);
    });
  }
}

/* nav mirrors the section you are reading */
(() => {
  const links = [...document.querySelectorAll(".nav-links a[href^='#']")];
  if (!links.length) return;
  const byId = Object.fromEntries(links.map((a) => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.remove("here"));
      const a = byId[e.target.id];
      if (a) a.classList.add("here");
    }
  }, { rootMargin: "-38% 0px -55% 0px" });
  ["twist", "pipeline", "live", "storms"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  });
})();

/* the printed numbers wake up like the instrument's odometers */
(function countUps() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const run = (el) => {
    const node = el.childNodes[0];                 // leaves <i> unit suffixes alone
    if (!node || node.nodeType !== 3) return;
    const m = node.textContent.match(/^([^0-9]*)([0-9][0-9,]*)$/);
    if (!m) return;
    const target = parseInt(m[2].replace(/,/g, ""), 10);
    if (!isFinite(target) || target === 0) return;
    const commas = m[2].includes(",");
    const t0 = performance.now(), dur = 640;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      const v = Math.round(target * e);
      node.textContent = m[1] + (commas ? v.toLocaleString("en-IN") : String(v));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      run(en.target);
    }
  }, { threshold: 0.6 });
  document.querySelectorAll(".hs b, .sr-mm").forEach((el) => io.observe(el));
})();

/* the launch film takes the hero on wide screens; the live canvas sim
   stays underneath as the fallback for mobile, reduced-motion, blocked
   autoplay, and any playback error */
function heroFilm() {
  const v = $("hero-film");
  if (!v) return;
  const wide = matchMedia("(min-width: 1101px)").matches;
  const save = navigator.connection && navigator.connection.saveData;
  if (REDUCED || !wide || save) { v.remove(); return; }
  const chips = $("chip-layer"), hudEl = $("storm-hud"), rail = $("film-rail");
  const drop = () => {
    window.__filmActive = false;
    v.remove();
    if (rail) rail.hidden = true;
    if (chips) chips.style.display = "";
    if (hudEl) hudEl.style.display = "";
    if (!sim.running && sim.storm) { sim.running = true; sim.last = 0; requestAnimationFrame(heroLoop); }
  };
  v.hidden = false;
  v.addEventListener("playing", () => {
    window.__filmActive = true;
    if (chips) chips.style.display = "none";
    if (hudEl) hudEl.style.display = "none";
    sim.running = false;
  }, { once: true });
  v.addEventListener("error", drop);
  const lastSrc = v.querySelector("source:last-of-type");
  if (lastSrc) lastSrc.addEventListener("error", drop);   // no playable source
  const guard = setTimeout(() => { if (!window.__filmActive) drop(); }, 6000);
  v.addEventListener("playing", () => clearTimeout(guard), { once: true });

  // hover-scrub: the cursor drags the storm back and forth across 20 s,
  // release and the film rolls on — same grammar as the war room chart
  if (rail && matchMedia("(hover: hover)").matches) {
    const stage = document.querySelector(".hero-stage");
    const fill = $("film-rail-fill"), dot = $("film-rail-dot"), hint = $("film-rail-hint");
    const cl = (x) => Math.max(0, Math.min(0.999, x));
    let scrubbing = false, raf = 0, targetT = 0;
    const D = () => v.duration || 20;
    const setFill = (k) => { fill.style.width = `${k * 100}%`; dot.style.left = `${k * 100}%`; };
    v.addEventListener("timeupdate", () => { if (!scrubbing) setFill(v.currentTime / D()); });
    v.addEventListener("playing", () => { rail.hidden = false; }, { once: true });
    stage.addEventListener("pointerenter", () => {
      if (!window.__filmActive) return;
      scrubbing = true; v.pause();
      hint.textContent = "scrubbing — release to resume";
    });
    stage.addEventListener("pointermove", (e) => {
      if (!scrubbing || !window.__filmActive) return;
      const r = stage.getBoundingClientRect();
      targetT = cl((e.clientX - r.left) / r.width) * D();
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0; v.currentTime = targetT; setFill(targetT / D());
      });
    });
    stage.addEventListener("pointerleave", () => {
      if (!scrubbing) return;
      scrubbing = false;
      hint.textContent = "⟷ hover to scrub the storm";
      if (window.__filmActive) v.play().catch(() => {});
    });
  }

  const p = v.play();
  if (p && p.catch) p.catch(() => {});    // real failures arrive via error/guard
}

initHero();
heroFilm();
hydrateLive();
hydrateEarth();

/* ------------------------------------------------- the monsoon layer */
/* One fixed canvas over the page: sparse drizzle, the odd droplet
   running down the glass, paper boats drifting the section waterlines,
   and every click landing like a raindrop. All of it honest to the
   world of the product; none of it under reduced motion. */
(function monsoon() {
  if (REDUCED) return;
  const cv = $("monsoon");
  if (!cv) return;
  const mx = cv.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  const size = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    mx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();

  /* drizzle */
  const DN = innerWidth < 760 ? 8 : 15;
  const drops = Array.from({ length: DN }, () => ({
    x: Math.random() * 1.2 * W - 0.1 * W, y: 110 + Math.random() * (H - 110),
    s: 240 + Math.random() * 110, l: 12 + Math.random() * 7,
  }));

  /* paper boats on the section waterlines */
  const laneIds = ["twist", "live", "storms"];
  let lanes = [];
  const relane = () => {
    lanes = laneIds.map((id) => {
      const el = document.getElementById(id);
      return el ? el.getBoundingClientRect().top + scrollY - 22 : -1;
    }).filter((y) => y > 0);
  };
  relane();
  const boats = lanes.map((_, i) => ({
    lane: i, x: Math.random() * W, dir: i % 2 ? -1 : 1,
    v: 13 + Math.random() * 9, ph: Math.random() * 6.3,
  }));

  /* glass droplet runs */
  let runs = [], nextRun = performance.now() + 4000;

  /* click ripples */
  let ripples = [];
  addEventListener("pointerdown", (e) => {
    if (e.clientY < 100) return;
    ripples.push({ x: e.clientX, y: e.clientY, t0: performance.now() });
    if (ripples.length > 5) ripples.shift();
  }, { passive: true });

  let rsz2;
  addEventListener("resize", () => { clearTimeout(rsz2); rsz2 = setTimeout(() => { size(); relane(); }, 200); });
  setInterval(relane, 4000);              // layout drifts as media loads

  function boat(x, y, tilt, a) {
    mx.save();
    mx.translate(x, y); mx.rotate(tilt);
    mx.lineWidth = 1.2; mx.lineJoin = "round";
    mx.strokeStyle = `rgba(201, 193, 173, ${a})`;
    mx.beginPath();                        // hull
    mx.moveTo(-15, 0); mx.lineTo(15, 0); mx.lineTo(8, 7); mx.lineTo(-8, 7); mx.closePath();
    mx.stroke();
    mx.beginPath();                        // sails
    mx.moveTo(-2, -1); mx.lineTo(-2, -12); mx.lineTo(-11, -1); mx.closePath();
    mx.moveTo(2, -1); mx.lineTo(2, -14); mx.lineTo(11, -1); mx.closePath();
    mx.stroke();
    mx.strokeStyle = `rgba(217, 169, 78, ${a * 0.9})`;   // brass waterline
    mx.beginPath(); mx.moveTo(-15, 0); mx.lineTo(15, 0); mx.stroke();
    mx.strokeStyle = `rgba(168, 216, 232, ${a * 0.35})`; // reflection
    mx.beginPath(); mx.moveTo(-10, 10); mx.lineTo(-2, 10); mx.moveTo(3, 12); mx.lineTo(9, 12); mx.stroke();
    mx.restore();
  }

  window.__monsoon = { boats, lanes: () => lanes, ripples };   // demo handle
  let last = performance.now();
  function tick(now) {
    requestAnimationFrame(tick);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    mx.clearRect(0, 0, W, H);

    /* drizzle */
    mx.strokeStyle = "rgba(168, 216, 232, 0.13)";
    mx.lineWidth = 1.1;
    mx.beginPath();
    for (const d of drops) {
      mx.moveTo(d.x, d.y); mx.lineTo(d.x - d.l * 0.22, d.y + d.l);
      d.x -= d.s * 0.22 * dt; d.y += d.s * dt;
      if (d.y > H + 20) { d.y = 96 - Math.random() * 40; d.x = Math.random() * 1.2 * W; }
    }
    mx.stroke();

    /* droplet runs down the glass */
    if (now > nextRun && runs.length < 2) {
      runs.push({ x: 60 + Math.random() * (W - 120), y: 130 + Math.random() * H * 0.5, d: 0, v: 26 });
      nextRun = now + 7000 + Math.random() * 6000;
    }
    runs = runs.filter((r) => r.d < 130);
    for (const r of runs) {
      r.v = Math.min(95, r.v + 55 * dt);
      const step = r.v * dt;
      r.y += step; r.d += step;
      r.x += Math.sin(r.y * 0.09) * 0.55;
      const fade = 1 - r.d / 130;
      mx.strokeStyle = `rgba(168, 216, 232, ${0.12 * fade})`;
      mx.lineWidth = 1.6;
      mx.beginPath(); mx.moveTo(r.x, r.y - 13); mx.lineTo(r.x, r.y); mx.stroke();
      mx.fillStyle = `rgba(168, 216, 232, ${0.36 * fade})`;
      mx.beginPath(); mx.arc(r.x, r.y, 1.7, 0, 7); mx.fill();
      mx.fillStyle = `rgba(244, 236, 221, ${0.3 * fade})`;
      mx.beginPath(); mx.arc(r.x - 0.5, r.y - 0.6, 0.5, 0, 7); mx.fill();
    }

    /* boats (not on phones — the lanes need open water) */
    for (const b of (W < 760 ? [] : boats)) {
      const laneY = lanes[b.lane];
      if (!laneY) continue;
      b.x += b.dir * b.v * dt;
      if (b.x > W + 60) b.x = -60;
      if (b.x < -60) b.x = W + 60;
      const y = laneY - scrollY + Math.sin(now / 900 + b.ph) * 3;
      if (y < 90 || y > H + 30) continue;
      boat(b.x, y, Math.sin(now / 1300 + b.ph) * 0.07 * b.dir, 0.5);
    }

    /* click ripples */
    ripples = ripples.filter((p) => now - p.t0 < 700);
    for (const p of ripples) {
      const k = (now - p.t0) / 700;
      mx.lineWidth = 1.4;
      mx.strokeStyle = `rgba(168, 216, 232, ${0.3 * (1 - k)})`;
      mx.beginPath(); mx.arc(p.x, p.y, 8 + k * 46, 0, 7); mx.stroke();
      mx.strokeStyle = `rgba(217, 169, 78, ${0.2 * (1 - k)})`;
      mx.beginPath(); mx.arc(p.x, p.y, 4 + k * 27, 0, 7); mx.stroke();
    }
  }
  requestAnimationFrame(tick);
})();

/* storm rows replay their spark + roll the millimetres on hover */
(function rowReplay() {
  if (REDUCED || !matchMedia("(hover: hover)").matches) return;
  const ease3 = (k) => 1 - Math.pow(1 - Math.min(1, k), 3);
  document.querySelectorAll(".storm-row").forEach((row) => {
    let busy = 0;
    row.addEventListener("mouseenter", () => {
      const now = performance.now();
      if (now - busy < 700) return;
      busy = now;
      const storms = drawSparks.data || [];
      const st = storms.find((x) => row.href.includes(`storm=${x.id}`));
      const cvs = row.querySelector(".sr-spark");
      if (st && cvs) {
        const c2 = cvs.getContext("2d");
        const gmax = Math.max(...storms.flatMap((x) => x.rain_mm), 1);
        const peak = st.rain_mm.indexOf(Math.max(...st.rain_mm));
        const bw = 200 / st.rain_mm.length;
        const t0 = now;
        (function grow(ts) {
          const k = ease3((ts - t0) / 430);
          c2.clearRect(0, 0, 200, 44);
          st.rain_mm.forEach((mm, i) => {
            const kk = ease3(((ts - t0) / 430) * 1.5 - (i / st.rain_mm.length) * 0.5);
            const h = Math.max(1.5, (mm / gmax) * 40 * kk);
            c2.fillStyle = i === peak ? "#ffb43b" : "#3e6e8c";
            c2.fillRect(i * bw + 2, 42 - h, bw - 4, h);
          });
          if (k < 1) requestAnimationFrame(grow);
        })(now);
      }
      const b = row.querySelector(".sr-mm");
      const node = b && b.childNodes[0];
      if (node && node.nodeType === 3) {
        const target = parseInt(node.textContent, 10);
        if (target) {
          const t0n = now;
          (function roll(ts) {
            const k = ease3((ts - t0n) / 380);
            node.textContent = String(Math.round(target * k));
            if (k < 1) requestAnimationFrame(roll);
          })(now);
        }
      }
    });
  });
})();

/* the alert types itself when the receipts come into view */
(function typeAlert() {
  const el = document.querySelector('.wa-bubble p[lang="mr"]');
  if (!el) return;
  const full = el.textContent;
  if (REDUCED) return;
  const tag = document.querySelector(".proof .cause-tag");
  const io = new IntersectionObserver((es) => {
    if (!es[0].isIntersecting) return;
    io.disconnect();
    el.textContent = "";
    const text = document.createTextNode("");
    const caret = document.createElement("span");
    caret.className = "wa-caret";
    el.append(text, caret);
    let i = 0;
    const step = () => {
      i += 1 + (Math.random() < 0.2 ? 1 : 0);
      text.textContent = full.slice(0, i);
      if (i < full.length) setTimeout(step, 16 + Math.random() * 22);
      else {
        setTimeout(() => caret.remove(), 1400);
        if (tag) tag.classList.add("pop-in");
      }
    };
    setTimeout(step, 250);
  }, { threshold: 0.5 });
  io.observe(el);
})();
