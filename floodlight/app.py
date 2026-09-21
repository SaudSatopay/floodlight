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

from .engine.hydrology import step_depth_cm
from .engine.hydrology import Segment
from .engine.livefeed import (LiveMCGMFeed, fetch_open_meteo, fetch_open_meteo_grid,
                              fetch_open_meteo_region, live_mode_enabled, mumbai_grid,
                              summarize_outlook, wmo_label,
                              tide_estimate)
from .engine.replay import AREAS, STORMS, StormReplay
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
    yield
    hub.pause()
    if task:
        task.cancel()


app = FastAPI(title="FLOODLIGHT", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/healthz")
async def healthz() -> JSONResponse:
    """Deploy health probe (Render/Railway point here)."""
    return JSONResponse({"ok": True, "service": "floodlight",
                         "storm": hub.replay.storm_id, "finished": hub.replay.finished})


@app.get("/")
async def index() -> FileResponse:
    # The shell must never be cached against a newer app.js/style.css.
    return FileResponse(STATIC / "index.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})


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
    degraded, met = False, None
    loop = asyncio.get_running_loop()
    try:
        met = await loop.run_in_executor(None, fetch_open_meteo, lat, lng)
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
        "updated": met["time"], "source": "open-meteo.com · 15-minutely",
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


@app.get("/api/region")
async def region() -> JSONResponse:
    """MMR coverage strip: every pilot corridor's REAL rain right now and
    the risk it implies on that corridor's worst street."""
    import math as _math
    now = _time.time()
    if _region_cache["payload"] and now - _region_cache["ts"] < 120:
        return JSONResponse(_region_cache["payload"])

    ids = list(AREAS.keys())
    centers = [tuple(AREAS[a]["center"]) for a in ids]
    loop = asyncio.get_running_loop()
    degraded, met = False, None
    try:
        met = await loop.run_in_executor(None, fetch_open_meteo_region, centers)
    except Exception:
        degraded = True
        met = [{"past": [0.0] * 12, "now": 0.0, "next": [], "next6_mm": 0.0,
                "fc_hours": []} for _ in ids]

    tide = tide_estimate()
    rows = []
    for aid, m in zip(ids, met):
        seg, cap = _area_probe(aid)
        depth = 0.0
        for mm in m["past"] + [m["now"]] + list(m.get("next", []))[:4]:
            depth = step_depth_cm(depth, mm, tide, seg, cap, 0.05)
        p = 1.0 / (1.0 + _math.exp(-(depth - 12.0) / 6.0))
        p = max(0.02, min(0.97, p))
        # projected risk: keep integrating through the next-6-h FORECAST
        # (each hour split into four 15-min windows) — this is what lets the
        # strip say "34% now → 78% by evening" while the sky is still dry
        proj = depth
        for mm_h in m.get("fc_hours", []):
            for _ in range(4):
                proj = step_depth_cm(proj, mm_h / 4.0, tide, seg, cap, 0.05)
        p2 = 1.0 / (1.0 + _math.exp(-(proj - 12.0) / 6.0))
        p2 = max(p, min(0.97, p2))
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
               "tide_est": tide, "areas": rows}
    _region_cache.update(ts=now, payload=payload)
    return JSONResponse(payload)


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
