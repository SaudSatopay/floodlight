"""FLOODLIGHT server — FastAPI app that hosts the ward dashboard, streams
the storm to every client over SSE, ingests live reports (dashboard +
WhatsApp webhook) and hardware sensor readings, and fans alerts out
through the WhatsApp outbox.

Run:  python run.py             → replay mode, http://localhost:8737
      FLOODLIGHT_MODE=live …    → live-city mode (see engine/livefeed.py)
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import time as _time

from .engine.hydrology import step_depth_cm, waterlog_probability
from .engine.hydrology import Segment
from .engine.livefeed import (WATCH_CITIES, LiveMCGMFeed, fetch_metno,
                              fetch_metno_many, fetch_open_meteo,
                              fetch_open_meteo_grid, fetch_open_meteo_region,
                              fetch_open_meteo_watch, live_mode_enabled,
                              mumbai_grid, stormwatch_assess, summarize_outlook,
                              wmo_label, tide_estimate)
from .engine.replay import (AREAS, COVERAGE_RADIUS_M, STORMS, StormReplay,
                            estimate_risk_at, live_risk_at,
                            nearest_street_all_areas)
from .engine.whatsapp import Outbox, guess_depth_cm, parse_messages, verify_token

STATIC = Path(__file__).resolve().parent / "static"
DATA = Path(__file__).resolve().parent / "data"

TICK_SECONDS = 2.4          # real seconds per 15-min window at 1× (replay)
LIVE_WINDOW_S = float(os.environ.get("LIVE_WINDOW_S", "900"))

# Pilot subscriber stub for outbound WhatsApp fan-out (production: real DB).
SUBSCRIBER_STUB = [n for n in os.environ.get("ALERT_NUMBERS", "").split(",") if n]


class Hub:
    """Fan-out of state snapshots to every open SSE connection."""

    def __init__(self) -> None:
        self.replay = StormReplay()
        self.clients: set[asyncio.Queue] = set()
        self.running = False
        self.speed = 1.0
        self.outbox = Outbox()
        self._task: asyncio.Task | None = None
        self._alerted_ids: set[str] = set()
        self.live_degraded = False

    # ------------------------------------------------------------- plumbing

    def stamped(self, snapshot: dict) -> dict:
        snapshot["running"] = self.running and not self.replay.finished
        snapshot["mode"] = "live" if live_mode_enabled() else "replay"
        snapshot["live_degraded"] = self.live_degraded
        snapshot["outbox"] = {"mode": "live" if self.outbox.live else "sim",
                              "sent": len(self.outbox.log)}
        snapshot["storms"] = [{"id": k, "label": v["label"]} for k, v in STORMS.items()]
        snapshot["areas"] = [{"id": k, "label": v["label"]} for k, v in AREAS.items()]
        return snapshot

    async def broadcast(self, payload: dict) -> None:
        for q in list(self.clients):
            if q.qsize() < 50:
                q.put_nowait(payload)

    async def _fan_out_new_alerts(self) -> None:
        for a in self.replay.alerts:
            if a.kind == "street" and a.id not in self._alerted_ids:
                self._alerted_ids.add(a.id)
                await self.outbox.broadcast_alert(
                    a.__dict__, SUBSCRIBER_STUB or [f"sub-{a.segment_id}"])

    # ---------------------------------------------------------- replay mode

    async def _loop(self) -> None:
        while self.running and not self.replay.finished:
            snapshot = self.replay.tick()
            await self._fan_out_new_alerts()
            await self.broadcast(self.stamped(snapshot))
            await asyncio.sleep(TICK_SECONDS / self.speed)
        self.running = False
        await self.broadcast(self.stamped(self.replay.snapshot()))

    def start(self) -> None:
        if not self.running and not self.replay.finished:
            # a paused/reset loop may still be mid-sleep — if it woke to find
            # running=True again it would tick alongside the new loop (2×
            # speed). Cancel it before spawning the replacement.
            if self._task and not self._task.done():
                self._task.cancel()
            self.running = True
            self._task = asyncio.get_event_loop().create_task(self._loop())

    def pause(self) -> None:
        self.running = False

    def reset(self, storm_id: str | None = None, area_id: str | None = None) -> None:
        self.running = False
        self.replay.reset(storm_id, area_id)
        self._alerted_ids.clear()

    # ------------------------------------------------------------ live mode

    async def live_loop(self) -> None:
        """Live-city ticker: extend the storm series from the live feed and
        run the identical pipeline. The replay file IS the interface."""
        feed = LiveMCGMFeed()
        self.running = True
        while True:
            window = await feed.window()
            self.live_degraded = window.degraded
            self.replay.storm["rain_mm"].append(window.rain_mm)
            self.replay.storm["tide_m"].append(window.tide_m)
            snapshot = self.replay.tick()
            await self._fan_out_new_alerts()
            await self.broadcast(self.stamped(snapshot))
            await asyncio.sleep(LIVE_WINDOW_S)


hub = Hub()


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = None
    if live_mode_enabled():
        task = asyncio.get_event_loop().create_task(hub.live_loop())
    warm = asyncio.get_event_loop().create_task(_watch_warm_loop())
    yield
    hub.pause()
    warm.cancel()
    if task:
        task.cancel()


app = FastAPI(title="FLOODLIGHT", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/healthz")
async def healthz() -> JSONResponse:
    """Deploy health probe (Render/Railway point here)."""
    return JSONResponse({"ok": True, "service": "floodlight",
                         "storm": hub.replay.storm_id, "finished": hub.replay.finished,
                         "watch_coverage": f"{len(_watch_rows)}/{len(WATCH_CITIES)}"})


@app.get("/")
async def landing() -> FileResponse:
    # The pitch page. The instrument itself lives at /app.
    return FileResponse(STATIC / "landing.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/app")
async def index() -> FileResponse:
    # The shell must never be cached against a newer app.js/style.css.
    return FileResponse(STATIC / "index.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})


_landing_cache: dict = {}


@app.get("/api/landing")
async def landing_data() -> JSONResponse:
    """Fixed payload for the landing hero: Hindmata's real street geometry +
    the real 08 July 2026 storm curve — deterministic, independent of
    whatever area/storm the live replay is currently holding."""
    if not _landing_cache:
        area_dir = DATA / "areas" / "hindmata"
        _landing_cache["payload"] = {
            "geojson": json.loads((area_dir / "segments.geojson").read_text(encoding="utf-8")),
            "drains": json.loads((area_dir / "drains.json").read_text(encoding="utf-8"))["drains"],
            "storm": json.loads((DATA / "storm_replay.json").read_text(encoding="utf-8")),
        }
    return JSONResponse(_landing_cache["payload"])


@app.get("/api/meta")
async def meta() -> JSONResponse:
    area = AREAS[hub.replay.area_id]
    return JSONResponse({
        "segments_geojson": hub.replay.geojson,
        "drains": hub.replay.drain_points,
        "storms": [{"id": k, "label": v["label"]} for k, v in STORMS.items()],
        "areas": [{"id": k, "label": v["label"]} for k, v in AREAS.items()],
        "active_storm": hub.replay.storm_id,
        "active_area": hub.replay.area_id,
        "area": {"label": area["label"], "center": area["center"], "zoom": area["zoom"],
                 "sensor_seg": hub.replay.sensor_seg},
        "storm": {
            "name": hub.replay.storm["name"],
            "start_clock": hub.replay.storm["start_clock"],
            "windows": len(hub.replay.storm["rain_mm"]),
            "rain_mm": hub.replay.storm["rain_mm"],
            "tide_m": hub.replay.storm["tide_m"],
        },
    })


@app.get("/api/state")
async def state() -> JSONResponse:
    return JSONResponse(hub.stamped(hub.replay.snapshot()))


@app.post("/api/control")
async def control(req: Request) -> JSONResponse:
    body = await req.json()
    action = body.get("action")
    if action == "start":
        hub.start()
    elif action == "pause":
        hub.pause()
    elif action == "reset":
        hub.reset()
        await hub.broadcast(hub.stamped(hub.replay.snapshot()))
    elif action == "load":
        hub.reset(body.get("storm"), body.get("area"))
        await hub.broadcast(hub.stamped(hub.replay.snapshot()))
    elif action == "seek":
        # jump the replay to a storm window — the chart is a scrubber
        step = int(body.get("step", 0))
        was_running = hub.running
        hub.reset()
        n = len(hub.replay.storm["rain_mm"])
        for _ in range(max(0, min(step + 1, n))):
            hub.replay.tick()
        await hub._fan_out_new_alerts()
        if was_running and not hub.replay.finished:
            hub.start()
        await hub.broadcast(hub.stamped(hub.replay.snapshot()))
    elif action == "speed":
        hub.speed = max(0.5, min(6.0, float(body.get("speed", 1.0))))
    return JSONResponse({"ok": True, "running": hub.running, "speed": hub.speed,
                         "storm": hub.replay.storm_id})


@app.post("/api/report")
async def report(req: Request) -> JSONResponse:
    """A live citizen report filed from the dashboard's report composer."""
    body = await req.json()
    rep = hub.replay.inject_report(
        segment_id=body["segment"],
        depth_cm=float(body["depth_cm"]),
        text=body.get("text", ""),
        source="dashboard",
    )
    return JSONResponse({"ok": True, "queued_for_minute": rep["minute"]})


@app.post("/api/sensor")
async def sensor(req: Request) -> JSONResponse:
    """Hardware level-node ingest (ESP32 + ultrasonic → this endpoint)."""
    body = await req.json()
    hub.replay.set_sensor(body.get("segment", "amb-02"), float(body["depth_cm"]))
    return JSONResponse({"ok": True})


_live_cache: dict = {"ts": 0.0, "payload": None}
_live_last_good: dict = {}      # area_label → (wall_ts, payload) — stale-while-error
_pt_met_cache: dict = {}


def _serve_stale(last_good: tuple | None, payload_if_none: dict) -> dict:
    """A feed hiccup must never blank the demo: serve the last GOOD payload,
    honestly stamped as stale, and only fall back to the zero baseline when
    we have never once succeeded."""
    if not last_good:
        return payload_if_none
    ts, good = last_good
    out = dict(good)
    out["stale_min"] = max(1, int((_time.time() - ts) / 60))
    return out


@app.get("/api/diag")
async def diag() -> JSONResponse:
    """Field diagnostics: one tiny upstream call, the REAL error out —
    because 'degraded' on a venue network needs a cause, not a shrug."""
    import platform, ssl, sys
    loop = asyncio.get_running_loop()

    def probe() -> dict:
        t0 = _time.time()
        try:
            r = fetch_open_meteo(19.076, 72.877)
            return {"ok": True, "ms": int((_time.time() - t0) * 1000),
                    "rain_now": r["now"], "time": r["time"]}
        except Exception as e:
            return {"ok": False, "ms": int((_time.time() - t0) * 1000),
                    "error": f"{type(e).__name__}: {e}"[:400]}

    def probe_metno() -> dict:
        t0 = _time.time()
        try:
            r = fetch_metno(19.076, 72.877)
            return {"ok": True, "ms": int((_time.time() - t0) * 1000),
                    "now": r["now"]}
        except Exception as e:
            return {"ok": False, "ms": int((_time.time() - t0) * 1000),
                    "error": f"{type(e).__name__}: {e}"[:300]}

    def probe_metno_sweep() -> dict:
        from .engine import livefeed as lf
        t0 = _time.time()
        try:
            rows = fetch_metno_many([(19.076, 72.877), (13.083, 80.270), (-6.208, 106.846)])
            return {"ok": sum(1 for r in rows if not r.get("dead")),
                    "dead": sum(1 for r in rows if r.get("dead")),
                    "ms": int((_time.time() - t0) * 1000),
                    "last_err": lf.METNO_LAST_ERROR}
        except Exception as e:
            return {"ok": 0, "ms": int((_time.time() - t0) * 1000),
                    "error": f"{type(e).__name__}: {e}"[:200],
                    "last_err": lf.METNO_LAST_ERROR}

    out = await loop.run_in_executor(None, probe)
    out["metno"] = await loop.run_in_executor(None, probe_metno)
    out["metno_sweep3"] = await loop.run_in_executor(None, probe_metno_sweep)
    from .engine import livefeed as _lf
    out["metno_last_error"] = _lf.METNO_LAST_ERROR
    out["python"] = sys.version.split()[0]
    out["openssl"] = ssl.OPENSSL_VERSION
    out["platform"] = platform.platform()
    return JSONResponse(out)


def _point_met(lat: float, lng: float) -> dict:
    """Rain + terrain elevation for an arbitrary tapped point, cached on a
    ~1 km grid for 10 min — powers tap-anywhere estimates off-corridor."""
    key = (round(lat, 2), round(lng, 2))
    now = _time.time()
    hit = _pt_met_cache.get(key)
    if hit and now - hit[0] < 600:
        return hit[1]
    try:
        m = fetch_open_meteo(lat, lng)
    except Exception:
        m = fetch_metno(lat, lng)          # elevation None → land unknown
    _pt_met_cache[key] = (now, m)
    return m


@app.get("/api/live")
async def live_city() -> JSONResponse:
    """LIVE CITY view: real 15-minutely rainfall (Open-Meteo, keyless) for
    the active area, run through the same hydrology to shade the ward —
    honestly labelled where a value is estimated."""
    now = _time.time()
    area = AREAS[hub.replay.area_id]
    if (_live_cache["payload"] and now - _live_cache["ts"] < 60
            and _live_cache["payload"]["area_label"] == area["label"]):
        return JSONResponse(_live_cache["payload"])
    lat, lng = area["center"]
    degraded, met, fallback = False, None, None
    loop = asyncio.get_running_loop()
    try:
        met = await loop.run_in_executor(None, fetch_open_meteo, lat, lng)
    except Exception:
        try:
            met = await loop.run_in_executor(None, fetch_metno, lat, lng)
            fallback = "metno"
        except Exception:
            degraded = True
            met = {"past": [0.0] * 12, "now": 0.0, "next": [0.0] * 8, "time": "",
                   "cloud_now": 0, "code_now": 0, "hours": []}

    tide = tide_estimate()
    # Stateless shading: run the past 3 h through the expected model with
    # healthy drains — what today's real rain SHOULD be doing per street.
    seg_rows = []
    for sid, seg in hub.replay.segments.items():
        drain = hub.replay.drains[seg.drain_id]
        depth = 0.0
        for mm in met["past"] + [met["now"]]:
            depth = step_depth_cm(depth, mm, tide, seg, drain.capacity_mm, 0.05)
        state = "alert" if depth >= seg.alert_cm else "watch" if depth >= seg.watch_cm else "ok"
        seg_rows.append({"id": sid, "name": seg.name, "state": state,
                         "expected_cm": round(depth, 1)})

    heat = []
    try:
        heat = await loop.run_in_executor(None, fetch_open_meteo_grid, mumbai_grid())
    except Exception:
        pass

    payload = {
        "updated": met["time"],
        "source": ("met.no · hourly forecast (fallback — no past rain)"
                   if fallback else "open-meteo.com · 15-minutely"),
        "fallback": fallback,
        "degraded": degraded,
        "rain_now": round(met["now"], 2),
        "past": [round(v, 2) for v in met["past"]],
        "next": [round(v, 2) for v in met["next"]],
        "past_3h_total": round(sum(met["past"]) + met["now"], 1),
        "tide_est": tide,
        "area_label": area["label"],
        "segments": seg_rows,
        "heat": heat,
        # the sky right now + the next 12 hours — so a black-cloud afternoon
        # shows up BEFORE the first drop reaches a rain gauge
        "sky": {"cloud_now": met.get("cloud_now", 0),
                "code_now": met.get("code_now", 0),
                "label": wmo_label(met.get("code_now", 0))},
        "outlook": {"hours": met.get("hours", []),
                    "summary": summarize_outlook(met["now"], met.get("cloud_now", 0),
                                                 met.get("hours", []))},
    }
    if degraded:
        stale = _serve_stale(_live_last_good.get(area["label"]), payload)
        _live_cache.update(ts=now - 45, payload=stale)      # retry soon
        return JSONResponse(stale)
    _live_last_good[area["label"]] = (now, payload)
    _live_cache.update(ts=now, payload=payload)
    return JSONResponse(payload)


def _area_probe(area_id: str) -> tuple[Segment, float]:
    """The area's most bowl-shaped street + its drain capacity (cached) —
    a cheap regional risk proxy."""
    if not hasattr(_area_probe, "cache"):
        _area_probe.cache = {}
    if area_id not in _area_probe.cache:
        d = AREAS[area_id]["dir"]
        geo = json.loads((d / "segments.geojson").read_text(encoding="utf-8"))
        drains = json.loads((d / "drains.json").read_text(encoding="utf-8"))["drains"]
        f = max(geo["features"], key=lambda x: x["properties"]["bowl"])
        p = f["properties"]
        seg = Segment(id=p["id"], name=p["name"], bowl=p["bowl"],
                      drain_id=p["drain_id"], subscribers=p["subscribers"])
        cap = next((x["capacity_mm"] for x in drains if x["id"] == seg.drain_id), 22)
        _area_probe.cache[area_id] = (seg, cap)
    return _area_probe.cache[area_id]


_region_cache: dict = {"ts": 0.0, "payload": None}
_region_last_good: dict = {}
_region_met: dict = {}          # raw per-corridor rain rows — reused by tap-risk


@app.get("/api/region")
async def region() -> JSONResponse:
    """MMR coverage strip: every pilot corridor's REAL rain right now and
    the risk it implies on that corridor's worst street."""
    now = _time.time()
    if _region_cache["payload"] and now - _region_cache["ts"] < 120:
        return JSONResponse(_region_cache["payload"])

    ids = list(AREAS.keys())
    centers = [tuple(AREAS[a]["center"]) for a in ids]
    loop = asyncio.get_running_loop()
    degraded, met, fallback = False, None, None
    try:
        met = await loop.run_in_executor(None, fetch_open_meteo_region, centers)
    except Exception:
        try:
            met = await loop.run_in_executor(None, fetch_metno_many, centers)
            fallback = "metno"
        except Exception:
            degraded = True
            met = [{"past": [0.0] * 12, "now": 0.0, "next": [], "next6_mm": 0.0,
                    "fc_hours": []} for _ in ids]

    tide = tide_estimate()
    rows = []
    for aid, m in zip(ids, met):
        if not degraded:
            _region_met[aid] = {"past": m["past"], "now": m["now"],
                                "next": list(m.get("next", []))}
        seg, cap = _area_probe(aid)
        depth = 0.0
        for mm in m["past"] + [m["now"]] + list(m.get("next", []))[:4]:
            depth = step_depth_cm(depth, mm, tide, seg, cap, 0.05)
        p = waterlog_probability(depth)
        # projected risk: keep integrating through the next-6-h FORECAST
        # (each hour split into four 15-min windows) — this is what lets the
        # strip say "34% now → 78% by evening" while the sky is still dry
        proj = depth
        for mm_h in m.get("fc_hours", []):
            for _ in range(4):
                proj = step_depth_cm(proj, mm_h / 4.0, tide, seg, cap, 0.05)
        p2 = max(p, waterlog_probability(proj))
        rows.append({
            "id": aid, "label": AREAS[aid]["label"], "center": AREAS[aid]["center"],
            "rain_now": round(m["now"], 2), "past_3h": round(sum(m["past"]), 1),
            "next6_mm": round(m.get("next6_mm", 0.0), 1),
            "cloud": m.get("cloud", 0),
            "risk_pct": round(p * 100),
            "risk_next_pct": round(p2 * 100),
            "tier": "HIGH" if p >= 0.6 else "MODERATE" if p >= 0.3 else "LOW",
            "tier_next": "HIGH" if p2 >= 0.6 else "MODERATE" if p2 >= 0.3 else "LOW",
        })
    payload = {"updated": _time.strftime("%H:%M"), "degraded": degraded,
               "src": fallback, "tide_est": tide, "areas": rows}
    if degraded:
        stale = _serve_stale(_region_last_good.get("mmr"), payload)
        _region_cache.update(ts=now - 60, payload=stale)
        return JSONResponse(stale)
    _region_last_good["mmr"] = (now, payload)
    _region_cache.update(ts=now, payload=payload)
    return JSONResponse(payload)


_watch_cache: dict = {"ts": 0.0, "payload": None, "full_primary": False}
_watch_last_good: dict = {}
_watch_rows: dict = {}            # cid → assessed row (+_ts) — incremental table
_watch_state: dict = {"cursor": 0}


async def _stormwatch_payload() -> dict:
    """STORM WATCH · EARTH — rank flood-famous cities worldwide by what the
    engine reads in their real rain right now. Primary: ONE batched
    Open-Meteo call. When that IP-throttles (shared-egress hosts arrive
    pre-throttled), the sweep goes INCREMENTAL: a rotating met.no chunk per
    call merges into a persistent table, so coverage builds and is never
    all-or-nothing. Rows carry their age; the payload says its coverage.
    Called by the route AND by the warm loop, cache-guarded either way."""
    import datetime as _dt
    now = _time.time()
    total = len(WATCH_CITIES)
    fresh = _watch_cache["payload"] and now - _watch_cache["ts"] < (
        600 if (_watch_cache.get("full_primary") and len(_watch_rows) >= total) else 75)
    if fresh:
        return _watch_cache["payload"]
    loop = asyncio.get_running_loop()
    utc = _dt.datetime.utcnow()

    def build_row(c, m):
        cid, city, cc, lat, lng = c
        a = stormwatch_assess(m["past"], m["now"], m["fc_hours"], m["next6_mm"])
        off = m.get("utc_offset_s")
        local = None if off is None else utc + _dt.timedelta(seconds=off)
        return {"id": cid, "city": city, "cc": cc, "lat": lat, "lng": lng,
                "rain_now": round(m["now"], 2), "past_3h": round(sum(m["past"]), 1),
                "next6_mm": m["next6_mm"], "cloud": m["cloud"],
                "sky": wmo_label(m["code"]),
                "local": "—" if local is None else local.strftime("%H:%M"),
                "_ts": now, **a}

    src, full_primary = None, False
    try:
        met = await loop.run_in_executor(
            None, fetch_open_meteo_watch, [(c[3], c[4]) for c in WATCH_CITIES])
        for c, m in zip(WATCH_CITIES, met):
            if not m.get("dead"):
                _watch_rows[c[0]] = build_row(c, m)
        full_primary = True
    except Exception:
        k = 9
        start_i = _watch_state["cursor"] % total
        chunk = [WATCH_CITIES[(start_i + i) % total] for i in range(k)]
        _watch_state["cursor"] = (start_i + k) % total
        try:
            met = await loop.run_in_executor(
                None, fetch_metno_many, [(c[3], c[4]) for c in chunk])
            src = "metno"
            for c, m in zip(chunk, met):
                if not m.get("dead"):
                    _watch_rows[c[0]] = build_row(c, m)
        except Exception:
            src = "metno"          # chunk lost — keep serving the table

    if not _watch_rows:
        payload = {"updated": _time.strftime("%H:%M"), "degraded": True,
                   "cities": [], "coverage_n": 0, "coverage_total": total}
        stale = _serve_stale(_watch_last_good.get("earth"), payload)
        _watch_cache.update(ts=now - 30, payload=stale, full_primary=False)
        return stale

    rows = []
    for r in _watch_rows.values():
        r2 = {k2: v for k2, v in r.items() if k2 != "_ts"}
        r2["age_min"] = int((now - r["_ts"]) / 60)
        rows.append(r2)
    rows.sort(key=lambda r: (r["risk_next_pct"], r["score"]), reverse=True)
    payload = {"updated": _time.strftime("%H:%M"), "degraded": False,
               "src": src,
               "coverage_n": len(rows), "coverage_total": total,
               "tide_note": "tide not modelled outside the MMR — scored neutral",
               "cities": rows}
    _watch_last_good["earth"] = (now, payload)
    _watch_cache.update(ts=now, payload=payload, full_primary=full_primary)
    return payload


@app.get("/api/stormwatch")
async def stormwatch() -> JSONResponse:
    return JSONResponse(await _stormwatch_payload())


async def _watch_warm_loop() -> None:
    """Keep the world scanner full and fresh with no visitor required —
    a judge opening /app?watch=1 cold should meet a warm planet."""
    await asyncio.sleep(15)                      # let the server settle
    while True:
        try:
            p = await _stormwatch_payload()
            full = p.get("coverage_n", 0) >= p.get("coverage_total", 1)
            throttled = bool(p.get("src")) or p.get("degraded")
            wait = 80 if (not full or throttled) else 570
        except Exception:
            wait = 120
        await asyncio.sleep(wait)


@app.get("/api/risk")
async def risk(lat: float, lng: float, mode: str = "replay") -> JSONResponse:
    """Tap-anywhere waterlogging probability, with its drivers."""
    rain_ctx = None
    if mode == "live":
        met = _live_cache["payload"]
        if not met:
            loop = asyncio.get_running_loop()
            try:
                area = AREAS[hub.replay.area_id]
                m = await loop.run_in_executor(None, fetch_open_meteo, *area["center"])
                met = {"past": m["past"] + [m["now"]], "next": m["next"], "tide_est": tide_estimate()}
            except Exception:
                met = {"past": [], "next": [], "tide_est": tide_estimate()}
        rain_ctx = {"past": met["past"], "next": met["next"], "tide": met["tide_est"]}
    result = hub.replay.risk_at(lat, lng, rain_ctx)
    if mode == "live" and result.get("covered") is False:
        # The loaded ward doesn't cover this tap. Tier 2: another pilot
        # corridor might (scored with ITS real rain). Tier 3: any other
        # LAND point gets an honest AREA ESTIMATE from the rain at that
        # exact spot; only open water refuses to invent a number.
        near = nearest_street_all_areas(lat, lng)
        if near["distance_m"] <= COVERAGE_RADIUS_M:
            m2 = _region_met.get(near["area_id"])
            ctx2 = ({"past": m2["past"] + [m2["now"]], "next": m2["next"],
                     "tide": rain_ctx["tide"]} if m2 else rain_ctx)
            result = live_risk_at(lat, lng, ctx2)
        else:
            loop = asyncio.get_running_loop()
            try:
                pm = await loop.run_in_executor(None, _point_met, lat, lng)
            except Exception:
                pm = None
            if pm and (pm.get("elevation") is None or pm["elevation"] > 0.5):
                # far from the MMR the Mumbai tide clock means nothing —
                # score with a neutral tide and say so, never fake a lock
                far = near["distance_m"] > 200_000
                ctx3 = {"past": pm["past"] + [pm["now"]], "next": pm["next"],
                        "tide": 2.0 if far else rain_ctx["tide"]}
                result = estimate_risk_at(lat, lng, ctx3, near,
                                          elevation_m=pm["elevation"])
                if far:
                    result["tide_note"] = "unmodelled"
            else:
                result = {"covered": False, "water": pm is not None, **near}
    result["mode"] = mode
    if mode == "live" and result.get("covered", True):
        cached = _live_cache["payload"]
        if cached and cached.get("outlook"):
            # the popup's physics stay honest (next-hour rain only) — the
            # forecast rides along as its own clearly-labelled line
            result["forecast"] = cached["outlook"]["summary"]
    return JSONResponse(result)


@app.get("/api/outbox")
async def outbox() -> JSONResponse:
    return JSONResponse({"mode": "live" if hub.outbox.live else "sim",
                         "log": list(hub.outbox.log)[-30:]})


# ------------------------------------------------------ WhatsApp Cloud API

@app.get("/webhook/whatsapp")
async def wa_verify(req: Request):
    p = req.query_params
    if p.get("hub.mode") == "subscribe" and p.get("hub.verify_token") == verify_token():
        return PlainTextResponse(p.get("hub.challenge", ""))
    return PlainTextResponse("forbidden", status_code=403)


@app.post("/webhook/whatsapp")
async def wa_inbound(req: Request) -> JSONResponse:
    payload = await req.json()
    accepted = 0
    for m in parse_messages(payload):
        if m["lat"] is not None:
            seg = hub.replay.nearest_segment(m["lat"], m["lng"])
        else:
            seg = hub.replay.script["sensor"]["segment"]
        hub.replay.inject_report(
            segment_id=seg,
            depth_cm=guess_depth_cm(m["text"]),
            text=m["text"], source="whatsapp",
            name=m["name"] or m["wa_from"][-4:].rjust(6, "·"),
        )
        accepted += 1
    return JSONResponse({"ok": True, "accepted": accepted})


@app.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    q: asyncio.Queue = asyncio.Queue()
    hub.clients.add(q)
    q.put_nowait(hub.stamped(hub.replay.snapshot()))

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            hub.clients.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
