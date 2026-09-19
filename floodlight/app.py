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

from .engine.livefeed import LiveMCGMFeed, live_mode_enabled
from .engine.replay import STORMS, StormReplay
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

    def reset(self, storm_id: str | None = None) -> None:
        self.running = False
        self.replay.reset(storm_id)
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


@app.get("/")
async def index() -> FileResponse:
    # The shell must never be cached against a newer app.js/style.css.
    return FileResponse(STATIC / "index.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/api/meta")
async def meta() -> JSONResponse:
    return JSONResponse({
        "segments_geojson": json.loads((DATA / "ward_segments.geojson").read_text(encoding="utf-8")),
        "drains": hub.replay.drain_points,
        "storms": [{"id": k, "label": v["label"]} for k, v in STORMS.items()],
        "active_storm": hub.replay.storm_id,
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
        hub.reset(body.get("storm", "cloudburst"))
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
