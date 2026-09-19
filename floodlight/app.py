"""FLOODLIGHT server — FastAPI app that hosts the ward dashboard and
streams the storm replay to every connected client over SSE.

Run:  python run.py   (then open http://localhost:8737)
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .engine.replay import StormReplay

STATIC = Path(__file__).resolve().parent / "static"
DATA = Path(__file__).resolve().parent / "data"

TICK_SECONDS = 2.4  # real seconds per 15-min storm window at 1× speed


class Hub:
    """Fan-out of state snapshots to every open SSE connection."""

    def __init__(self) -> None:
        self.replay = StormReplay()
        self.clients: set[asyncio.Queue] = set()
        self.running = False
        self.speed = 1.0
        self._task: asyncio.Task | None = None

    async def broadcast(self, payload: dict) -> None:
        for q in list(self.clients):
            if q.qsize() < 50:
                q.put_nowait(payload)

    def stamped(self, snapshot: dict) -> dict:
        snapshot["running"] = self.running and not self.replay.finished
        return snapshot

    async def _loop(self) -> None:
        while self.running and not self.replay.finished:
            snapshot = self.replay.tick()
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

    def reset(self) -> None:
        self.running = False
        self.replay.reset()


hub = Hub()


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    hub.pause()


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
        await hub.broadcast(hub.replay.snapshot())
    elif action == "speed":
        hub.speed = max(0.5, min(6.0, float(body.get("speed", 1.0))))
    return JSONResponse({"ok": True, "running": hub.running, "speed": hub.speed})


@app.post("/api/report")
async def report(req: Request) -> JSONResponse:
    """A live citizen report filed from the dashboard's report composer."""
    body = await req.json()
    rep = hub.replay.inject_report(
        segment_id=body["segment"],
        depth_cm=float(body["depth_cm"]),
        text=body.get("text", ""),
    )
    return JSONResponse({"ok": True, "queued_for_minute": rep["minute"]})


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
