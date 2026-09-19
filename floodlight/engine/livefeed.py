"""Live-city adapter — the flag-flip that turns the replay into the city.

``StormReplay`` consumes a rain/tide series shaped like ``storm_replay.json``.
This module produces the same shape from live sources, so nothing else in
the pipeline changes:

    FLOODLIGHT_MODE=live \
    MCGM_RAIN_URL=<json endpoint> python run.py

MCGM's disaster-management portal (dm.mcgm.gov.in) publishes AWS station
rainfall the city already collects every 15 minutes, but offers no
*documented* public API — endpoints observed in the portal's own network
traffic have shifted between monsoons. The poller therefore takes its URL
and field mapping from the environment, and degrades gracefully: when the
feed is unreachable it emits zero-rain windows and flags itself DEGRADED
rather than inventing weather.
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.request
from dataclasses import dataclass, field


@dataclass
class LiveWindow:
    rain_mm: float
    tide_m: float
    degraded: bool = False


@dataclass
class LiveMCGMFeed:
    """Polls a rainfall endpoint and yields 15-minute windows.

    Field mapping is configured by env so a changed portal schema is a
    config change, not a code change:

      MCGM_RAIN_URL    JSON endpoint returning station readings
      MCGM_RAIN_FIELD  key holding mm-per-15-min (default: "rainfall")
      TIDE_TABLE       comma list of today's tide heights by hour (fallback)
    """

    url: str = field(default_factory=lambda: os.environ.get("MCGM_RAIN_URL", ""))
    rain_field: str = field(default_factory=lambda: os.environ.get("MCGM_RAIN_FIELD", "rainfall"))
    stations: list[str] = field(default_factory=lambda: [
        s for s in os.environ.get("MCGM_STATIONS", "Parel,Dadar").split(",") if s
    ])

    def _fetch(self) -> float | None:
        if not self.url:
            return None
        req = urllib.request.Request(self.url, headers={"User-Agent": "floodlight-node/0.2"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        rows = data if isinstance(data, list) else data.get("data", data.get("result", []))
        vals = []
        for row in rows:
            name = str(row.get("station", row.get("name", "")))
            if self.stations and not any(s.lower() in name.lower() for s in self.stations):
                continue
            try:
                vals.append(float(row.get(self.rain_field, 0) or 0))
            except (TypeError, ValueError):
                continue
        return max(vals) if vals else None

    def _tide_now(self) -> float:
        import datetime
        table = os.environ.get("TIDE_TABLE", "")
        if table:
            hours = [float(x) for x in table.split(",")]
            return hours[datetime.datetime.now().hour % len(hours)]
        return 2.5                                          # neutral fallback

    async def window(self) -> LiveWindow:
        loop = asyncio.get_running_loop()
        try:
            rain = await loop.run_in_executor(None, self._fetch)
            if rain is None:
                return LiveWindow(0.0, self._tide_now(), degraded=True)
            return LiveWindow(rain, self._tide_now())
        except Exception:
            return LiveWindow(0.0, self._tide_now(), degraded=True)


def live_mode_enabled() -> bool:
    return os.environ.get("FLOODLIGHT_MODE", "replay").lower() == "live"


# --------------------------------------------------------------------------
# Open-Meteo: genuinely live rainfall, no key, 15-minutely — the default
# source for the dashboard's LIVE CITY view.
# --------------------------------------------------------------------------

def fetch_open_meteo(lat: float, lng: float) -> dict:
    """Past 3 h + next 2 h of 15-minutely precipitation for a point.

    Returns {"past": [12 × mm], "now": mm, "next": [8 × mm], "time": iso}.
    Raises on network failure — callers decide how to degrade.
    """
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lat:.4f}&longitude={lng:.4f}"
           "&minutely_15=precipitation&past_minutely_15=12&forecast_minutely_15=9"
           "&timezone=Asia%2FKolkata")
    req = urllib.request.Request(url, headers={"User-Agent": "floodlight/0.3"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    vals = [float(v or 0) for v in data["minutely_15"]["precipitation"]]
    times = data["minutely_15"]["time"]
    return {"past": vals[:12], "now": vals[12] if len(vals) > 12 else 0.0,
            "next": vals[13:], "time": times[12] if len(times) > 12 else ""}


def fetch_open_meteo_grid(points: list[tuple[float, float]]) -> list[dict]:
    """Current precipitation for MANY points in one call (Open-Meteo accepts
    comma-separated coordinate lists) — feeds the live rain heatmap."""
    lats = ",".join(f"{p[0]:.3f}" for p in points)
    lngs = ",".join(f"{p[1]:.3f}" for p in points)
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={lats}&longitude={lngs}"
           "&current=precipitation&timezone=Asia%2FKolkata")
    req = urllib.request.Request(url, headers={"User-Agent": "floodlight/0.4"})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.load(r)
    rows = data if isinstance(data, list) else [data]
    out = []
    for p, row in zip(points, rows):
        mm = float(row.get("current", {}).get("precipitation", 0) or 0)
        out.append({"lat": p[0], "lng": p[1], "mm": mm})
    return out


def mumbai_grid() -> list[tuple[float, float]]:
    """A coarse grid over Greater Mumbai for the live rain heatmap."""
    pts = []
    lat0, lat1, lng0, lng1 = 18.90, 19.30, 72.78, 73.00
    for i in range(6):
        for j in range(5):
            pts.append((round(lat0 + (lat1 - lat0) * i / 5, 3),
                        round(lng0 + (lng1 - lng0) * j / 4, 3)))
    return pts


def tide_estimate() -> float:
    """Approximate semidiurnal tide for Mumbai (labelled EST in the UI) —
    a 12.4 h cycle between ~1.2 m and ~4.4 m. Good enough to show the
    outfall-lock concept live; production reads the port tide table."""
    import datetime, math
    now = datetime.datetime.now()
    hours = now.hour + now.minute / 60.0
    phase = (hours % 12.42) / 12.42 * 2 * math.pi
    return round(2.8 + 1.6 * math.sin(phase), 1)
